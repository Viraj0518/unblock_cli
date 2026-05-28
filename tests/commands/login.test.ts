import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runLogin } from '../../src/commands/login.js';
import { runLogout } from '../../src/commands/logout.js';
import {
  identityPath,
  readIdentity,
  v3CredsPath,
  v3EnvPath,
} from '../../src/auth/persona-store.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
});
afterEach(async () => {
  await tmp.dispose();
});

describe('runLogin', () => {
  it('mints identity, enrolls, writes comms-v3.{creds,env}', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = {
      natsCreds: '-----BEGIN NATS USER JWT-----\nFAKEJWT\n------END NATS USER JWT------\n',
      natsUrl: 'tls://nats.kaeva.app:39899',
      workspaceId: 'ws-orgA',
      orgId: 'org-A',
      name: 'Viraj-Alpha',
      expiresAt: '2027-01-01T00:00:00Z',
    };

    const result = await runLogin(
      { substrateFactory: factory, nowIso: () => '2026-05-24T00:00:00.000Z' },
      { inviteCode: 'INV-123' },
    );

    expect(result.mintedNewIdentity).toBe(true);
    expect(result.orgId).toBe('org-A');
    expect(result.workspaceId).toBe('ws-orgA');
    expect(result.broker).toBe('tls://nats.kaeva.app:39899');

    // Identity was written.
    const id = await readIdentity();
    expect(id).not.toBeNull();
    expect(id?.did.startsWith('did:key:z')).toBe(true);

    // Creds + env files exist.
    const creds = await readFile(v3CredsPath(), 'utf-8');
    expect(creds).toContain('-----BEGIN NATS USER JWT-----');
    const envContent = await readFile(v3EnvPath(), 'utf-8');
    expect(envContent).toContain('UNBLOCK_NATS_URL=tls://nats.kaeva.app:39899');
    expect(envContent).toContain('UNBLOCK_ORG_ID=org-A');
    expect(envContent).toContain('UNBLOCK_CHAT_NAME=Viraj-Alpha');
    expect(envContent).toContain('UNBLOCK_JWT_EXPIRES_AT=2027-01-01T00:00:00Z');

    // Enroll was called with our minted DID.
    expect(state.enrollCalls).toHaveLength(1);
    expect(state.enrollCalls[0]?.inviteCode).toBe('INV-123');
  });

  it('reuses existing identity on second login (does not re-mint)', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = {
      natsCreds: '-----BEGIN NATS USER JWT-----\nFAKEJWT\n------END NATS USER JWT------\n',
      natsUrl: 'tls://nats.kaeva.app:39899',
      workspaceId: 'ws',
      orgId: 'org',
      name: 'persona',
    };

    const first = await runLogin({ substrateFactory: factory }, { inviteCode: 'INV-1' });
    const second = await runLogin({ substrateFactory: factory }, { inviteCode: 'INV-2' });

    expect(first.did).toBe(second.did);
    expect(first.mintedNewIdentity).toBe(true);
    expect(second.mintedNewIdentity).toBe(false);
  });

  it('persists UNBLOCK_API_KEY to comms-v3.env when enroll returns api_key (P1 fix · 2026-05-27)', async () => {
    // Auth-issuer fix: enroll now mints a substrate API key. The CLI
    // must persist it to comms-v3.env so substrate verbs auto-authenticate.
    // Without this, fresh personas had working comms but every substrate
    // verb (remember/query/share/…) 401'd with AUTH_MISSING.
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = {
      natsCreds: '-----BEGIN NATS USER JWT-----\nFAKEJWT\n------END NATS USER JWT------\n',
      natsUrl: 'tls://nats.kaeva.app:39899',
      workspaceId: 'ws',
      orgId: 'org-A',
      name: 'Viraj-Alpha',
      apiKey: 'unb_' + 'd'.repeat(64),
      apiKeyId: 'akey_enroll_abcdef0123456789',
    };
    const result = await runLogin(
      { substrateFactory: factory },
      { inviteCode: 'INV-1' },
    );
    expect(result.apiKeyMinted).toBe(true);
    expect(result.apiKeyId).toBe('akey_enroll_abcdef0123456789');
    const envContent = await readFile(v3EnvPath(), 'utf-8');
    expect(envContent).toContain(`UNBLOCK_API_KEY=unb_${'d'.repeat(64)}`);
  });

  it('omits UNBLOCK_API_KEY when enroll does NOT return api_key (older auth-issuer back-compat)', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = {
      natsCreds: '-----BEGIN NATS USER JWT-----\nFAKEJWT\n------END NATS USER JWT------\n',
      natsUrl: 'tls://nats.kaeva.app:39899',
      workspaceId: 'ws',
      orgId: 'org',
      name: 'persona',
      // no api_key field — simulating older deployed auth-issuer
    };
    const result = await runLogin(
      { substrateFactory: factory },
      { inviteCode: 'INV-1' },
    );
    expect(result.apiKeyMinted).toBe(false);
    expect(result.apiKeyId).toBeUndefined();
    const envContent = await readFile(v3EnvPath(), 'utf-8');
    expect(envContent).not.toContain('UNBLOCK_API_KEY=');
  });

  it('runLogout removes identity + comms files (idempotent)', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = {
      natsCreds: '-----BEGIN NATS USER JWT-----\nFAKEJWT\n------END NATS USER JWT------\n',
      natsUrl: 'tls://nats.kaeva.app:39899',
      workspaceId: 'ws',
      orgId: 'org',
      name: 'persona',
    };
    await runLogin({ substrateFactory: factory }, { inviteCode: 'INV-1' });
    const removed = await runLogout();
    expect(removed.removed.length).toBeGreaterThanOrEqual(2);
    // Files actually gone.
    await expect(readFile(identityPath(), 'utf-8')).rejects.toThrow();
    // Second call: no-op.
    const again = await runLogout();
    expect(again.removed.length).toBe(0);
  });
});
