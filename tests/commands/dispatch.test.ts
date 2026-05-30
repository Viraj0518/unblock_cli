import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  runDispatch,
  dispatchSubject,
  dispatchReplySubject,
} from '../../src/commands/dispatch.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import {
  createMockCommsFactory,
  decodeFrame,
  type MockCommsState,
} from '../_fixtures/mock-comms.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

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

// ─── pure subject helpers (mirror resolveSubject / chatQuestionSubject) ───────

describe('dispatch subject helpers', () => {
  it('dispatchSubject builds unblock.coord.dispatch.<asker>.<msgId>', () => {
    expect(dispatchSubject('Viraj-Alpha', 'demo-1')).toBe(
      'unblock.coord.dispatch.Viraj-Alpha.demo-1',
    );
  });

  it('dispatchReplySubject builds unblock.coord.replies.<asker>.<msgId>', () => {
    expect(dispatchReplySubject('Viraj-Alpha', 'demo-1')).toBe(
      'unblock.coord.replies.Viraj-Alpha.demo-1',
    );
  });

  it('preserves asker case verbatim (coord namespace, not the case-sensitive inbox tree)', () => {
    // The coordinator example (live-dispatch-loop.mjs) routes on the asker as
    // given — `Viraj-Alpha`, NOT `viraj-alpha`. The reply_to it publishes back
    // to must match byte-for-byte, so we MUST NOT lowercase here.
    expect(dispatchSubject('Viraj-Alpha', 'm1')).toContain('.Viraj-Alpha.');
    expect(dispatchReplySubject('Viraj-Alpha', 'm1')).toContain('.Viraj-Alpha.');
  });
});

/**
 * Deliver a DispatchReply onto the reply subject once the asker's subscription
 * registers — mirrors ask.test.ts's deliverReplyAfter helper.
 */
function deliverReplyAfter(
  state: MockCommsState,
  replySubject: string,
  reply: Record<string, unknown>,
  delayMs = 5,
): void {
  const interval = setInterval(() => {
    const set = state.subscribers.get(replySubject);
    if (set !== undefined && set.size > 0) {
      clearInterval(interval);
      const data = new TextEncoder().encode(JSON.stringify(reply));
      for (const cb of set) cb({ subject: replySubject, data });
    }
  }, delayMs);
  setTimeout(() => clearInterval(interval), 5000);
}

// ─── publish contract: DispatchEnvelope on the dispatch subject ──────────────

describe('runDispatch publish contract', () => {
  it('subscribes to the reply subject BEFORE publishing the ASK envelope', async () => {
    const { factory, state } = createMockCommsFactory();
    const replySubject = dispatchReplySubject('Viraj-Alpha', 'mid-1');
    // The reply lands as soon as a subscriber exists; if dispatch published
    // before subscribing, this reply would be lost and the call would time out.
    deliverReplyAfter(state, replySubject, {
      kind: 'COMMITTED',
      asker: 'Viraj-Alpha',
      payload_kind: 'code-review-needed',
      strategy: 'claude-code-headless',
      body: 'done',
      ts: 1700000000000,
    });

    const result = await runDispatch(
      { commsFactory: factory, now: () => 1700000000000, randomUUID: () => 'mid-1' },
      {
        payloadKind: 'code-review-needed',
        recipientRole: 'senior',
        content: 'review my PR',
        timeout: 2,
      },
    );

    expect(result.outcome).toBe('COMMITTED');
    expect(result.exitCode).toBe(0);
    expect(result.msgId).toBe('mid-1');
  });

  it('publishes the exact DispatchEnvelope to unblock.coord.dispatch.<asker>.<msgId>', async () => {
    const { factory, state } = createMockCommsFactory();
    const replySubject = dispatchReplySubject('Viraj-Alpha', 'mid-2');
    deliverReplyAfter(state, replySubject, {
      kind: 'COMMITTED',
      asker: 'Viraj-Alpha',
      payload_kind: 'code-review-needed',
      strategy: 'claude-code-headless',
      body: 'ok',
      ts: 1,
    });

    await runDispatch(
      { commsFactory: factory, now: () => 1700000000000, randomUUID: () => 'mid-2' },
      {
        payloadKind: 'code-review-needed',
        recipientRole: 'senior',
        content: 'review my PR',
        timeout: 2,
      },
    );

    const subjects = state.publishedFrames.map((f) => f.subject);
    expect(subjects).toContain('unblock.coord.dispatch.Viraj-Alpha.mid-2');

    const dispatchFrame = state.publishedFrames.find(
      (f) => f.subject === 'unblock.coord.dispatch.Viraj-Alpha.mid-2',
    );
    expect(dispatchFrame).toBeDefined();
    if (dispatchFrame === undefined) return;
    const env = decodeFrame(dispatchFrame);
    expect(env).toMatchObject({
      intent: 'ASK',
      payload_kind: 'code-review-needed',
      recipient_role: 'senior',
      asker: 'Viraj-Alpha',
      content: 'review my PR',
      reply_to: 'unblock.coord.replies.Viraj-Alpha.mid-2',
      msg_id: 'mid-2',
    });
    // No firehose mirror — coordinator dispatch is its own subject tree.
    expect(subjects).not.toContain('unblock.chat.ws.ws.firehose');
    // args omitted when not supplied.
    expect(env['args']).toBeUndefined();
  });

  it('sets intent=DELEGATE when delegate flag is true', async () => {
    const { factory, state } = createMockCommsFactory();
    const replySubject = dispatchReplySubject('Viraj-Alpha', 'mid-3');
    deliverReplyAfter(state, replySubject, {
      kind: 'COMMITTED',
      asker: 'Viraj-Alpha',
      payload_kind: 'shell-task',
      strategy: 'shell-helper',
      body: 'ok',
      ts: 1,
    });

    await runDispatch(
      { commsFactory: factory, now: () => 1700000000000, randomUUID: () => 'mid-3' },
      {
        payloadKind: 'shell-task',
        recipientRole: 'sysops',
        content: 'run the migration',
        delegate: true,
        timeout: 2,
      },
    );

    const dispatchFrame = state.publishedFrames.find(
      (f) => f.subject === 'unblock.coord.dispatch.Viraj-Alpha.mid-3',
    );
    expect(dispatchFrame).toBeDefined();
    if (dispatchFrame === undefined) return;
    expect(decodeFrame(dispatchFrame)['intent']).toBe('DELEGATE');
  });

  it('attaches args object when supplied', async () => {
    const { factory, state } = createMockCommsFactory();
    const replySubject = dispatchReplySubject('Viraj-Alpha', 'mid-4');
    deliverReplyAfter(state, replySubject, {
      kind: 'COMMITTED',
      asker: 'Viraj-Alpha',
      payload_kind: 'shell-task',
      strategy: 'shell-helper',
      body: 'ok',
      ts: 1,
    });

    await runDispatch(
      { commsFactory: factory, now: () => 1700000000000, randomUUID: () => 'mid-4' },
      {
        payloadKind: 'shell-task',
        recipientRole: 'sysops',
        content: 'run it',
        args: { branch: 'main', dry_run: true },
        timeout: 2,
      },
    );

    const dispatchFrame = state.publishedFrames.find(
      (f) => f.subject === 'unblock.coord.dispatch.Viraj-Alpha.mid-4',
    );
    expect(dispatchFrame).toBeDefined();
    if (dispatchFrame === undefined) return;
    expect(decodeFrame(dispatchFrame)['args']).toEqual({ branch: 'main', dry_run: true });
  });
});

