import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runChatRepl } from '../../src/interactive/chat-repl.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import { createMockCommsFactory, decodeFrame } from '../_fixtures/mock-comms.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
  await writeCommsEnv({
    natsUrl: 'tls://nats.kaeva.app:30640',
    credsPath: '/p',
    workspaceId: 'ws',
    orgId: 'org',
    chatName: 'Viraj-Alpha',
  });
});
afterEach(async () => {
  await tmp.dispose();
});

async function* linesFrom(arr: readonly string[]): AsyncIterable<string> {
  for (const line of arr) yield line;
}

describe('runChatRepl', () => {
  it('publishes broadcast for plain lines, dm for @<who>, reply for /a, and exits on /quit', async () => {
    const { factory, state } = createMockCommsFactory();
    const out: string[] = [];
    const lines = linesFrom([
      'hello world',
      '@codex stop',
      '/a qid-123 yes',
      '/quit',
    ]);
    await runChatRepl({
      commsFactory: factory,
      linesIn: lines,
      out: (line) => out.push(line),
      now: () => 1700000000000,
    });

    // Broadcast (say) on firehose.
    const sayFrame = state.publishedFrames.find(
      (f) => f.subject === 'unblock.chat.ws.ws.firehose' && decodeFrame(f)['kind'] === 'say',
    );
    expect(sayFrame).toBeDefined();
    if (sayFrame !== undefined) {
      expect(decodeFrame(sayFrame)['msg']).toBe('hello world');
    }

    // DM on to.codex AND mirrored to firehose.
    const dmFrame = state.publishedFrames.find(
      (f) => f.subject === 'unblock.chat.ws.ws.to.codex',
    );
    expect(dmFrame).toBeDefined();
    if (dmFrame !== undefined) {
      expect(decodeFrame(dmFrame)).toMatchObject({ kind: 'dm', to: 'codex', msg: 'stop' });
    }

    // Reply on a.<qid> AND mirrored to firehose.
    const replyFrame = state.publishedFrames.find(
      (f) => f.subject === 'unblock.chat.ws.ws.a.qid-123',
    );
    expect(replyFrame).toBeDefined();
    if (replyFrame !== undefined) {
      expect(decodeFrame(replyFrame)).toMatchObject({
        kind: 'reply',
        question_id: 'qid-123',
        msg: 'yes',
      });
    }

    // Closed gracefully.
    expect(state.closed.value).toBe(true);
    expect(out.length).toBeGreaterThan(0);
  });

  it('prints usage for malformed @ and /a lines without crashing', async () => {
    const { factory } = createMockCommsFactory();
    const out: string[] = [];
    await runChatRepl({
      commsFactory: factory,
      linesIn: linesFrom(['@', '/a only-qid', '/quit']),
      out: (line) => out.push(line),
    });
    expect(out.join('\n')).toContain('usage: @<recipient>');
    expect(out.join('\n')).toContain('usage: /a <question_id>');
  });
});
