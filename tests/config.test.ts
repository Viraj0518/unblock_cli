import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig, DEFAULT_BROKER_URL } from '../src/config.js';
import { writeCommsEnv } from '../src/auth/persona-store.js';
import { makeTmpHome, type TmpHome } from './_fixtures/tmp-home.js';

let tmp: TmpHome;
const ENV_KEYS = ['UNBLOCK_NATS_URL', 'UNBLOCK_AUTH_URL', 'UNBLOCK_WORKSPACE_ID', 'UNBLOCK_CHAT_NAME'];
const prev: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmp = await makeTmpHome();
  for (const k of ENV_KEYS) {
    prev[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(async () => {
  await tmp.dispose();
  for (const k of ENV_KEYS) {
    if (prev[k] === undefined) delete process.env[k];
    else process.env[k] = prev[k];
  }
});

describe('resolveConfig', () => {
  it('falls back to defaults when no persona + no env', async () => {
    const cfg = await resolveConfig();
    expect(cfg.natsUrl).toBe(DEFAULT_BROKER_URL);
    expect(cfg.loggedIn).toBe(false);
    expect(cfg.chatName).toBeUndefined();
  });

  it('reads from comms-v3.env when persona is logged in', async () => {
    await writeCommsEnv({
      natsUrl: 'tls://nats.kaeva.app:39899',
      credsPath: '/path/creds',
      workspaceId: 'ws-default',
      orgId: 'org-test',
      chatName: 'Viraj-Alpha',
    });
    const cfg = await resolveConfig();
    expect(cfg.loggedIn).toBe(true);
    expect(cfg.workspaceId).toBe('ws-default');
    expect(cfg.chatName).toBe('Viraj-Alpha');
    expect(cfg.orgId).toBe('org-test');
  });

  it('env vars override the persona file', async () => {
    await writeCommsEnv({
      natsUrl: 'tls://from-file:1',
      credsPath: '/p',
      workspaceId: 'ws-file',
      orgId: 'org',
      chatName: 'name-file',
    });
    process.env['UNBLOCK_NATS_URL'] = 'tls://from-env:2';
    process.env['UNBLOCK_CHAT_NAME'] = 'name-env';
    const cfg = await resolveConfig();
    expect(cfg.natsUrl).toBe('tls://from-env:2');
    expect(cfg.chatName).toBe('name-env');
  });

  it('CLI overrides beat env vars', async () => {
    process.env['UNBLOCK_NATS_URL'] = 'tls://from-env:2';
    const cfg = await resolveConfig({ natsUrl: 'tls://from-flag:3' });
    expect(cfg.natsUrl).toBe('tls://from-flag:3');
  });
});
