import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDm } from '../../src/commands/dm.js';
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

describe('runDm', () => {
  it('publishes to dm subject (lowercased recipient) AND mirrors to firehose', async () => {
    const { factory, state } = createMockCommsFactory();
    await runDm(
      { commsFactory: factory, now: () => 1700000000000 },
      { to: 'haiku-A', msg: 'stop and re-read' },
    );
    expect(state.publishedFrames).toHaveLength(2);
    const subjects = state.publishedFrames.map((f) => f.subject);
    // P0 fix 2026-05-27: NATS subjects are case-sensitive; recipient is
    // canonicalised to lowercase at subject construction so a sender writing
    // `Haiku-A` doesn't silently miss the `haiku-a` listener.
    expect(subjects).toContain('unblock.chat.ws.ws-default.to.haiku-a');
    expect(subjects).toContain('unblock.chat.ws.ws-default.firehose');
    const f0 = state.publishedFrames[0];
    expect(f0).toBeDefined();
    if (f0 === undefined) return;
    expect(decodeFrame(f0)).toMatchObject({
      kind: 'dm',
      source: 'Viraj-Alpha',
      to: 'haiku-A',
      msg: 'stop and re-read',
    });
  });

  // ─── PR-pin: recipient case normalization (lowercase) ───────────────────────
  //
  // Repro of the 2026-05-28 01:24 UTC silent-drop bug:
  //   dm Viraj-Alpha "..."  →  ...to.Viraj-Alpha  (NOT caught by ...to.viraj-alpha listener)
  it('lowercases mixed-case recipient when constructing the DM subject (P0 silent-drop fix)', async () => {
    const { factory, state } = createMockCommsFactory();
    await runDm(
      { commsFactory: factory },
      { to: 'Viraj-Alpha', msg: 'mixed-case probe' },
    );
    const subjects = state.publishedFrames.map((f) => f.subject);
    expect(subjects).toContain('unblock.chat.ws.ws-default.to.viraj-alpha');
    expect(subjects).not.toContain('unblock.chat.ws.ws-default.to.Viraj-Alpha');
  });
});
