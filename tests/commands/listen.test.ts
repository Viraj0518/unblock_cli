import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ListenFilterError,
  ListenJetStreamUnavailableError,
  ListenSinceParseError,
  parseSinceToIso,
  runListen,
} from '../../src/commands/listen.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import { createMockCommsFactory, makeJsFrame } from '../_fixtures/mock-comms.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
  await writeCommsEnv({
    natsUrl: 'tls://nats.kaeva.app:39899',
    credsPath: '/p',
    workspaceId: 'ws-default',
    orgId: 'org',
    chatName: 'Viraj-Alpha',
  });
});
afterEach(async () => {
  await tmp.dispose();
});

// ─── happy path: receives messages and exits on abort ─────────────────────────

describe('runListen happy path', () => {
  it('receives a message and returns received count', async () => {
    const { factory, state } = createMockCommsFactory();

    const ctrl = new AbortController();
    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { json: true },
    );

    // Deliver a message after a tick so the subscribe iterator has started
    const subject = 'unblock.chat.ws.ws-default.to.Viraj-Alpha';
    const payload = JSON.stringify({ kind: 'dm', source: 'other-agent', msg: 'hello' });

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const subs = state.subscribers.get(subject);
    if (subs) {
      const frame = { subject, data: new TextEncoder().encode(payload) };
      for (const cb of subs) cb(frame);
    }

    // Give the listener a tick to process the message before aborting
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    // Abort to end the listen loop
    ctrl.abort();
    const result = await listenPromise;

    expect(result.received).toBeGreaterThanOrEqual(1);
    expect(result.exitReason).toBe('aborted');
  });

  it('exits with timeout reason when timeout elapses', async () => {
    const { factory } = createMockCommsFactory();

    const result = await runListen(
      { commsFactory: factory },
      { timeout: 0.05 }, // 50ms
    );

    expect(result.exitReason).toBe('timeout');
    expect(result.received).toBe(0);
  });
});

// ─── --channel convenience ────────────────────────────────────────────────────

describe('runListen --channel', () => {
  it('subscribes to unblock.channel.<name>.> when --channel given', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { channel: 'announcements' },
    );

    const subject = 'unblock.channel.announcements.>';
    // No subscribers yet means sub was created; test subscribe was registered
    // We just abort immediately
    ctrl.abort();
    await listenPromise;

    // Verify that the subscription was on the channel subject
    expect(state.subscribers.has(subject)).toBe(true);
  });
});

// ─── --filter regex ───────────────────────────────────────────────────────────

describe('runListen --filter', () => {
  it('throws ListenFilterError on invalid regex', async () => {
    const { factory } = createMockCommsFactory();
    await expect(
      runListen(
        { commsFactory: factory },
        { filter: '[[invalid', timeout: 0.01 },
      ),
    ).rejects.toBeInstanceOf(ListenFilterError);
  });

  it('only passes messages matching filter', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { filter: 'MATCH_ME', json: true },
    );

    // Wait for subscription to be established
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const subject = 'unblock.chat.ws.ws-default.to.Viraj-Alpha';

    const deliver = (payload: string): void => {
      const subs = state.subscribers.get(subject);
      if (subs) {
        const frame = { subject, data: new TextEncoder().encode(payload) };
        for (const cb of subs) cb(frame);
      }
    };

    deliver(JSON.stringify({ msg: 'no match' }));
    deliver(JSON.stringify({ msg: 'MATCH_ME content' }));

    // Wait for messages to be processed
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    ctrl.abort();
    const result = await listenPromise;
    expect(result.received).toBe(1);
  });
});

// ─── --help equivalent: constructor / interface validation ────────────────────

describe('runListen interface', () => {
  it('accepts --subject override', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { subject: 'custom.subject.>' },
    );

    ctrl.abort();
    await listenPromise;

    expect(state.subscribers.has('custom.subject.>')).toBe(true);
  });
});

// ─── PR-pin: defensive subscribe on legacy mixed-case chat_name ───────────────
//
// Repro of the 2026-05-28 01:24 UTC silent-drop bug. When the persona's
// `comms-v3.env` has a mixed-case `UNBLOCK_CHAT_NAME` (legacy enrollments
// pre-2026-05-27), updated senders publish to the lowercased subject. The
// listener must subscribe to BOTH the as-loaded form (so backwards-compat
// with un-updated senders still works) AND the lowercased variant (so
// updated senders aren't silently dropped) until the operator re-mints.
describe('runListen defensive subscribe (legacy mixed-case chat_name)', () => {
  it('subscribes to BOTH the as-loaded mixed-case subject AND the lowercased variant', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    // beforeEach() seeded chatName='Viraj-Alpha' (mixed-case).
    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { json: true },
    );

    // Allow subscription registration.
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(state.subscribers.has('unblock.chat.ws.ws-default.to.Viraj-Alpha')).toBe(true);
    expect(state.subscribers.has('unblock.chat.ws.ws-default.to.viraj-alpha')).toBe(true);

    ctrl.abort();
    await listenPromise;
  });

  it('does NOT add the aux lowercased subscription when chat_name is already lowercase', async () => {
    // Replace the seeded env with an all-lowercase chat_name.
    await writeCommsEnv({
      natsUrl: 'tls://nats.kaeva.app:39899',
      credsPath: '/p',
      workspaceId: 'ws-default',
      orgId: 'org',
      chatName: 'viraj-alpha',
    });

    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { json: true },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(state.subscribers.has('unblock.chat.ws.ws-default.to.viraj-alpha')).toBe(true);
    // No mixed-case variant possible to subscribe to, and no double-subscribe
    // to the same lowercase subject either.
    const lowerSubs = state.subscribers.get('unblock.chat.ws.ws-default.to.viraj-alpha');
    expect(lowerSubs?.size).toBe(1);

    ctrl.abort();
    await listenPromise;
  });
});

