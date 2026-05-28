import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { runLogin } from '../../src/commands/login.js';
import { runLogout } from '../../src/commands/logout.js';
import { shortenDid } from '../../src/auth/did.js';
import {
  identityPath,
  readIdentity,
  v3CredsPath,
  v3EnvPath,
} from '../../src/auth/persona-store.js';
import type { EnrollResult, SubstrateFactory } from '../../src/sdk/types.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
});
afterEach(async () => {
  await tmp.dispose();
});

function enrollResult(name: string): EnrollResult {
  return {
    natsCreds: '-----BEGIN NATS USER JWT-----\nFAKEJWT\n------END NATS USER JWT------\n',
    natsUrl: 'tls://nats.kaeva.app:39899',
    workspaceId: 'ws',
    orgId: 'org',
    name,
  };
}

function createEchoNameSubstrateFactory(): ReturnType<typeof createMockSubstrateFactory> {
  const { factory, state } = createMockSubstrateFactory();
  const echoFactory = {
    create(options) {
      const client = factory.create(options);
      return {
        ...client,
        async enroll(input) {
          state.enrollResponse = enrollResult(input.identity.agentName);
          return client.enroll(input);
        },
      };
    },
  } satisfies SubstrateFactory;
  return { factory: echoFactory, state };
}

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

  it('fresh enroll with --agent-name lowercases chat_name (issue #140)', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = enrollResult('Viraj-codex-X');

    const result = await runLogin(
      { substrateFactory: factory },
      { inviteCode: 'INV-1', agentName: 'Viraj-codex-X' },
    );

    expect(result.mintedNewIdentity).toBe(true);
    expect(result.chatName).toBe('viraj-codex-x');
    expect(state.enrollCalls).toHaveLength(1);
    expect(state.enrollCalls[0]?.agentName).toBe('Viraj-codex-X');
    const envContent = await readFile(v3EnvPath(), 'utf-8');
    expect(envContent).toContain('UNBLOCK_CHAT_NAME=viraj-codex-x');
  });

  it('fresh enroll without --agent-name preserves DID-short fallback (issue #140)', async () => {
    const { factory, state } = createEchoNameSubstrateFactory();

    const result = await runLogin(
      { substrateFactory: factory },
      { inviteCode: 'INV-1' },
    );

    const expectedChatName = shortenDid(result.did);
    expect(result.mintedNewIdentity).toBe(true);
    expect(result.chatName).toBe(expectedChatName);
    expect(state.enrollCalls[0]?.agentName).toBe(expectedChatName);
    const envContent = await readFile(v3EnvPath(), 'utf-8');
    expect(envContent).toContain(`UNBLOCK_CHAT_NAME=${expectedChatName}`);
  });

  it('fresh enroll defensively overrides wrong server chat_name when --agent-name is set (issue #140)', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = enrollResult('shnxmwlu');

    const result = await runLogin(
      { substrateFactory: factory },
      { inviteCode: 'INV-1', agentName: 'Viraj-codex-3' },
    );

    expect(result.mintedNewIdentity).toBe(true);
    expect(result.chatName).toBe('viraj-codex-3');
    expect(state.enrollCalls[0]?.agentName).toBe('Viraj-codex-3');
    const envContent = await readFile(v3EnvPath(), 'utf-8');
    expect(envContent).toContain('UNBLOCK_CHAT_NAME=viraj-codex-3');
    expect(envContent).not.toContain('UNBLOCK_CHAT_NAME=shnxmwlu');
  });

  it('renames stale chat_name on re-login when --agent-name differs (issue #14 · 2026-05-28)', async () => {
    // Repro: a persona that was first enrolled with a random short-DID handle
    // (e.g. `xkqzhitg`) re-logs in with `--agent-name viraj-beta`. The CLI
    // updates identity.json.agentName but, because the server is NOT
    // re-enrolled with a new handle, comms-v3.env keeps the stale chat_name
    // and inbound DMs to `viraj-beta` silently drop.
    //
    // Fix (matches `canonicalChatName()` in auth-issuer PR #328): when
    // --agent-name is passed AND differs from the stored handle, the CLI
    // lowercases it client-side and writes it as UNBLOCK_CHAT_NAME directly.
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = {
      natsCreds: '-----BEGIN NATS USER JWT-----\nFAKEJWT\n------END NATS USER JWT------\n',
      natsUrl: 'tls://nats.kaeva.app:39899',
      workspaceId: 'ws',
      orgId: 'org',
      // Server returns the stale random handle on re-enroll (it sees the
      // same DID and reuses the row) — this is what produced the bug.
      name: 'xkqzhitg',
    };
    // First login mints a fresh identity; let it pick up the random handle.
    const first = await runLogin({ substrateFactory: factory }, { inviteCode: 'INV-1' });
    expect(first.chatName).toBe('xkqzhitg');
    {
      const envContent = await readFile(v3EnvPath(), 'utf-8');
      expect(envContent).toContain('UNBLOCK_CHAT_NAME=xkqzhitg');
    }

    // Re-login with --agent-name. Server STILL returns the stale name.
    const second = await runLogin(
      { substrateFactory: factory },
      { inviteCode: 'INV-2', agentName: 'Viraj-Beta' },
    );
    expect(second.mintedNewIdentity).toBe(false);
    // The result + env file MUST reflect the new, lowercased chat name.
    expect(second.chatName).toBe('viraj-beta');
    const envContent = await readFile(v3EnvPath(), 'utf-8');
    expect(envContent).toContain('UNBLOCK_CHAT_NAME=viraj-beta');
    expect(envContent).not.toContain('UNBLOCK_CHAT_NAME=xkqzhitg');
    // identity.json keeps the human-readable (non-lowercased) handle.
    const id = await readIdentity();
    expect(id?.agentName).toBe('Viraj-Beta');
  });

  it('does NOT override chat_name when --agent-name equals stored handle (no-op)', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = {
      natsCreds: '-----BEGIN NATS USER JWT-----\nFAKEJWT\n------END NATS USER JWT------\n',
      natsUrl: 'tls://nats.kaeva.app:39899',
      workspaceId: 'ws',
      orgId: 'org',
      name: 'viraj-beta',
    };
    await runLogin(
      { substrateFactory: factory },
      { inviteCode: 'INV-1', agentName: 'Viraj-Beta' },
    );
    const second = await runLogin(
      { substrateFactory: factory },
      { inviteCode: 'INV-2', agentName: 'Viraj-Beta' },
    );
    // Server returned 'viraj-beta'; agent-name normalizes to 'viraj-beta';
    // no override needed, env carries server value.
    expect(second.chatName).toBe('viraj-beta');
    const envContent = await readFile(v3EnvPath(), 'utf-8');
    expect(envContent).toContain('UNBLOCK_CHAT_NAME=viraj-beta');
  });

  it('does NOT override chat_name when --agent-name is omitted on re-login', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = {
      natsCreds: '-----BEGIN NATS USER JWT-----\nFAKEJWT\n------END NATS USER JWT------\n',
      natsUrl: 'tls://nats.kaeva.app:39899',
      workspaceId: 'ws',
      orgId: 'org',
      name: 'xkqzhitg',
    };
    await runLogin({ substrateFactory: factory }, { inviteCode: 'INV-1' });
    const second = await runLogin({ substrateFactory: factory }, { inviteCode: 'INV-2' });
    // Standard reconnect: env keeps server-supplied chat_name unchanged.
    expect(second.chatName).toBe('xkqzhitg');
    const envContent = await readFile(v3EnvPath(), 'utf-8');
    expect(envContent).toContain('UNBLOCK_CHAT_NAME=xkqzhitg');
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
