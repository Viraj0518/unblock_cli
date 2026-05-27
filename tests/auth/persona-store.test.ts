import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  identityPath,
  parseCommsEnv,
  readCommsEnv,
  readIdentity,
  v3CredsPath,
  v3EnvPath,
  wipePersonaStore,
  writeCommsCreds,
  writeCommsEnv,
  writeIdentity,
} from '../../src/auth/persona-store.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;

beforeEach(async () => {
  tmp = await makeTmpHome();
});
afterEach(async () => {
  await tmp.dispose();
});

describe('persona-store', () => {
  it('identity round-trip writes and reads identity.json', async () => {
    const id = {
      did: 'did:key:z6MkfakeFakeFakeFakeFakeFakeFakeFakeFakeFake',
      agentName: 'Test-Alpha',
      ed25519PublicKeyHex: 'ab'.repeat(32),
      createdAt: '2026-05-24T00:00:00.000Z',
    };
    await writeIdentity(id);
    const read = await readIdentity();
    expect(read).toEqual(id);
    expect(identityPath()).toMatch(/identity\.json$/);
  });

  it('readIdentity returns null when file is missing', async () => {
    expect(await readIdentity()).toBeNull();
  });

  it('comms-env round-trip preserves all five required fields', async () => {
    const env = {
      natsUrl: 'tls://nats.kaeva.app:39899',
      credsPath: '/some/path/comms-v3.creds',
      workspaceId: 'ws-default',
      orgId: 'org-test',
      chatName: 'Test-Alpha',
    };
    await writeCommsEnv(env);
    const read = await readCommsEnv();
    expect(read).toEqual(env);
  });

  it('parseCommsEnv handles quoted values and comments', () => {
    const raw = [
      '# header comment',
      'UNBLOCK_NATS_URL="tls://nats.kaeva.app:39899"',
      "UNBLOCK_NATS_CREDS='/path/to/creds'",
      'UNBLOCK_WORKSPACE_ID=ws-default',
      'UNBLOCK_ORG_ID=org-test',
      'UNBLOCK_CHAT_NAME=Viraj-Alpha',
      '',
    ].join('\n');
    const parsed = parseCommsEnv(raw);
    expect(parsed).toEqual({
      natsUrl: 'tls://nats.kaeva.app:39899',
      credsPath: '/path/to/creds',
      workspaceId: 'ws-default',
      orgId: 'org-test',
      chatName: 'Viraj-Alpha',
    });
  });

  it('parseCommsEnv returns null on missing required fields', () => {
    const raw = 'UNBLOCK_NATS_URL=tls://x:1\nUNBLOCK_CHAT_NAME=n\n';
    expect(parseCommsEnv(raw)).toBeNull();
  });

  it('writeCommsCreds writes creds file at v3 path', async () => {
    const credsBody = '-----BEGIN NATS USER JWT-----\neyJabcdef\n------END NATS USER JWT------\n';
    const written = await writeCommsCreds(credsBody);
    expect(written).toBe(v3CredsPath());
    const back = await readFile(written, 'utf-8');
    expect(back).toContain('-----BEGIN NATS USER JWT-----');
  });

  it('wipePersonaStore is idempotent and removes existing files', async () => {
    await writeIdentity({
      did: 'did:key:z6Mkfake',
      agentName: 'x',
      ed25519PublicKeyHex: 'a',
      createdAt: '2026-01-01T00:00:00.000Z',
    });
    await writeCommsEnv({
      natsUrl: 'tls://x:1',
      credsPath: '/p',
      workspaceId: 'w',
      orgId: 'o',
      chatName: 'n',
    });
    const first = await wipePersonaStore();
    expect(first.length).toBeGreaterThanOrEqual(2);
    // Second call must not throw and removes nothing.
    const second = await wipePersonaStore();
    expect(second.length).toBe(0);
  });

  it('uses v3EnvPath under UNBLOCK_HOME', () => {
    expect(v3EnvPath()).toContain(tmp.home);
    expect(v3EnvPath().endsWith('comms-v3.env')).toBe(true);
  });
});
