/**
 * Tests for `unblock invite` (Gap A closure).
 *
 * Covers:
 *   - --org and --role validation
 *   - --expires-in-days clamping to [1, 90]
 *   - --persona routes auth from ~/.unblock-personas/<NAME>/comms-v3.creds
 *   - happy path: 200 -> { invite_code, role, expires_at, org_id }
 *   - error path: 4xx with { error: { code, message } } surfaces both
 *   - missing creds file -> helpful "run unblock login" error
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { runInvite, clampExpiresInDays } from '../../src/commands/invite.js';
import { writeCommsCreds, personaHomeFor } from '../../src/auth/persona-store.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;

beforeEach(async () => {
  tmp = await makeTmpHome();
});
afterEach(async () => {
  await tmp.dispose();
});

/** Build a fake NATS .creds file containing a real-looking JWT. */
function fakeCredsFile(jwtPayload: Record<string, unknown> = { name: 'Viraj-Alpha' }): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ed25519' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(jwtPayload)).toString('base64url');
  const jwt = `${header}.${body}.fakesig`;
  return `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n`;
}

// ─── clampExpiresInDays ──────────────────────────────────────────────────────

describe('clampExpiresInDays', () => {
  it('returns the value when within range', () => {
    expect(clampExpiresInDays(14)).toBe(14);
  });
  it('caps at 90', () => {
    expect(clampExpiresInDays(9999)).toBe(90);
  });
  it('floors at 1', () => {
    expect(clampExpiresInDays(0)).toBe(1);
    expect(clampExpiresInDays(-5)).toBe(1);
  });
  it('floors fractional values', () => {
    expect(clampExpiresInDays(7.9)).toBe(7);
  });
  it('falls back to default 7 on NaN / Infinity', () => {
    expect(clampExpiresInDays(Number.NaN)).toBe(7);
    expect(clampExpiresInDays(Number.POSITIVE_INFINITY)).toBe(7);
  });
});

// ─── validation ──────────────────────────────────────────────────────────────

