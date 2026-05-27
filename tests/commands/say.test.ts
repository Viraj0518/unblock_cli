import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSay } from '../../src/commands/say.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import { createMockCommsFactory, decodeFrame } from '../_fixtures/mock-comms.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
  await writeCommsEnv({
    natsUrl: 'tls://nats.kaeva.app:39899',
    credsPath: '/some/path/comms-v3.creds',
    workspaceId: 'ws-default',
    orgId: 'org-test',
    chatName: 'Viraj-Alpha',
  });
});
afterEach(async () => {
  await tmp.dispose();
});

describe('runSay', () => {
  it('publishes one envelope to the firehose subject', async () => {
    const { factory, state } = createMockCommsFactory();
    await runSay({ commsFactory: factory, now: () => 1700000000000 }, { msg: 'started X' });
    expect(state.publishedFrames).toHaveLength(1);
    const frame = state.publishedFrames[0];
    expect(frame).toBeDefined();
    if (frame === undefined) return;
    expect(frame.subject).toBe('unblock.chat.ws.ws-default.firehose');
    expect(decodeFrame(frame)).toMatchObject({
      kind: 'say',
      source: 'Viraj-Alpha',
      msg: 'started X',
      ts: 1700000000000,
    });
    expect(state.closed.value).toBe(true);
  });

  it('honors --name override', async () => {
    const { factory, state } = createMockCommsFactory();
    await runSay(
      { commsFactory: factory },
      { msg: 'hi', name: 'override-name' },
    );
    const frame = state.publishedFrames[0];
    expect(frame).toBeDefined();
    if (frame === undefined) return;
    expect(decodeFrame(frame)['source']).toBe('override-name');
  });

  it('throws when no persona configured', async () => {
    // Wipe the env we set in beforeEach.
    process.env['UNBLOCK_HOME'] = `${tmp.home}-missing`;
    const { factory } = createMockCommsFactory();
    await expect(runSay({ commsFactory: factory }, { msg: 'hi' })).rejects.toThrow(/No chat name/);
    process.env['UNBLOCK_HOME'] = tmp.home;
  });

  // ── Regression: Bug B — workspace_id must come from comms-v3.env, not "default" ──
  //
  // Root cause (2026-05-27): the mint-viraj-alpha-creds.py script was writing
  // UNBLOCK_WORKSPACE_ID=default to comms-v3.env while the auth-issuer mints
  // the JWT with pub.allow = ["unblock.chat.ws.<org_slug>.>"].  The CLI then
  // publishes to unblock.chat.ws.default.firehose which does NOT match the
  // JWT's allow-list, so the NATS broker rejects with BAD_CREDS.
  //
  // Fix: derive workspace_id = org slug from org_did at mint time.
  // For ORG_DID="unblock" -> workspace_id="unblock".
  // For ORG_DID="did:web:acme.kaeva.app" -> workspace_id="acme".
  it('regression(Bug B): publishes to workspace slug, not hardcoded "default"', async () => {
    // Simulate what the mint script writes after the Bug B fix:
    // workspace_id = org slug derived from org_did ("unblock" → "unblock").
    // Before the fix it would write workspace_id="default" which caused BAD_CREDS.
    await writeCommsEnv({
      natsUrl: 'tls://nats.kaeva.app:39899',
      credsPath: '/some/path/comms-v3.creds',
      workspaceId: 'unblock',   // ← correct: org slug, NOT "default"
      orgId: 'unblock',
      chatName: 'viraj-alpha',
    });

    const { factory, state } = createMockCommsFactory();
    await runSay({ commsFactory: factory, now: () => 1700000000001 }, { msg: 'test' });

    const frame = state.publishedFrames[0];
    expect(frame).toBeDefined();
    if (frame === undefined) return;

    // JWT pub.allow = ["unblock.chat.ws.unblock.>"] — this subject MUST match.
    expect(frame.subject).toBe('unblock.chat.ws.unblock.firehose');
    // The old, broken subject would have been:
    //   unblock.chat.ws.default.firehose  ← NOT in JWT allow-list → BAD_CREDS
    expect(frame.subject).not.toBe('unblock.chat.ws.default.firehose');
  });

  it('regression(Bug B): --workspaceId CLI flag overrides env workspace', async () => {
    // Callers can override via --workspaceId flag.  Verify that the flag wins
    // over both comms-v3.env and the process.env fallback "default".
    const { factory, state } = createMockCommsFactory();
    await runSay(
      { commsFactory: factory },
      { msg: 'override', workspaceId: 'my-workspace' },
    );
    const frame = state.publishedFrames[0];
    expect(frame).toBeDefined();
    if (frame === undefined) return;
    expect(frame.subject).toBe('unblock.chat.ws.my-workspace.firehose');
  });
});
