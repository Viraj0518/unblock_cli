import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSend } from '../../src/commands/send.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import { createMockCommsFactory, decodeFrame } from '../_fixtures/mock-comms.js';
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

// ─── happy path: simple send (no --ack) ───────────────────────────────────────

describe('runSend without --ack', () => {
  it('publishes to dm and firehose with message_id', async () => {
    const { factory, state } = createMockCommsFactory();
    const result = await runSend(
      { commsFactory: factory, now: () => 1700000000000 },
      { to: 'haiku-A', msg: 'unit test', ack: false },
    );

    expect(result.exitCode).toBe(0);
    expect(result.to).toBe('haiku-A');
    expect(result.messageId).toMatch(/^[0-9a-f-]{36}$/);

    const subjects = state.publishedFrames.map((f) => f.subject);
    expect(subjects).toContain('unblock.chat.ws.ws-default.to.haiku-A');
    expect(subjects).toContain('unblock.chat.ws.ws-default.firehose');

    const dmFrame = state.publishedFrames.find((f) => f.subject.includes('.to.haiku-A'));
    expect(dmFrame).toBeDefined();
    if (dmFrame === undefined) return;
    const env = decodeFrame(dmFrame);
    expect(env['message_id']).toBe(result.messageId);
    expect(env['reply_to']).toBeUndefined();
  });
});

// ─── --ack: ack received ────────────────────────────────────────────────────

describe('runSend with --ack (ack received)', () => {
  it('returns ackReceived=true when ack message arrives', async () => {
    const { factory, state } = createMockCommsFactory();

    // We intercept publish so we can replay an ack into the inbox
    const result = await runSend(
      {
        commsFactory: {
          connect: async (options) => {
            const inner = await factory.connect(options);
            const originalPublish = inner.publish.bind(inner);
            return {
              ...inner,
              publish(subject: string, payload: Uint8Array): void {
                originalPublish(subject, payload);
                // If publishing to the DM subject, immediately deliver an ack to inbox
                if (subject.includes('.to.haiku-B')) {
                  const decoded = JSON.parse(new TextDecoder().decode(payload)) as Record<string, unknown>;
                  const msgId = decoded['message_id'] as string;
                  const inboxSubject = `_INBOX.${msgId.replace(/-/g, '')}`;
                  const ackPayload = JSON.stringify({
                    kind: 'ack',
                    source: 'haiku-B',
                    in_reply_to: msgId,
                    ts: Date.now(),
                  });
                  // Deliver to the inbox subscriber directly via state
                  const subs = state.subscribers.get(inboxSubject);
                  if (subs) {
                    const frame = { subject: inboxSubject, data: new TextEncoder().encode(ackPayload) };
                    for (const cb of subs) cb(frame);
                  }
                }
              },
            };
          },
        },
        now: () => 1700000000000,
      },
      { to: 'haiku-B', msg: 'ping', ack: true, timeout: 5 },
    );

    expect(result.exitCode).toBe(0);
    expect(result.ackReceived).toBe(true);
    expect(result.ackSource).toBe('haiku-B');
    expect(result.messageId).toBeTruthy();
  });
});

// ─── --ack: timeout ────────────────────────────────────────────────────────────

describe('runSend with --ack (timeout)', () => {
  it('returns exitCode=2 when no ack arrives in time', async () => {
    const { factory } = createMockCommsFactory();

    const result = await runSend(
      { commsFactory: factory, now: () => 1700000000000 },
      { to: 'ghost-agent', msg: 'hello?', ack: true, timeout: 0.05 }, // 50ms
    );

    expect(result.exitCode).toBe(2);
    expect(result.ackReceived).toBe(false);
  });
});

// ─── --json output shape ──────────────────────────────────────────────────────

describe('runSend --json output shape', () => {
  it('result has all required json keys', async () => {
    const { factory } = createMockCommsFactory();
    const result = await runSend(
      { commsFactory: factory },
      { to: 'target', msg: 'test' },
    );
    expect(result).toHaveProperty('to');
    expect(result).toHaveProperty('messageId');
    expect(result).toHaveProperty('ts');
    expect(result).toHaveProperty('elapsedMs');
    expect(result).toHaveProperty('exitCode');
  });
});
