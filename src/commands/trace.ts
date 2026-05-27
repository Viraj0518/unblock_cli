/**
 * `unblock trace <correlation-id|message-id> [--json]`
 *
 * Pull full audit chain for a given ID across:
 *   1. unblock_app.audit_events (request_id, target_id, or envelope JSONB)
 *   2. unblock_app.dispatch_traces (coordinator dispatch rows)
 *   3. unblock_app.dispatch_rules (rules that fired)
 *
 * Returns a chronological table:
 *   ts | component | action | actor_did | outcome | payload-snippet
 *
 * --json: emit structured JSON array.
 *
 * Reads SUPABASE_SERVICE_ROLE_KEY from env or .env.demo.
 *
 * Auth endpoint consumed:
 *   GET <SUPABASE_URL>/rest/v1/<table>?...
 *   with apikey + Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export interface TraceDeps {
  readonly fetcher?: typeof globalThis.fetch;
}

export interface TraceOptions {
  /** The correlation-id or message-id to look up. */
  readonly id: string;
  readonly json?: boolean;
  /** Override Supabase project URL. */
  readonly supabaseUrl?: string;
  /** Override service-role key. */
  readonly supabaseServiceRoleKey?: string;
}

export interface TraceRow {
  readonly ts: string;
  readonly component: string;
  readonly action: string;
  readonly actorDid: string;
  readonly outcome: string;
  readonly payloadSnippet: string;
}

export interface TraceResult {
  readonly id: string;
  readonly rows: readonly TraceRow[];
}

export async function runTrace(deps: TraceDeps, opts: TraceOptions): Promise<TraceResult> {
  const fetch = deps.fetcher ?? globalThis.fetch;
  const { srvKey, supabaseBase } = await resolveSupabaseCreds(opts);

  if (srvKey === undefined) {
    throw new Error(
      'trace: SUPABASE_SERVICE_ROLE_KEY not found. ' +
        'Set SUPABASE_SERVICE_ROLE_KEY env or ensure it is in .env.demo.',
    );
  }

  const rows: TraceRow[] = [];

  // Parallel queries across all three tables
  const [auditRows, dispatchRows, ruleRows] = await Promise.all([
    fetchAuditEvents(fetch, supabaseBase, srvKey, opts.id),
    fetchDispatchTraces(fetch, supabaseBase, srvKey, opts.id),
    fetchDispatchRules(fetch, supabaseBase, srvKey, opts.id),
  ]);

  rows.push(...auditRows, ...dispatchRows, ...ruleRows);

  // Sort chronologically
  rows.sort((a, b) => a.ts.localeCompare(b.ts));

  return { id: opts.id, rows };
}

// ─── Supabase table fetchers ─────────────────────────────────────────────────

async function fetchAuditEvents(
  fetch: typeof globalThis.fetch,
  base: string,
  srvKey: string,
  id: string,
): Promise<TraceRow[]> {
  // Query by request_id or target_id (envelope JSONB search would require full-text or RPC;
  // we use the indexed scalar columns for now and fall through gracefully on 404/403).
  const encoded = encodeURIComponent(id);
  const url =
    `${base}/rest/v1/audit_events?or=(request_id.eq.${encoded},target_id.eq.${encoded})` +
    `&order=created_at.asc&limit=200`;

  const res = await safeFetch(fetch, url, supabaseHeaders(srvKey));
  if (res === null) return [];

  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];

  return (data as Array<Record<string, unknown>>).map((row): TraceRow => ({
    ts: strOr(row['created_at'], ''),
    component: 'audit',
    action: strOr(row['action'], strOr(row['verb'], '')),
    actorDid: strOr(row['actor_did'], strOr(row['did'], '')),
    outcome: strOr(row['outcome'], strOr(row['status'], '')),
    payloadSnippet: snippetOf(row['payload'] ?? row['metadata']),
  }));
}

async function fetchDispatchTraces(
  fetch: typeof globalThis.fetch,
  base: string,
  srvKey: string,
  id: string,
): Promise<TraceRow[]> {
  const encoded = encodeURIComponent(id);
  const url =
    `${base}/rest/v1/dispatch_traces?or=(correlation_id.eq.${encoded},message_id.eq.${encoded})` +
    `&order=created_at.asc&limit=200`;

  const res = await safeFetch(fetch, url, supabaseHeaders(srvKey));
  if (res === null) return [];

  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];

  return (data as Array<Record<string, unknown>>).map((row): TraceRow => ({
    ts: strOr(row['created_at'], ''),
    component: 'dispatch',
    action: strOr(row['action'], 'dispatch'),
    actorDid: strOr(row['actor_did'], strOr(row['coordinator_did'], '')),
    outcome: strOr(row['outcome'], strOr(row['status'], '')),
    payloadSnippet: snippetOf(row['payload'] ?? row['context']),
  }));
}