// ─── outcome resolution: COMMITTED / REJECT / timeout ────────────────────────

describe('runDispatch outcome resolution', () => {
  it('returns outcome=REJECT exitCode=1 when the coordinator rejects', async () => {
    const { factory, state } = createMockCommsFactory();
    const replySubject = dispatchReplySubject('Viraj-Alpha', 'mid-r');
    deliverReplyAfter(state, replySubject, {
      kind: 'REJECT',
      asker: 'Viraj-Alpha',
      payload_kind: 'unknown-kind',
      strategy: 'none',
      body: 'no matching routing rule',
      ts: 1,
    });

    const result = await runDispatch(
      { commsFactory: factory, now: () => 1700000000000, randomUUID: () => 'mid-r' },
      {
        payloadKind: 'unknown-kind',
        recipientRole: 'nobody',
        content: 'do the impossible',
        timeout: 2,
      },
    );

    expect(result.outcome).toBe('REJECT');
    expect(result.exitCode).toBe(1);
    expect(result.reply?.body).toBe('no matching routing rule');
    expect(result.reply?.strategy).toBe('none');
  });

  it('returns outcome=timeout exitCode=2 when no reply arrives', async () => {
    const { factory } = createMockCommsFactory();
    const result = await runDispatch(
      { commsFactory: factory, now: () => 1700000000000, randomUUID: () => 'mid-t' },
      {
        payloadKind: 'code-review-needed',
        recipientRole: 'senior',
        content: 'ghost ask',
        timeout: 0.05, // 50ms
      },
    );

    expect(result.outcome).toBe('timeout');
    expect(result.exitCode).toBe(2);
    expect(result.reply).toBeUndefined();
  });

  it('surfaces the FYI reply body but still exits 0 (informational, accepted)', async () => {
    const { factory, state } = createMockCommsFactory();
    const replySubject = dispatchReplySubject('Viraj-Alpha', 'mid-f');
    deliverReplyAfter(state, replySubject, {
      kind: 'FYI',
      asker: 'Viraj-Alpha',
      payload_kind: 'human-escalation',
      strategy: 'human-page',
      body: 'paged Viraj',
      ts: 1,
    });

    const result = await runDispatch(
      { commsFactory: factory, now: () => 1700000000000, randomUUID: () => 'mid-f' },
      {
        payloadKind: 'human-escalation',
        recipientRole: 'human',
        content: 'need a human',
        timeout: 2,
      },
    );

    expect(result.outcome).toBe('FYI');
    expect(result.exitCode).toBe(0);
    expect(result.reply?.body).toBe('paged Viraj');
  });

  it('closes the comms client on every path', async () => {
    const { factory, state } = createMockCommsFactory();
    await runDispatch(
      { commsFactory: factory, now: () => 1700000000000, randomUUID: () => 'mid-c' },
      {
        payloadKind: 'code-review-needed',
        recipientRole: 'senior',
        content: 'x',
        timeout: 0.05,
      },
    );
    expect(state.closed.value).toBe(true);
  });
});

// ─── persona precondition ────────────────────────────────────────────────────

describe('runDispatch persona precondition', () => {
  it('throws when no chat name is configured', async () => {
    // Fresh tmp home with no comms-v3.env at all → readCommsEnv returns null →
    // resolveConfig leaves chatName undefined. Mirrors say/dm/ask preconditions.
    await tmp.dispose();
    tmp = await makeTmpHome();
    const { factory } = createMockCommsFactory();
    await expect(
      runDispatch(
        { commsFactory: factory },
        { payloadKind: 'k', recipientRole: 'r', content: 'c', timeout: 0.05 },
      ),
    ).rejects.toThrow(/chat name/i);
  });
});
