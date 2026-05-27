import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWhoami } from '../../src/commands/whoami.js';
import {
  writeCommsCreds,
  writeCommsEnv,
  writeIdentity,
} from '../../src/auth/persona-store.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';
import { Buffer } from 'node:buffer';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
});
afterEach(async () => {
  await tmp.dispose();
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ed25519' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('runWhoami', () => {
  it('returns not-logged-in when nothing exists', async () => {
    const res = await runWhoami();
    expect(res.loggedIn).toBe(false);
    expect(res.lines.join('\n')).toContain('not logged in');
  });

  it('returns full identity when persona is configured', async () => {
    await writeIdentity({
      did: 'did:key:z6MkfakeFakeFakeFakeFakeFakeFakeFake',
      agentName: 'Viraj-Alpha',
      ed25519PublicKeyHex: 'aa'.repeat(32),
      createdAt: '2026-05-24T00:00:00.000Z',
    });
    await writeCommsEnv({
      natsUrl: 'tls://nats.kaeva.app:39899',
      credsPath: '/path/creds',
      workspaceId: 'ws-default',
      orgId: 'org-test',
      chatName: 'Viraj-Alpha',
    });
    const jwt = makeJwt({ name: 'Viraj-Alpha', exp: 4102444800 }); // 2100-01-01
    await writeCommsCreds(
      `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n`,
    );

    const res = await runWhoami();
    expect(res.loggedIn).toBe(true);
    expect(res.did).toMatch(/^did:key:z/);
    expect(res.broker).toBe('tls://nats.kaeva.app:39899');
    expect(res.workspaceId).toBe('ws-default');
    expect(res.orgId).toBe('org-test');
    expect(res.jwtExpiresAt).toMatch(/^\d{4}-/);
  });
});
