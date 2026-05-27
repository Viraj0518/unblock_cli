import { describe, expect, it } from 'vitest';
import { runTrace } from '../../src/commands/trace.js';

// ─── happy path ───────────────────────────────────────────────────────────────

describe('runTrace happy path', () => {
  it('returns rows from audit_events, dispatch_traces, dispatch_rules', async () => {
    const auditRow = {
      created_at: '2026-05-27T10:00:00.000Z',
      action: 'remember',
      actor_did: 'did:key:z6MkTest',
      outcome: 'ok',
      payload: { block_id: 'blk_abc' },
    };
    const dispatchRow = {
      created_at: '2026-05-27T10:00:01.000Z',
      action: 'dispatch',
      actor_did: 'did:key:z6MkCoord',
      outcome: 'routed',
      context: { rule: 'default' },
    };

    const mockFetcher: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('audit_events')) {
        return new Response(JSON.stringify([auditRow]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (url.includes('dispatch_traces')) {
        return new Response(JSON.stringify([dispatchRow]), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      // dispatch_rules returns empty for this test
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await runTrace(
      { fetcher: mockFetcher },
      {
        id: 'corr-123',
        supabaseServiceRoleKey: 'test-key',
        supabaseUrl: 'https://example.supabase.co',
      },
    );

    expect(result.id).toBe('corr-123');
    expect(result.rows).toHaveLength(2);
    // Chronological order
    expect(result.rows[0]?.component).toBe('audit');
    expect(result.rows[1]?.component).toBe('dispatch');
  });
});

// ─── error path: missing service-role key ─────────────────────────────────────

describe('runTrace error path', () => {
  it('throws when SUPABASE_SERVICE_ROLE_KEY is not available', async () => {
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response('{}', { status: 200 });

    // Ensure env var is not set for this test
    const prev = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];

    try {
      await expect(
        runTrace({ fetcher: mockFetcher }, { id: 'some-id' }),
      ).rejects.toThrow(/SUPABASE_SERVICE_ROLE_KEY/);
    } finally {
      if (prev !== undefined) process.env['SUPABASE_SERVICE_ROLE_KEY'] = prev;
    }
  });
});

// ─── --json output shape ──────────────────────────────────────────────────────

describe('runTrace --json output shape', () => {
  it('each row has required fields', async () => {
    const mockFetcher: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('audit_events')) {
        return new Response(
          JSON.stringify([
            {
              created_at: '2026-05-27T10:00:00.000Z',
              action: 'query',
              actor_did: 'did:key:z6Mk',
              outcome: 'ok',
            },
          ]),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };

    const result = await runTrace(
      { fetcher: mockFetcher },
      { id: 'test-id', supabaseServiceRoleKey: 'sk', supabaseUrl: 'https://x.supabase.co' },
    );

    for (const row of result.rows) {
      expect(row).toHaveProperty('ts');
      expect(row).toHaveProperty('component');
      expect(row).toHaveProperty('action');
      expect(row).toHaveProperty('actorDid');
      expect(row).toHaveProperty('outcome');
      expect(row).toHaveProperty('payloadSnippet');
    }
  });
});

// ─── graceful degradation when tables don't exist ─────────────────────────────

describe('runTrace graceful degradation', () => {
  it('returns empty rows when all fetches fail (not throw)', async () => {
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response('not found', { status: 404 });

    const result = await runTrace(
      { fetcher: mockFetcher },
      { id: 'missing-id', supabaseServiceRoleKey: 'sk', supabaseUrl: 'https://x.supabase.co' },
    );

    // Should not throw; empty results are valid
    expect(result.rows).toHaveLength(0);
  });
});
