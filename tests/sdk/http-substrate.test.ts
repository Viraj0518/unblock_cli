import { describe, expect, it } from 'vitest';
import { createHttpSubstrateFactory, EnrollError, SubstrateError } from '../../src/sdk/http-substrate.js';

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
  it('posts to /v1/identity/enroll and parses the response', async () => {
    const { fetch, calls } = makeFetch([
      new Response(
        JSON.stringify({
          nats_creds: '-----BEGIN NATS USER JWT-----\nFAKE\n------END NATS USER JWT------\n',
          nats_url: 'tls://nats.kaeva.app:30640',
          workspace_id: 'ws-1',
          org_id: 'org-1',
          name: 'persona',
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

    expect(calls[0]?.url).toBe('https://auth.kaeva.app/v1/identity/enroll');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body['invite_code']).toBe('INV-1');
    expect(body['did']).toBe('did:key:z6Mkfake');
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
});

describe('http-substrate remember/query', () => {
  it('remember posts to /v1/remember and parses block_id', async () => {
    const { fetch } = makeFetch([
      new Response(JSON.stringify({ block_id: 'blk_x', stored_at: 't' }), { status: 200 }),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    const r = await client.remember({ content: 'hi' });
    expect(r.blockId).toBe('blk_x');
  });

  it('query GETs /v1/query and parses hits', async () => {
    const { fetch, calls } = makeFetch([
      new Response(JSON.stringify([{ block_id: 'b', score: 0.5, snippet: 's' }]), {
        status: 200,
      }),
    ]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    const hits = await client.query('q', { topK: 3 });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.blockId).toBe('b');
    expect(calls[0]?.url).toContain('top_k=3');
  });

  it('query throws SubstrateError on 5xx', async () => {
    const { fetch } = makeFetch([new Response('boom', { status: 500 })]);
    const factory = createHttpSubstrateFactory(fetch);
    const client = factory.create({ authUrl: 'https://auth.kaeva.app' });
    await expect(client.query('q')).rejects.toBeInstanceOf(SubstrateError);
  });
});