// ─── Bug 1 (P1): auto-ack on incoming request-reply messages ─────────────────
//
// The 2026-05-28 beta session bug: `unblock send "msg" --ack` always times
// out because `unblock listen` doesn't publish to the sender's _INBOX reply
// subject. The fix: when an incoming frame has `reply` set (NATS request-
// reply), publish a tiny ack envelope to that subject — BEFORE printing.
describe('runListen auto-ack (Bug 1: --ack always-timeout)', () => {
  it('publishes an ack to frame.reply when a message arrives with a reply subject', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { json: true },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const subject = 'unblock.chat.ws.ws-default.to.Viraj-Alpha';
    const inboxSubject = '_INBOX.abc123';
    const messageId = 'msg-xyz';
    const payload = JSON.stringify({
      kind: 'dm',
      source: 'sender',
      message_id: messageId,
      msg: 'ping',
    });

    const subs = state.subscribers.get(subject);
    expect(subs).toBeDefined();
    if (subs) {
      const frame = {
        subject,
        data: new TextEncoder().encode(payload),
        reply: inboxSubject,
      };
      for (const cb of subs) cb(frame);
    }

    // Ack must be published within 100ms of receipt (per brief).
    const ackBy = Date.now() + 100;
    while (Date.now() < ackBy) {
      if (state.publishedFrames.some((f) => f.subject === inboxSubject)) break;
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    const acks = state.publishedFrames.filter((f) => f.subject === inboxSubject);
    expect(acks.length).toBe(1);
    const ackBody = JSON.parse(new TextDecoder().decode(acks[0]!.data)) as Record<string, unknown>;
    expect(ackBody['kind']).toBe('ack');
    expect(ackBody['in_reply_to']).toBe(messageId);
    expect(typeof ackBody['received_at']).toBe('string');

    ctrl.abort();
    await listenPromise;
  });

  it('--no-ack suppresses the ack publish', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { json: true, noAck: true },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const subject = 'unblock.chat.ws.ws-default.to.Viraj-Alpha';
    const inboxSubject = '_INBOX.def456';
    const subs = state.subscribers.get(subject);
    if (subs) {
      const frame = {
        subject,
        data: new TextEncoder().encode(JSON.stringify({ kind: 'dm', message_id: 'x' })),
        reply: inboxSubject,
      };
      for (const cb of subs) cb(frame);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    const acks = state.publishedFrames.filter((f) => f.subject === inboxSubject);
    expect(acks.length).toBe(0);

    ctrl.abort();
    await listenPromise;
  });

  it('falls back to envelope.reply_to when NATS reply subject is absent', async () => {
    // JetStream replay strips NATS request-reply headers, so `unblock send`
    // also embeds `reply_to` in the envelope JSON. Listener must honor it.
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { json: true },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const subject = 'unblock.chat.ws.ws-default.to.Viraj-Alpha';
    const inboxSubject = '_INBOX.via-envelope';
    const payload = JSON.stringify({
      kind: 'dm',
      message_id: 'm1',
      reply_to: inboxSubject,
      msg: 'hi',
    });

    const subs = state.subscribers.get(subject);
    if (subs) {
      const frame = { subject, data: new TextEncoder().encode(payload) }; // no `reply`
      for (const cb of subs) cb(frame);
    }

    // Poll up to 200ms for the ack to land — same pattern as the frame.reply
    // test above, in case the iterator hasn't pumped yet.
    const ackBy = Date.now() + 200;
    while (Date.now() < ackBy) {
      if (state.publishedFrames.some((f) => f.subject === inboxSubject)) break;
      await new Promise<void>((r) => setTimeout(r, 5));
    }

    const acks = state.publishedFrames.filter((f) => f.subject === inboxSubject);
    expect(acks.length).toBe(1);

    ctrl.abort();
    await listenPromise;
  });

  it('does NOT publish an ack when neither frame.reply nor envelope.reply_to is present', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { json: true },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const subject = 'unblock.chat.ws.ws-default.to.Viraj-Alpha';
    const subs = state.subscribers.get(subject);
    if (subs) {
      const frame = {
        subject,
        data: new TextEncoder().encode(JSON.stringify({ kind: 'dm', msg: 'plain' })),
      };
      for (const cb of subs) cb(frame);
    }

    await new Promise<void>((resolve) => setTimeout(resolve, 30));

    // No publishes at all (listener only publishes acks, never the original msg).
    expect(state.publishedFrames.length).toBe(0);

    ctrl.abort();
    await listenPromise;
  });
});

