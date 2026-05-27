import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runAsk } from '../../src/commands/ask.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import {
  createMockCommsFactory,
  decodeFrame,
  type MockCommsState,
} from '../_fixtures/mock-comms.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';
import { buildEnvelope, chatReplySubject } from '../../src/comms/wire.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
  await writeCommsEnv({
    natsUrl: 'tls://nats.kaeva.app:39899',
    credsPath: '/p',
    workspaceId: 'ws',
    orgId: 'org',
    chatName: 'Viraj-Alpha',
  });
});
afterEach(async () => {
  await tmp.dispose();
});

function deliverReplyAfter(state: MockCommsState, qid: string, msg: string, delayMs = 5): void {
  // Wait until the subscription registers, then deliver the reply.
  const subject = chatReplySubject('ws', qid);
  const interval = setInterval(() => {
    const set = state.subscribers.get(subject);
    if (set !== undefined && set.size > 0) {
      clearInterval(interval);
      const data = buildEnvelope('reply', 'responder', { msg, question_id: qid });
      for (const cb of set) cb({ subject, data });
    }
  }, delayMs);
  // Safety: don't leak.
  setTimeout(() => clearInterval(interval), 5000);
}

describe('runAsk', () => {
  it('returns reply.outcome=reply when a reply arrives in time', async () => {
    const { factory, state } = createMockCommsFactory();
    const qid = 'qid-fixed-1';
    deliverReplyAfter(state, qid, 'delete');
    const result = await runAsk(
      {
        commsFactory: factory,
        now: () => 1700000000000,
        randomUUID: () => qid,
      },
      { question: 'delete?', options: 'delete,keep', timeout: 2, default: 'abort' },
    );
    expect(result.outcome).toBe('reply');
    expect(result.answer).toBe('delete');
    expect(result.questionId).toBe(qid);

    // Published the question (to q.<qid>) and mirrored to firehose.
    const subjects = state.publishedFrames.map((f) => f.subject);
    expect(subjects).toContain('unblock.chat.ws.ws.q.qid-fixed-1');
    expect(subjects).toContain('unblock.chat.ws.ws.firehose');
    const askFrame = state.publishedFrames.find(
      (f) => f.subject === 'unblock.chat.ws.ws.q.qid-fixed-1',
    );
    expect(askFrame).toBeDefined();
    if (askFrame === undefined) return;
    expect(decodeFrame(askFrame)).toMatchObject({
      kind: 'ask',
      msg: 'delete?',
      options: ['delete', 'keep'],
      question_id: qid,
    });
  });

  it('falls back to --default with outcome=timeout', async () => {
    const { factory } = createMockCommsFactory();
    const result = await runAsk(
      { commsFactory: factory, randomUUID: () => 'qid-x' },
      { question: 'q?', timeout: 0.05, default: 'abort' },
    );
    expect(result.outcome).toBe('timeout');
    expect(result.answer).toBe('abort');
  });

  it('throws when no --default and timeout fires', async () => {
    const { factory } = createMockCommsFactory();
    await expect(
      runAsk(
        { commsFactory: factory, randomUUID: () => 'qid-y' },
        { question: 'q?', timeout: 0.05 },
      ),
    ).rejects.toThrow(/timeout/);
  });
});
