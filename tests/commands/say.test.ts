import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runSay } from '../../src/commands/say.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import { createMockCommsFactory, decodeFrame } from '../_fixtures/mock-comms.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
  await writeCommsEnv({
    natsUrl: 'tls://nats.kaeva.app:30640',
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
});
