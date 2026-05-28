/**
 * `unblock health [--component all|auth|broker|substrate|audit] [--json] [--strict]`
 *
 * Synthetic health check across UNBLOCK service components.
 *
 * Components:
 *   auth      — GET https://auth.kaeva.app/health → expect 200
 *   broker    — TLS connect to tls://nats.kaeva.app:39899 with current creds → connected
 *   substrate — POST /v1/query with trivial query → expect 200
 *   audit     — SELECT count(*) FROM unblock_app.audit_events WHERE ran_at > now()-5min
 *               via Supabase REST → count >= 0 and no error
 *   all       — run all 4 in parallel (default)
 *
 * Output table: component | status | latency_ms | reason | last_error
 * --json: structured object with overall_status, components, and subjects.
 *
 * Exit 0 if the overall status is "ok" or "degraded".
 * Exit 1 if the overall status is "down".
 * --strict restores legacy behavior: exit 1 on "degraded" or "down".
 *
 * Endpoints consumed:
 *   GET  https://auth.kaeva.app/health
 *   TLS  tls://nats.kaeva.app:39899 (NATS connect)
 *   POST <substrateUrl>/v1/query
 *   GET  <SUPABASE_URL>/rest/v1/audit_events?select=count&...
 */

import type { CommsFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';
import { DEFAULT_AUTH_URL, DEFAULT_SUBSTRATE_URL } from '../sdk/http-substrate.js';
import { buildSubjectSummary, type SubjectSummary } from './subjects.js';

export type ComponentName = 'auth' | 'broker' | 'substrate' | 'audit';
export type HealthStatus = 'ok' | 'degraded' | 'down';
export type HealthReason =
  | 'ok'
  | 'not-configured'
  | 'http-error'
  | 'connection-error';

export interface ComponentHealth {
  readonly component: ComponentName;
  readonly status: HealthStatus;
  readonly reason: HealthReason;
  readonly latencyMs: number;
  readonly lastError: string | undefined;
}

export interface HealthDeps {
  readonly commsFactory: CommsFactory;
  readonly fetcher?: typeof globalThis.fetch;
  readonly now?: () => number;
}

export interface HealthOptions extends ConfigOverrides {
  readonly component?: ComponentName | 'all';
  /** Supabase service-role key for audit check. */
  readonly supabaseServiceRoleKey?: string;
  readonly supabaseUrl?: string;
  /** Emit JSON. */
  readonly json?: boolean;
  /** Exit non-zero on degraded checks as well as down checks. */
  readonly strict?: boolean;
}

export interface HealthResult {
  readonly components: readonly ComponentHealth[];
  readonly subjects: SubjectSummary;
  readonly overallStatus: HealthStatus;
  readonly allOk: boolean;
  readonly shouldExitNonZero: boolean;
}

export async function runHealth(deps: HealthDeps, opts: HealthOptions): Promise<HealthResult> {
  const fetch = deps.fetcher ?? globalThis.fetch;
  const getNow = deps.now ?? Date.now;
  const cfg = await resolveConfig(opts);

  const which = opts.component ?? 'all';

  const checks: ComponentName[] =
    which === 'all'
      ? ['auth', 'broker', 'substrate', 'audit']
      : [which];

  const results = await Promise.all(
    checks.map((c) => runCheck(c, deps, opts, cfg, fetch, getNow)),
  );

  const overallStatus = computeOverallStatus(results);
  return {
    components: results,
    subjects: buildSubjectSummary({
      workspaceId: cfg.workspaceId,
      chatName: cfg.chatName ?? 'me',
    }),
    overallStatus,
    allOk: overallStatus === 'ok',
    shouldExitNonZero: overallStatus === 'down' || (opts.strict === true && overallStatus === 'degraded'),
  };
}

function computeOverallStatus(results: readonly ComponentHealth[]): HealthStatus {
  if (results.some((r) => r.status === 'down')) return 'down';
  if (results.some((r) => r.status === 'degraded')) return 'degraded';
  return 'ok';
}

// ─── individual checks ────────────────────────────────────────────────────────

async function runCheck(
  component: ComponentName,
  deps: HealthDeps,
  opts: HealthOptions,
  cfg: Awaited<ReturnType<typeof resolveConfig>>,
  fetch: typeof globalThis.fetch,
  getNow: () => number,
): Promise<ComponentHealth> {
  const t0 = getNow();
  try {
    switch (component) {
      case 'auth':
        return await checkAuth(fetch, cfg.authUrl, getNow, t0);
      case 'broker':
        return await checkBroker(
          deps.commsFactory,
          { natsUrl: cfg.natsUrl, credsPath: cfg.credsPath !== undefined ? cfg.credsPath : undefined },
          getNow,
          t0,
        );
      case 'substrate':
        return await checkSubstrate(
          fetch,
          { substrateUrl: cfg.substrateUrl, apiKey: cfg.apiKey !== undefined ? cfg.apiKey : undefined },
          getNow,
          t0,
        );
      case 'audit':
        return await checkAudit(fetch, opts, getNow, t0);
    }
  } catch (err) {
    return {
      component,
      status: 'down',
      reason: 'connection-error',
      latencyMs: getNow() - t0,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkAuth(
  fetch: typeof globalThis.fetch,
  authUrl: string,
  getNow: () => number,
  t0: number,
): Promise<ComponentHealth> {
  const base = authUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(8000),
    });
    const latencyMs = getNow() - t0;
    if (res.ok) {
      return { component: 'auth', status: 'ok', reason: 'ok', latencyMs, lastError: undefined };
    }
    return {
      component: 'auth',
      status: 'down',
      reason: 'http-error',
      latencyMs,
      lastError: `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      component: 'auth',
      status: 'down',
      reason: 'connection-error',
      latencyMs: getNow() - t0,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkBroker(
  factory: CommsFactory,
  cfg: { natsUrl: string; credsPath: string | undefined },
  getNow: () => number,
  t0: number,
): Promise<ComponentHealth> {
  try {
    const client = await factory.connect({
      url: cfg.natsUrl,
      ...(cfg.credsPath !== undefined ? { credsPath: cfg.credsPath } : {}),
    });
    await client.flush();
    await client.close();
    const latencyMs = getNow() - t0;
    return { component: 'broker', status: 'ok', reason: 'ok', latencyMs, lastError: undefined };
  } catch (err) {
    return {
      component: 'broker',
      status: 'down',
      reason: 'connection-error',
      latencyMs: getNow() - t0,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkSubstrate(
  fetch: typeof globalThis.fetch,
  cfg: { substrateUrl: string; apiKey: string | undefined },
  getNow: () => number,
  t0: number,
): Promise<ComponentHealth> {
  const base = cfg.substrateUrl.replace(/\/+$/, '');
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
  };
  if (cfg.apiKey !== undefined) headers['x-api-key'] = cfg.apiKey;

  try {
    const res = await fetch(`${base}/v1/query`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ text: 'health check ping', top_k: 1 }),
      signal: AbortSignal.timeout(10000),
    });
    const latencyMs = getNow() - t0;
    if (res.ok) {
      return { component: 'substrate', status: 'ok', reason: 'ok', latencyMs, lastError: undefined };
    }
    // Any HTTP 4xx/5xx from the substrate is a hard health failure.
    return {
      component: 'substrate',
      status: 'down',
      reason: 'http-error',
      latencyMs,
      lastError: `HTTP ${res.status}`,
    };
  } catch (err) {
    return {
      component: 'substrate',
      status: 'down',
      reason: 'connection-error',
      latencyMs: getNow() - t0,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

async function checkAudit(
  fetch: typeof globalThis.fetch,
  opts: HealthOptions,
  getNow: () => number,
  t0: number,
): Promise<ComponentHealth> {
  const srvKey =
    opts.supabaseServiceRoleKey ??
    process.env['SUPABASE_SERVICE_ROLE_KEY'];

  if (srvKey === undefined || srvKey.trim() === '') {
    // Soft degraded — not configured, but not a hard failure
    return {
      component: 'audit',
      status: 'degraded',
      reason: 'not-configured',
      latencyMs: getNow() - t0,
      lastError: 'SUPABASE_SERVICE_ROLE_KEY not set; audit check skipped',
    };
  }

  const supabaseBase = (
    opts.supabaseUrl ??
    process.env['SUPABASE_URL'] ??
    'https://wzqkolqxtmqdptwchrkl.supabase.co'
  ).replace(/\/+$/, '');

  try {
    const url =
      `${supabaseBase}/rest/v1/audit_events` +
      `?select=count&ran_at=gte.${encodeURIComponent(new Date(Date.now() - 300_000).toISOString())}` +
      `&limit=1`;

    const res = await fetch(url, {
      headers: {
        apikey: srvKey,
        authorization: `Bearer ${srvKey}`,
        accept: 'application/json',
        prefer: 'count=exact',
      },
      signal: AbortSignal.timeout(8000),
    });

    const latencyMs = getNow() - t0;

    // 404 just means the table doesn't exist yet — degrade not down
    if (!res.ok) {
      return {
        component: 'audit',
        status: 'down',
        reason: 'http-error',
        latencyMs,
        lastError: `HTTP ${res.status}`,
      };
    }

    // 0 rows is still ok (no recent events != system down)
    return { component: 'audit', status: 'ok', reason: 'ok', latencyMs, lastError: undefined };
  } catch (err) {
    return {
      component: 'audit',
      status: 'down',
      reason: 'connection-error',
      latencyMs: getNow() - t0,
      lastError: err instanceof Error ? err.message : String(err),
    };
  }
}

// Re-export defaults so main.ts can use them without importing from http-substrate
export { DEFAULT_AUTH_URL, DEFAULT_SUBSTRATE_URL };
