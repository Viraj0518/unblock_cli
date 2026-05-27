import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runHealth } from '../../src/commands/health.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import { createMockCommsFactory } from '../_fixtures/mock-comms.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
  await writeCommsEnv({
    natsUrl: 'tls://nats.kaeva.app:39899',
    credsPath: '/p',
    workspaceId: 'ws-default',
    orgId: 'org',
    chatName: 'Viraj-Alpha',
  });
});
afterEach(async () => {
  await tmp.dispose();
});

// ─── auth component ───────────────────────────────────────────────────────────

describe('runHealth --component auth', () => {
  it('reports ok when auth /health returns 200', async () => {
    const { factory } = createMockCommsFactory();
    const mockFetcher: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/health')) {
        return new Response(JSON.stringify({ status: 'ok' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    };

    const result = await runHealth(
      { commsFactory: factory, fetcher: mockFetcher, now: Date.now },
      { component: 'auth' },
    );

    expect(result.components).toHaveLength(1);
    expect(result.components[0]?.component).toBe('auth');
    expect(result.components[0]?.status).toBe('ok');
    expect(result.allOk).toBe(true);
  });

  it('reports down when auth /health returns 500', async () => {
    const { factory } = createMockCommsFactory();
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response('error', { status: 500 });

    const result = await runHealth(
      { commsFactory: factory, fetcher: mockFetcher },
      { component: 'auth' },
    );

    expect(result.components[0]?.status).toBe('degraded');
    expect(result.allOk).toBe(false);
  });
});

// ─── substrate component ──────────────────────────────────────────────────────

describe('runHealth --component substrate', () => {
  it('reports ok when substrate /v1/query returns 200', async () => {
    const { factory } = createMockCommsFactory();
    const mockFetcher: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/v1/query')) {
        return new Response(JSON.stringify({ hits: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    };

    const result = await runHealth(
      { commsFactory: factory, fetcher: mockFetcher },
      { component: 'substrate' },
    );

    expect(result.components[0]?.status).toBe('ok');
    expect(result.allOk).toBe(true);
  });

  it('reports degraded on 401 (reachable but no key)', async () => {
    const { factory } = createMockCommsFactory();
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response('{"error":"AUTH_MISSING"}', { status: 401 });

    const result = await runHealth(
      { commsFactory: factory, fetcher: mockFetcher },
      { component: 'substrate' },
    );

    expect(result.components[0]?.status).toBe('degraded');
  });
});

// ─── audit component ──────────────────────────────────────────────────────────

describe('runHealth --component audit', () => {
  it('reports degraded when SUPABASE_SERVICE_ROLE_KEY not set', async () => {
    const { factory } = createMockCommsFactory();
    const prev = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];

    try {
      const result = await runHealth(
        { commsFactory: factory, fetcher: async () => new Response('{}', { status: 200 }) },
        { component: 'audit' },
      );
      expect(result.components[0]?.status).toBe('degraded');
      expect(result.components[0]?.lastError).toMatch(/SUPABASE_SERVICE_ROLE_KEY/);
    } finally {
      if (prev !== undefined) process.env['SUPABASE_SERVICE_ROLE_KEY'] = prev;
    }
  });

  it('reports ok when audit_events query succeeds', async () => {
    const { factory } = createMockCommsFactory();
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response(JSON.stringify([{ count: '5' }]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });

    const result = await runHealth(
      { commsFactory: factory, fetcher: mockFetcher },
      {
        component: 'audit',
        supabaseServiceRoleKey: 'sk-test',
        supabaseUrl: 'https://x.supabase.co',
      },
    );
    expect(result.components[0]?.status).toBe('ok');
  });
});

// ─── all components in parallel ───────────────────────────────────────────────

describe('runHealth --component all', () => {
  it('runs all 4 checks and reports per-component', async () => {
    const { factory } = createMockCommsFactory();
    // Mock: auth ok, substrate ok, audit ok, broker connect ok
    const mockFetcher: typeof globalThis.fetch = async (input) => {
      const url = typeof input === 'string' ? input : String(input);
      if (url.includes('/health')) {
        return new Response('{}', { status: 200 });
      }
      if (url.includes('/v1/query')) {
        return new Response(JSON.stringify({ hits: [] }), { status: 200 });
      }
      return new Response(JSON.stringify([{ count: '1' }]), { status: 200 });
    };

    const result = await runHealth(
      { commsFactory: factory, fetcher: mockFetcher },
      {
        supabaseServiceRoleKey: 'sk-test',
        supabaseUrl: 'https://x.supabase.co',
      },
    );

    expect(result.components).toHaveLength(4);
    const names = result.components.map((c) => c.component);
    expect(names).toContain('auth');
    expect(names).toContain('broker');
    expect(names).toContain('substrate');
    expect(names).toContain('audit');
  });
});

// ─── --json output shape ──────────────────────────────────────────────────────

describe('runHealth --json output shape', () => {
  it('each component has required fields', async () => {
    const { factory } = createMockCommsFactory();
    const mockFetcher: typeof globalThis.fetch = async () =>
      new Response('{}', { status: 200 });

    const result = await runHealth(
      { commsFactory: factory, fetcher: mockFetcher },
      { component: 'auth' },
    );

    for (const c of result.components) {
      expect(c).toHaveProperty('component');
      expect(c).toHaveProperty('status');
      expect(c).toHaveProperty('latencyMs');
      expect(c).toHaveProperty('lastError');
    }
  });
});
