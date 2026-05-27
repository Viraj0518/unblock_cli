import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMint, parseTtl } from '../../src/commands/mint.js';
import { writeIdentity } from '../../src/auth/persona-store.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
  await writeIdentity({
    did: 'did:key:z6MkTestAlpha123',
    agentName: 'Viraj-Alpha',
    ed25519PublicKeyHex: 'deadbeef01',
    createdAt: '2026-05-27T00:00:00.000Z',
  });
});
afterEach(async () => {
  await tmp.dispose();
});

// ─── parseTtl ─────────────────────────────────────────────────────────────────

describe('parseTtl', () => {
  it('parses days', () => {
    expect(parseTtl('30d')).toBe(2_592_000);
  });
  it('parses hours', () => {
    expect(parseTtl('1h')).toBe(3_600);
  });
  it('parses raw seconds', () => {
    expect(parseTtl('7200')).toBe(7_200);
  });
  it('caps at 30d max', () => {
    expect(parseTtl('9999d')).toBe(2_592_000);
  });
  it('throws on invalid input', () => {
    expect(() => parseTtl('not-a-duration')).toThrow();
  });
});

// ─── runMint happy path ────────────────────────────────────────────────────────

describe('runMint --print (happy path)', () => {
  it('calls /v1/nats/token and returns parsed result', async () => {
    const fakeCredsContent = 'NATS-CREDS-CONTENT\n';
    const mockFetcher: typeof globalThis.fetch = async (input, _init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : String(input);
      if (url.includes('/v1/nats/token')) {
        return new Response(
          JSON.stringify({
            nats_creds: fakeCredsContent,
            jwt_expires_at: '2026-06-26T00:00:00.000Z',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('not found', { status: 404 });
    };

    const result = await runMint(
      { fetcher: mockFetcher },
      {
        print: true, // don't write files
        ttl: '30d',
      },
    );

    expect(result.persona).toBe('Viraj-Alpha');
    expect(result.did).toBe('did:key:z6MkTestAlpha123');
    expect(result.natsCreds).toBe(fakeCredsContent);
    expect(result.jwtExpiresAt).toBe('2026-06-26T00:00:00.000Z');
    expect(result.ttlSeconds).toBe(2_592_000);
    expect(result.credsPath).toBeUndefined();
    expect(result.envPath).toBeUndefined();
  });
});

// ─── runMint error path ────────────────────────────────────────────────────────

describe('runMint error path', () => {
  it('throws when auth-issuer returns non-200', async () => {
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response('{"error":"unauthorized"}', {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });

    await expect(
      runMint({ fetcher: mockFetcher }, { print: true }),
    ).rejects.toThrow(/401/);
  });

  it('throws when no identity found', async () => {
    // Wipe identity by using a fresh home with no identity.json
    const tmp2 = await makeTmpHome();
    try {
      await expect(
        runMint({ fetcher: async () => new Response('{}', { status: 200 }) }, { print: true }),
      ).rejects.toThrow(/No persona/);
    } finally {
      await tmp2.dispose();
    }
  });
});

// ─── --json shape ─────────────────────────────────────────────────────────────

describe('runMint --json output shape', () => {
  it('result has all required json keys', async () => {
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response(
        JSON.stringify({
          nats_creds: 'FAKE\n',
          jwt_expires_at: '2026-06-26T00:00:00.000Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );

    const result = await runMint({ fetcher: mockFetcher }, { print: true });
    // Check all fields from the X1 spec
    expect(result).toHaveProperty('persona');
    expect(result).toHaveProperty('did');
    expect(result).toHaveProperty('jwtExpiresAt');
    expect(result).toHaveProperty('ttlSeconds');
    expect(result).toHaveProperty('natsCreds');
  });
});