async function fetchDispatchRules(
  fetch: typeof globalThis.fetch,
  base: string,
  srvKey: string,
  id: string,
): Promise<TraceRow[]> {
  // dispatch_rules: look for the correlation_id in the json column `last_triggered_by`
  const encoded = encodeURIComponent(id);
  const url =
    `${base}/rest/v1/dispatch_rules?last_triggered_by.eq.${encoded}` +
    `&order=triggered_at.asc&limit=200`;

  const res = await safeFetch(fetch, url, supabaseHeaders(srvKey));
  if (res === null) return [];

  const data: unknown = await res.json();
  if (!Array.isArray(data)) return [];

  return (data as Array<Record<string, unknown>>).map((row): TraceRow => ({
    ts: strOr(row['triggered_at'], strOr(row['created_at'], '')),
    component: 'rule',
    action: strOr(row['rule_name'], strOr(row['name'], 'rule-fired')),
    actorDid: strOr(row['actor_did'], ''),
    outcome: strOr(row['outcome'], 'fired'),
    payloadSnippet: snippetOf(row['condition'] ?? row['payload']),
  }));
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function supabaseHeaders(srvKey: string): Record<string, string> {
  return {
    apikey: srvKey,
    authorization: `Bearer ${srvKey}`,
    accept: 'application/json',
  };
}

async function safeFetch(
  fetch: typeof globalThis.fetch,
  url: string,
  headers: Record<string, string>,
): Promise<Response | null> {
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) return null;
    return res;
  } catch {
    return null;
  }
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === 'string' ? v : fallback;
}

function snippetOf(v: unknown): string {
  if (v === undefined || v === null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 120 ? `${s.slice(0, 119)}…` : s;
}

async function resolveSupabaseCreds(opts: TraceOptions): Promise<{
  srvKey: string | undefined;
  supabaseBase: string;
}> {
  // Priority 1: explicit opts
  if (opts.supabaseServiceRoleKey !== undefined) {
    const base = (opts.supabaseUrl ?? 'https://wzqkolqxtmqdptwchrkl.supabase.co').replace(/\/+$/, '');
    return { srvKey: opts.supabaseServiceRoleKey, supabaseBase: base };
  }

  // Priority 2: env
  const fromEnv = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const base = (
      opts.supabaseUrl ??
      process.env['SUPABASE_URL'] ??
      'https://wzqkolqxtmqdptwchrkl.supabase.co'
    ).replace(/\/+$/, '');
    return { srvKey: fromEnv.trim(), supabaseBase: base };
  }

  // Priority 3: .env.demo in cwd or home
  const candidates = [
    path.join(process.cwd(), '.env.demo'),
    path.join(os.homedir(), '.env.demo'),
  ];
  for (const p of candidates) {
    const parsed = await parseEnvFile(p);
    if (parsed !== null) {
      const srvKey = parsed.get('SUPABASE_SERVICE_ROLE_KEY');
      const supabaseBase = (
        opts.supabaseUrl ??
        parsed.get('SUPABASE_URL') ??
        'https://wzqkolqxtmqdptwchrkl.supabase.co'
      ).replace(/\/+$/, '');
      if (srvKey !== undefined) return { srvKey, supabaseBase };
    }
  }

  const base = (opts.supabaseUrl ?? 'https://wzqkolqxtmqdptwchrkl.supabase.co').replace(/\/+$/, '');
  return { srvKey: undefined, supabaseBase: base };
}

async function parseEnvFile(p: string): Promise<Map<string, string> | null> {
  try {
    const raw = await readFile(p, 'utf-8');
    const map = new Map<string, string>();
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq < 0) continue;
      const k = trimmed.slice(0, eq).trim();
      const v = trimmed
        .slice(eq + 1)
        .trim()
        .replace(/^["']|["']$/g, '');
      map.set(k, v);
    }
    return map;
  } catch {
    return null;
  }
}