describe('runInvite validation', () => {
  it('throws when --org is empty', async () => {
    await writeCommsCreds(fakeCredsFile());
    await expect(
      runInvite(
        { fetcher: async () => new Response('{}', { status: 200 }) },
        { org: '   ', role: 'member' },
      ),
    ).rejects.toThrow(/--org/);
  });

  it('throws when --role is not in admin|member|guest', async () => {
    await writeCommsCreds(fakeCredsFile());
    // Deliberately pass an invalid role to verify the guard; cast through
    // unknown so the test compiles without weakening the public API type.
    const badRole = 'superuser' as unknown;
    await expect(
      runInvite(
        { fetcher: async () => new Response('{}', { status: 200 }) },
        { org: 'did:web:unblock.kaeva.app', role: badRole as 'admin' },
      ),
    ).rejects.toThrow(/--role/);
  });

  it('throws when no creds file exists', async () => {
    // tmp home is fresh — no comms-v3.creds was written.
    await expect(
      runInvite(
        { fetcher: async () => new Response('{}', { status: 200 }) },
        { org: 'did:web:unblock.kaeva.app', role: 'member' },
      ),
    ).rejects.toThrow(/no creds at .*\. Run `unblock login/);
  });
});

// ─── happy path ──────────────────────────────────────────────────────────────

describe('runInvite happy path', () => {
  it('POSTs to /v1/org/invite with Bearer JWT and returns parsed result', async () => {
    await writeCommsCreds(fakeCredsFile({ name: 'Viraj-Alpha', sub: 'UABC' }));

    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeServerResp = {
      invite_code: 'inv_abc123',
      role: 'member',
      expires_at: '2026-06-03T00:00:00.000Z',
      org_id: 'did:web:unblock.kaeva.app',
    };
    const mockFetcher: typeof globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
      calls.push({ url, init: init ?? {} });
      return new Response(JSON.stringify(fakeServerResp), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await runInvite(
      { fetcher: mockFetcher },
      {
        org: 'did:web:unblock.kaeva.app',
        role: 'member',
        expiresInDays: 14,
        authUrl: 'https://auth.test.example',
      },
    );

    // Server was called with the right URL + Bearer + body shape.
    expect(calls).toHaveLength(1);
    const c = calls[0];
    expect(c).toBeDefined();
    expect(c?.url).toBe('https://auth.test.example/v1/org/invite');
    const headers = (c?.init.headers ?? {}) as Record<string, string>;
    expect(headers['authorization']).toMatch(/^Bearer /);
    expect(headers['authorization']).not.toBe('Bearer ');
    const sentBody = JSON.parse(String(c?.init.body ?? '{}')) as Record<string, unknown>;
    expect(sentBody['org_id']).toBe('did:web:unblock.kaeva.app');
    expect(sentBody['role']).toBe('member');
    expect(sentBody['expires_in_days']).toBe(14);

    // Result is parsed correctly.
    expect(result.inviteCode).toBe('inv_abc123');
    expect(result.role).toBe('member');
    expect(result.expiresAt).toBe('2026-06-03T00:00:00.000Z');
    expect(result.orgId).toBe('did:web:unblock.kaeva.app');
  });

  it('clamps --expires-in-days to 90 before sending to server', async () => {
    await writeCommsCreds(fakeCredsFile());
    let sentDays: unknown;
    const mockFetcher: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sentDays = body['expires_in_days'];
      return new Response(
        JSON.stringify({ invite_code: 'inv_x', role: 'guest', expires_at: 't', org_id: 'o' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    await runInvite(
      { fetcher: mockFetcher },
      { org: 'did:o', role: 'guest', expiresInDays: 9999 },
    );
    expect(sentDays).toBe(90);
  });

  it('defaults expires_in_days to 7 when omitted', async () => {
    await writeCommsCreds(fakeCredsFile());
    let sentDays: unknown;
    const mockFetcher: typeof globalThis.fetch = async (_input, init) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      sentDays = body['expires_in_days'];
      return new Response(
        JSON.stringify({ invite_code: 'i', role: 'admin', expires_at: 't', org_id: 'o' }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    };
    await runInvite({ fetcher: mockFetcher }, { org: 'did:o', role: 'admin' });
    expect(sentDays).toBe(7);
  });
});

// ─── error responses ────────────────────────────────────────────────────────

describe('runInvite error path', () => {
  it('surfaces server error.code and error.message on 4xx', async () => {
    await writeCommsCreds(fakeCredsFile());
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({ error: { code: 'forbidden', message: 'not an admin' } }),
        { status: 403, headers: { 'content-type': 'application/json' } },
      );

    await expect(
      runInvite({ fetcher: mockFetcher }, { org: 'did:o', role: 'member' }),
    ).rejects.toThrow(/forbidden.*not an admin/);
  });

  it('falls back to http_<status> when body has no error shape', async () => {
    await writeCommsCreds(fakeCredsFile());
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response('plain text', { status: 500 });
    await expect(
      runInvite({ fetcher: mockFetcher }, { org: 'did:o', role: 'member' }),
    ).rejects.toThrow(/http_500/);
  });
});

// ─── --persona routing ──────────────────────────────────────────────────────

describe('runInvite --persona routing', () => {
  it('reads creds from ~/.unblock-personas/<NAME>/comms-v3.creds, not ~/.unblock/', async () => {
    // The tmp-home fixture only sets UNBLOCK_HOME. To prove --persona overrides
    // BOTH the env var and the default, we set up a stub persona dir on disk
    // and only place creds there (not in tmp home). If --persona is honored
    // the call succeeds; otherwise it fails with "no creds at ...".
    const personaName = `test-persona-${process.pid}-${Date.now()}`;
    const personaDir = personaHomeFor(personaName);
    await mkdir(personaDir, { recursive: true });
    const credsFile = path.join(personaDir, 'comms-v3.creds');
    await writeFile(credsFile, fakeCredsFile({ name: personaName }), 'utf-8');

    try {
      let bearer: string | undefined;
      const mockFetcher: typeof globalThis.fetch = async (_input, init) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        bearer = headers['authorization'];
        return new Response(
          JSON.stringify({
            invite_code: 'inv_persona',
            role: 'guest',
            expires_at: 't',
            org_id: 'did:o',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      };
      const result = await runInvite(
        { fetcher: mockFetcher },
        { org: 'did:o', role: 'guest', persona: personaName },
      );
      expect(result.inviteCode).toBe('inv_persona');
      expect(bearer).toMatch(/^Bearer /);
    } finally {
      // best-effort cleanup
      const { rm } = await import('node:fs/promises');
      await rm(personaDir, { recursive: true, force: true });
    }
  });
});
