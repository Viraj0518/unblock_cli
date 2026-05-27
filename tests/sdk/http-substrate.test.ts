import { describe, expect, it } from 'vitest';
import {
  createHttpSubstrateFactory,
  DEFAULT_SUBSTRATE_URL,
  EnrollError,
  SubstrateError,
} from '../../src/sdk/http-substrate.js';

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

function makeFetch(responses: ReadonlyArray<Response | (() => Response)>): {
  fetch: typeof globalThis.fetch;
  calls: FetchCall[];
} {
  const calls: FetchCall[] = [];
  let i = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    const r = responses[i] ?? responses[responses.length - 1];
    if (r === undefined) throw new Error('mock fetch: no responses queued');
    i += 1;
    return typeof r === 'function' ? r() : r;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('http-substrate enroll', () => {
  it('posts to /v1/identity/enroll w/ X-Invite-Code header + {human_did, ed25519_pubkey_hex} body (live server shape)', async () => {
    // Server-of-truth: unblock-v02-mig/services/auth-issuer/src/handlers/
    // identity-enroll.ts. Returns user_jwt + creds_file_content + broker_url
    // + workspace_id + org_id + role + human_did + expires_at.
    const { fetch, calls } = makeFetch([
      new Response(
        JSON.stringify({
          user_jwt: 'eyJ.fake.jwt',
          creds_file_content:
            '-----BEGIN NATS USER JWT-----\nFAKE\n-----END NATS USER JWT-----\n',
          broker_url: 'tls://nats.kaeva.app:39899',
          workspace_id: 'ws-1',
          org_id: 'org-1',
          role: 'member',
          human_did: 'did:key:z6Mkfake',
          expires_at: '2027-01-01T00:00:00Z',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    const result = await client.enroll({
      inviteCode: 'INV-1',
      identity: {
        did: 'did:key:z6Mkfake',
        agentName: 'persona',
        ed25519PublicKeyHex: 'aa'.repeat(32),
        createdAt: '2026-01-01T00:00:00Z',
      },
    });
    expect(result.orgId).toBe('org-1');
    expect(result.workspaceId).toBe('ws-1');
    expect(result.expiresAt).toBe('2027-01-01T00:00:00Z');
    expect(result.natsCreds).toContain('BEGIN NATS USER JWT');
    expect(result.natsUrl).toBe('tls://nats.kaeva.app:39899');
    // Display handle picks the DID (server canonical) over the local
    // agentName fallback.
    expect(result.name).toBe('did:key:z6Mkfake');

    expect(calls[0]?.url).toBe('https://auth.kaeva.app/v1/identity/enroll');
    expect(calls[0]?.init?.method).toBe('POST');

    // CRITICAL contract pins — fixed 2026-05-27 after live smoke caught
    // the CLI sending invite_code in the body (server returned 401
    // invalid_or_expired_invite "Missing X-Invite-Code header").
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-invite-code']).toBe('INV-1');

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['human_did']).toBe('did:key:z6Mkfake');
    expect(body['ed25519_pubkey_hex']).toBe('aa'.repeat(32));
    // The OLD shape — proven to 401 on the live server — must NOT appear.
    expect(body['invite_code']).toBeUndefined();
    expect(body['did']).toBeUndefined();
    expect(body['agent_name']).toBeUndefined();
    expect(body['ed25519_public_key_hex']).toBeUndefined();
  });

  it('accepts legacy {nats_creds, nats_url, name} response shape (back-compat for mocks)', async () => {
    // Older fixtures + the v0.1 internal mock still ship the legacy
    // server shape. Don't break them — surface the same EnrollResult.
    const { fetch } = makeFetch([
      new Response(
        JSON.stringify({
          nats_creds: '-----BEGIN NATS USER JWT-----\nFAKE\n-----END NATS USER JWT-----\n',
          nats_url: 'tls://nats.kaeva.app:39899',
          workspace_id: 'ws-1',
          org_id: 'org-1',
          name: 'persona',
        }),
        { status: 200 },
      ),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    const result = await client.enroll({
      inviteCode: 'INV-1',
      identity: {
        did: 'did:key:z6Mkfake',
        agentName: 'persona',
        ed25519PublicKeyHex: 'aa'.repeat(32),
        createdAt: '2026-01-01T00:00:00Z',
      },
    });
    expect(result.name).toBe('persona');
    expect(result.natsUrl).toBe('tls://nats.kaeva.app:39899');
  });

  it('lowercases ed25519_pubkey_hex before sending (server requires lowercase per regex /^[0-9a-f]{64}$/)', async () => {
    const { fetch, calls } = makeFetch([
      new Response(
        JSON.stringify({
          user_jwt: 'x',
          creds_file_content: 'creds',
          broker_url: 'tls://b:1',
          workspace_id: 'w',
          org_id: 'o',
          role: 'member',
          human_did: 'did:key:z6Mkfake',
          expires_at: '2027-01-01T00:00:00Z',
        }),
        { status: 200 },
      ),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    await client.enroll({
      inviteCode: 'INV-1',
      identity: {
        did: 'did:key:z6Mkfake',
        agentName: 'persona',
        // Uppercase hex — server would reject if we forwarded as-is.
        ed25519PublicKeyHex: 'AA'.repeat(32),
        createdAt: '2026-01-01T00:00:00Z',
      },
    });
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['ed25519_pubkey_hex']).toBe('aa'.repeat(32));
  });

  it('throws EnrollError on 4xx', async () => {
    const { fetch } = makeFetch([
      new Response('invite expired', { status: 410 }),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    await expect(
      client.enroll({
        inviteCode: 'BAD',
        identity: {
          did: 'did:key:z',
          agentName: 'a',
          ed25519PublicKeyHex: 'b',
          createdAt: '2026-01-01',
        },
      }),
    ).rejects.toBeInstanceOf(EnrollError);
  });

  it('throws EnrollError on the live "invalid_or_expired_invite" 401 (regression for the P0 cold-enrollment bug)', async () => {
    // Exact wire shape returned by the auth-issuer at auth.kaeva.app when
    // the X-Invite-Code header is missing — surfaced by a fresh-agent CLI
    // smoke test on 2026-05-27. Before the fix the CLI tripped this because
    // it put the code in the JSON body. After the fix the test pins that the
    // EnrollError surfaces the server message verbatim.
    const { fetch } = makeFetch([
      new Response(
        JSON.stringify({
          code: 'invalid_or_expired_invite',
          error: 'Missing X-Invite-Code header. Obtain an invite code from an org admin.',
        }),
        { status: 401, headers: { 'content-type': 'application/json' } },
      ),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    await expect(
      client.enroll({
        inviteCode: 'INV-1',
        identity: {
          did: 'did:key:z6Mkfake',
          agentName: 'persona',
          ed25519PublicKeyHex: 'aa'.repeat(32),
          createdAt: '2026-01-01T00:00:00Z',
        },
      }),
    ).rejects.toMatchObject({
      name: 'EnrollError',
      status: 401,
      body: expect.stringContaining('invalid_or_expired_invite'),
    });
  });
});

describe('http-substrate remember/query', () => {
  it('remember POSTs to <substrateUrl>/v1/remember (NOT authUrl) and parses block_id', async () => {
    // Regression: pre-Iter-3 the CLI hit authUrl + 404. This test pins the
    // separation between authUrl and substrateUrl.
    const { fetch, calls } = makeFetch([
      new Response(JSON.stringify({ block_id: 'blk_x', created_at: '2026-05-27T18:00:00Z' }), {
        status: 200,
      }),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({
      authUrl: 'https://auth.kaeva.app',
      substrateUrl: 'https://substrate.example/v1-api',
      apiKey: async () => 'unb_' + 'a'.repeat(32),
    });
    const r = await client.remember({ content: 'hi' });
    expect(r.blockId).toBe('blk_x');
    expect(r.storedAt).toBe('2026-05-27T18:00:00Z');
    expect(calls[0]?.url).toBe('https://substrate.example/v1-api/v1/remember');
    expect(calls[0]?.init?.method).toBe('POST');
    const headers = (calls[0]?.init?.headers ?? {}) as Record<string, string>;
    expect(headers['x-api-key']).toBe('unb_' + 'a'.repeat(32));
    // No leakage of the auth-issuer Bearer header when apiKey is set.
    expect(headers['authorization']).toBeUndefined();
  });

  it('remember accepts legacy stored_at response shape (back-compat)', async () => {
    const { fetch } = makeFetch([
      new Response(JSON.stringify({ block_id: 'blk_x', stored_at: 'legacy-ts' }), { status: 200 }),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    const r = await client.remember({ content: 'hi' });
    expect(r.storedAt).toBe('legacy-ts');
  });

  it('query POSTs to /v1/query with body {text, top_k} and parses {hits} envelope', async () => {
    // Regression: pre-Iter-3 the CLI GET'd /v1/query?q= → 404 on the live EF.
    const { fetch, calls } = makeFetch([
      new Response(
        JSON.stringify({
          hits: [
            { block_id: 'b', score: 0.5, content: 'snippet content here' },
            { block_id: 'c', score: 0.3, snippet: 'older shape preserved' },
          ],
          answer: 'synth',
          abstained: false,
        }),
        { status: 200 },
      ),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({
      authUrl: 'https://auth.kaeva.app',
      substrateUrl: 'https://substrate.example',
      apiKey: async () => 'unb_' + 'b'.repeat(32),
    });
    const hits = await client.query('q', { topK: 3 });
    expect(hits).toHaveLength(2);
    expect(hits[0]?.blockId).toBe('b');
    expect(hits[0]?.snippet).toContain('snippet content here');
    expect(hits[1]?.snippet).toBe('older shape preserved');
    expect(calls[0]?.url).toBe('https://substrate.example/v1/query');
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['text']).toBe('q');
    expect(body['top_k']).toBe(3);
  });

  it('query throws SubstrateError on 5xx', async () => {
    const { fetch } = makeFetch([new Response('boom', { status: 500 })]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    await expect(client.query('q')).rejects.toBeInstanceOf(SubstrateError);
  });

  it('substrate calls fall back to authUrl when substrateUrl is not provided (compat)', async () => {
    // For the brief enrollment-only path (login). After login, all
    // substrate-using verbs must set substrateUrl explicitly.
    const { fetch, calls } = makeFetch([
      new Response(JSON.stringify({ block_id: 'blk_x', created_at: 't' }), { status: 200 }),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://only-auth.example' });
    await client.remember({ content: 'x' });
    expect(calls[0]?.url).toBe('https://only-auth.example/v1/remember');
  });

  it('exposes DEFAULT_SUBSTRATE_URL pointing at the live Supabase EF', () => {
    expect(DEFAULT_SUBSTRATE_URL).toBe(
      'https://wzqkolqxtmqdptwchrkl.supabase.co/functions/v1/unblock-api',
    );
  });
});