// ─── Bug 2 (issue #9): JetStream replay for offline-while-sent messages ──────
describe('runListen --since', () => {
  it('opens a JetStream consumer with deliver_policy=by_start_time', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { since: '1h', json: true, timeout: 0.05 },
    );

    await listenPromise;

    expect(state.jsConsumeCalls.length).toBe(1);
    const call = state.jsConsumeCalls[0]!;
    expect(call.stream).toBe('UNBLOCK_CHAT');
    expect(call.filterSubject).toBe('unblock.chat.ws.ws-default.to.Viraj-Alpha');
    expect(call.deliverPolicy.kind).toBe('by_start_time');
    if (call.deliverPolicy.kind === 'by_start_time') {
      // Should be roughly an hour ago — ISO-8601 parseable.
      expect(Date.parse(call.deliverPolicy.startTime)).toBeGreaterThan(0);
    }

    ctrl.abort();
  });

  it('accepts an ISO-8601 timestamp directly', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();
    const iso = '2026-05-27T12:00:00.000Z';

    await runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { since: iso, timeout: 0.05 },
    );

    const call = state.jsConsumeCalls[0]!;
    expect(call.deliverPolicy.kind).toBe('by_start_time');
    if (call.deliverPolicy.kind === 'by_start_time') {
      expect(call.deliverPolicy.startTime).toBe(iso);
    }
  });

  it('rejects unparseable --since values with ListenSinceParseError', () => {
    expect(() => parseSinceToIso('not-a-duration')).toThrow(ListenSinceParseError);
    expect(() => parseSinceToIso('1x')).toThrow(ListenSinceParseError);
  });

  it('drains pre-seeded JetStream frames through the listener and acks each one', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const subject = 'unblock.chat.ws.ws-default.to.Viraj-Alpha';
    const f1 = makeJsFrame(subject, { kind: 'dm', message_id: 'r1', msg: 'replay-1' });
    const f2 = makeJsFrame(subject, { kind: 'dm', message_id: 'r2', msg: 'replay-2' });
    state.jsFramesBySubject.set(subject, [f1.frame, f2.frame]);

    const result = await runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { since: '1h', json: true, timeout: 0.1 },
    );

    expect(result.received).toBe(2);
    expect(f1.state.acked).toBe(1);
    expect(f2.state.acked).toBe(1);
  });
});

describe('runListen --replay-all', () => {
  it('opens a JetStream consumer with deliver_policy=all', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    await runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { replayAll: true, timeout: 0.05 },
    );

    expect(state.jsConsumeCalls.length).toBe(1);
    expect(state.jsConsumeCalls[0]!.deliverPolicy.kind).toBe('all');
  });
});

describe('runListen --durable', () => {
  it('passes durableName to the JetStream consumer', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    await runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { durable: 'my-cursor', timeout: 0.05 },
    );

    expect(state.jsConsumeCalls.length).toBe(1);
    expect(state.jsConsumeCalls[0]!.durableName).toBe('my-cursor');
  });

  it('a second runListen call with the same durable name reuses the named consumer', async () => {
    const { factory, state } = createMockCommsFactory();

    await runListen(
      { commsFactory: factory },
      { durable: 'persistent-cursor', timeout: 0.02 },
    );
    await runListen(
      { commsFactory: factory },
      { durable: 'persistent-cursor', timeout: 0.02 },
    );

    expect(state.jsConsumeCalls.length).toBe(2);
    expect(state.jsConsumeCalls[0]!.durableName).toBe('persistent-cursor');
    expect(state.jsConsumeCalls[1]!.durableName).toBe('persistent-cursor');
  });
});

describe('runListen bare (no replay flag)', () => {
  it('uses raw subscribe and never touches JetStream', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const listenPromise = runListen(
      { commsFactory: factory, signal: ctrl.signal },
      { json: true },
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    expect(state.jsConsumeCalls.length).toBe(0);
    expect(state.subscribers.size).toBeGreaterThan(0);

    ctrl.abort();
    await listenPromise;
  });
});

describe('runListen JetStream unavailability', () => {
  it('throws ListenJetStreamUnavailableError when client.jetstream is undefined and a replay flag is set', async () => {
    // Build a factory whose client has no jetstream surface.
    const factoryNoJs = {
      connect: async () => ({
        publish: () => undefined,
        subscribe: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ value: undefined, done: true } as const),
          }),
          unsubscribe: () => undefined,
        }),
        flush: async () => undefined,
        close: async () => undefined,
        // jetstream omitted
      }),
    };

    await expect(
      runListen({ commsFactory: factoryNoJs }, { replayAll: true, timeout: 0.05 }),
    ).rejects.toBeInstanceOf(ListenJetStreamUnavailableError);
  });
});

// Smoke test for the ListenFilterError export (preserves prior import shape).
describe('ListenFilterError exists', () => {
  it('is exported', () => {
    expect(ListenFilterError).toBeDefined();
  });
});
