import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runListen, ListenFilterError } from '../../src/commands/listen.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import { createMockCommsFactory } from '../_fixtures/mock-comms.js';
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
