import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDm } from '../../src/commands/dm.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import { createMockCommsFactory, decodeFrame } from '../_fixtures/mock-comms.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
  await writeCommsEnv({
    natsUrl: 'tls://nats.kaeva.app:30640',
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
  it('publishes to dm subject AND mirrors to firehose', async () => {
    const { factory, state } = createMockCommsFactory();
    await runDm(
      { commsFactory: factory, now: () => 1700000000000 },
      { to: 'haiku-A', msg: 'stop and re-read' },
    );
    expect(state.publishedFrames).toHaveLength(2);
    const subjects = state.publishedFrames.map((f) => f.subject);
    expect(subjects).toContain('unblock.chat.ws.ws-default.to.haiku-A');
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
});
