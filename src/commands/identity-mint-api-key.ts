/**
 * `unblock identity mint-api-key [--persona X] [--json] [--force]`
 *
 * Kink #136 backfill for pre-W1e personas. Pre-existing personas minted
 * before PR #11/#329 (api-key-on-enroll) have NATS creds but NO
 * `UNBLOCK_API_KEY` in their `comms-v3.env`. Result: every substrate verb
 * (remember/query/share/list/...) 401s with `X-API-Key required`.
 *
 * Today's workaround = manual DB insert + `echo UNBLOCK_API_KEY=... >> env`.
 * This verb automates it idempotently.
 *
 * Flow:
 *   1. Read persona identity.json (DID) + comms-v3.env (org_did + existing key).
 *   2. If UNBLOCK_API_KEY already set and not --force, exit 2.
 *   3. Mint `unb_<64hex>` (CSPRNG, matches PR #329 server-side shape).
 *   4. Compute sha256 of raw key.
 *   5. INSERT public.members row (FK target for api_keys.owner_did),
 *      idempotent via PostgREST `Prefer: resolution=ignore-duplicates`.
 *   6. INSERT public.api_keys row with the new key_sha256.
 *   7. Rewrite comms-v3.env preserving other lines, replacing or appending
 *      `UNBLOCK_API_KEY=unb_<key>`.
 *
 * Fallback: when SUPABASE_SERVICE_ROLE_KEY is unavailable we print the two
 * `INSERT ... ON CONFLICT` statements to stdout so an operator can run them
 * against the project directly. The local env file is NOT touched in that
 * mode — we don't want a key live in env that the server has never seen.
 *
 * Exit codes:
 *   0  minted (or SQL printed in fallback mode)
 *   1  error (no identity / no env / network / 4xx / 5xx)
 *   2  already has UNBLOCK_API_KEY, no --force
 */

import { randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  readCommsEnv,
  readIdentity,
  v3EnvPath,
} from '../auth/persona-store.js';

export interface MintApiKeyDeps {
  readonly fetcher?: typeof globalThis.fetch;
  /** Inject CSPRNG for deterministic tests. Returns 32 random bytes. */
  readonly randomBytes32?: () => Buffer;
}

export interface MintApiKeyOptions {
  /** Cosmetic — persona dir routing happens via persona-store override. */
  readonly persona?: string;
  /** Overwrite an existing UNBLOCK_API_KEY line (does NOT revoke the old key server-side). */
  readonly force?: boolean;
  /** JSON output toggle (caller handles formatting). */
  readonly json?: boolean;
  /** Override Supabase project URL. */
  readonly supabaseUrl?: string;
  /** Override service-role key. */
  readonly supabaseServiceRoleKey?: string;
}

export type MintApiKeyAction = 'minted' | 'already_present' | 'sql_only';

export interface MintApiKeyResult {
  readonly persona: string;
  readonly did: string;
  readonly orgDid: string;
  readonly apiKeyId: string;
  readonly envPath: string;
  readonly action: MintApiKeyAction;
  /** Present only when action='sql_only' — the SQL we would have run. */
  readonly sql?: string;
  /** Present only when action='minted' — the raw key (printed once). */
  readonly apiKey?: string;
}

/**
 * Symbolic exit codes — callers map these to process.exitCode.
 * Kept as a typed object (not enum) to play nice with the project's
 * isolatedModules + verbatimModuleSyntax settings.
 */
export const MINT_API_KEY_EXIT = {
  ok: 0,
  error: 1,
  already_present: 2,
} as const;

export class AlreadyPresentError extends Error {
  constructor(readonly envPath: string) {
    super(
      `identity mint-api-key: UNBLOCK_API_KEY already present in ${envPath} — re-run with --force to stage a new one (does not revoke the old key)`,
    );
    this.name = 'AlreadyPresentError';
  }
}

export async function runMintApiKey(
  deps: MintApiKeyDeps,
  opts: MintApiKeyOptions = {},
): Promise<MintApiKeyResult> {
  const fetcher = deps.fetcher ?? globalThis.fetch;
  const rng = deps.randomBytes32 ?? (() => randomBytes(32));

  const persona = opts.persona?.trim() ?? '';

  const identity = await readIdentity();
  if (identity === null) {
    throw new Error(
      `identity mint-api-key: no identity.json under the resolved persona dir. Run \`unblock login <invite-code>${persona === '' ? '' : ` --persona ${persona}`}\` first.`,
    );
  }
  const env = await readCommsEnv();
  if (env === null) {
    throw new Error(
      `identity mint-api-key: no comms-v3.env at ${v3EnvPath()}. Run \`unblock login <invite-code>${persona === '' ? '' : ` --persona ${persona}`}\` first.`,
    );
  }

  const envPath = v3EnvPath();

  // Idempotency guard — without --force we refuse to overwrite an
  // existing key (could be the live one the user is auth'd with).
  if (env.apiKey !== undefined && env.apiKey !== '' && opts.force !== true) {
    throw new AlreadyPresentError(envPath);
  }

  // Mint the raw key. PR #329 server-side shape: `unb_` + 64 lowercase hex
  // chars (32 bytes of CSPRNG). Matches what the auth-issuer returns from
  // enrollment so the audit shape lines up across both code paths.
  const keyBytes = rng();
  const rawHex = bufToHex(keyBytes);
  const apiKey = `unb_${rawHex}`;
  const keySha256 = sha256Hex(apiKey);
  const apiKeyId = `akey_backfill_${rawHex.slice(0, 16)}`;
  const displayName = 'manual backfill via mint-api-key';

  const sql = buildSql({
    orgDid: env.orgId,
    did: identity.did,
    agentName: identity.agentName,
    apiKeyId,
    keySha256,
    displayName,
  });

  const supabaseCreds = await resolveSupabaseCreds(opts);

  // Fallback path: no service-role key locally. Don't write the env file
  // because the server has never seen this key. Print the SQL so the
  // operator can run it from a workstation that does have the key.
  if (supabaseCreds.srvKey === undefined) {
    return {
      persona,
      did: identity.did,
      orgDid: env.orgId,
      apiKeyId,
      envPath,
      action: 'sql_only',
      sql,
    };
  }

  // Live path. Insert the members row first (FK target for api_keys),
  // then the api_keys row, then rewrite the env file. Both inserts use
  // PostgREST `Prefer: resolution=ignore-duplicates` so re-runs against
  // a partially-applied state succeed.
  const authedCreds = { srvKey: supabaseCreds.srvKey, base: supabaseCreds.base };
  await insertMember(fetcher, authedCreds, {
    memberDid: identity.did,
    orgDid: env.orgId,
    displayName: identity.agentName,
  });
  await insertApiKey(fetcher, authedCreds, {
    apiKeyId,
    orgDid: env.orgId,
    ownerDid: identity.did,
    keySha256,
    displayName,
  });

  await rewriteEnvWithApiKey(envPath, apiKey);

  return {
    persona,
    did: identity.did,
    orgDid: env.orgId,
    apiKeyId,
    envPath,
    action: 'minted',
    apiKey,
  };
}

// ─── output formatting ───────────────────────────────────────────────────────

export function formatMintApiKey(result: MintApiKeyResult): string {
  if (result.action === 'already_present') {
    // Caller path: AlreadyPresentError thrown → main.ts handles. Kept for
    // structural completeness — runMintApiKey itself never returns this.
    return `UNBLOCK_API_KEY already present (${result.envPath})\n`;
  }
  if (result.action === 'sql_only') {
    return (
      `SUPABASE_SERVICE_ROLE_KEY not available — printing SQL for manual operator run.\n` +
      `Run this against the unblock_app project, then \`unblock identity mint-api-key ${result.persona === '' ? '' : `--persona ${result.persona} `}--force\` from a workstation with the key:\n\n` +
      `${result.sql ?? ''}\n`
    );
  }
  const lines: string[] = [
    `minted api key for ${result.persona === '' ? result.did : result.persona}`,
    `  did:        ${result.did}`,
    `  org:        ${result.orgDid}`,
    `  api_key_id: ${result.apiKeyId}`,
    `  env:        ${result.envPath}`,
    `  api_key:    ${result.apiKey ?? ''}  (shown once — already persisted to env)`,
  ];
  return `${lines.join('\n')}\n`;
}

// ─── SQL fallback ────────────────────────────────────────────────────────────

function buildSql(input: {
  readonly orgDid: string;
  readonly did: string;
  readonly agentName: string;
  readonly apiKeyId: string;
  readonly keySha256: string;
  readonly displayName: string;
}): string {
  // Conservative defaults for required-NOT-NULL columns we don't know:
  // kind='agent', status='active'. These match the on-enroll values used
  // by the auth-issuer for agent personas.
  const memberDisplay = sqlEscape(input.agentName);
  const apiKeyDisplay = sqlEscape(input.displayName);
  return [
    `-- members FK target for api_keys.owner_did`,
    `INSERT INTO public.members (member_did, org_did, kind, display_name, status)`,
    `VALUES ('${input.did}', '${input.orgDid}', 'agent', '${memberDisplay}', 'active')`,
    `ON CONFLICT (member_did) DO NOTHING;`,
    ``,
    `-- the api key itself`,
    `INSERT INTO public.api_keys (api_key_id, org_did, owner_did, key_sha256, display_name, is_root, purpose)`,
    `VALUES ('${input.apiKeyId}', '${input.orgDid}', '${input.did}', '${input.keySha256}', '${apiKeyDisplay}', false, 'agent')`,
    `ON CONFLICT (key_sha256) DO NOTHING;`,
  ].join('\n');
}

function sqlEscape(s: string): string {
  return s.replace(/'/g, "''");
}

// ─── Supabase REST inserts ───────────────────────────────────────────────────

interface SupabaseCreds {
  readonly srvKey: string | undefined;
  readonly base: string;
}

async function insertMember(
  fetch: typeof globalThis.fetch,
  creds: { readonly srvKey: string; readonly base: string },
  input: {
    readonly memberDid: string;
    readonly orgDid: string;
    readonly displayName: string;
  },
): Promise<void> {
  const url = `${creds.base}/rest/v1/members`;
  const body = [
    {
      member_did: input.memberDid,
      org_did: input.orgDid,
      kind: 'agent',
      display_name: input.displayName,
      status: 'active',
    },
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(creds.srvKey),
      'content-type': 'application/json',
      // resolution=ignore-duplicates → PostgREST treats unique conflicts
      // (PK + unique constraints) as no-op success. return=minimal so we
      // don't have to parse a body — we already have everything we need.
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await readText(res);
    throw new Error(
      `identity mint-api-key: failed to upsert members row for ${input.memberDid} (status ${String(res.status)}): ${text}`,
    );
  }
}

async function insertApiKey(
  fetch: typeof globalThis.fetch,
  creds: { readonly srvKey: string; readonly base: string },
  input: {
    readonly apiKeyId: string;
    readonly orgDid: string;
    readonly ownerDid: string;
    readonly keySha256: string;
    readonly displayName: string;
  },
): Promise<void> {
  const url = `${creds.base}/rest/v1/api_keys`;
  const body = [
    {
      api_key_id: input.apiKeyId,
      org_did: input.orgDid,
      owner_did: input.ownerDid,
      key_sha256: input.keySha256,
      display_name: input.displayName,
      is_root: false,
      purpose: 'agent',
    },
  ];
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      ...supabaseHeaders(creds.srvKey),
      'content-type': 'application/json',
      Prefer: 'resolution=ignore-duplicates,return=minimal',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await readText(res);
    throw new Error(
      `identity mint-api-key: failed to insert api_keys row ${input.apiKeyId} (status ${String(res.status)}): ${text}`,
    );
  }
}

function supabaseHeaders(srvKey: string): Record<string, string> {
  return {
    apikey: srvKey,
    authorization: `Bearer ${srvKey}`,
    accept: 'application/json',
  };
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// ─── env-file rewriter (idempotent UNBLOCK_API_KEY line) ─────────────────────

async function rewriteEnvWithApiKey(envPath: string, apiKey: string): Promise<void> {
  const raw = await readFile(envPath, 'utf-8');
  await writeFile(envPath, replaceOrAppendApiKey(raw, apiKey), { mode: 0o600 });
}

/**
 * Idempotent UNBLOCK_API_KEY edit:
 *   - if a line `UNBLOCK_API_KEY=...` exists (any spacing/quoting), replace it
 *   - else append `UNBLOCK_API_KEY=<value>\n` preserving trailing newline shape
 *
 * Preserves CRLF / LF line endings on the unmodified lines so we don't
 * accidentally rewrite the whole file's encoding on Windows.
 */
export function replaceOrAppendApiKey(raw: string, apiKey: string): string {
  const parts = raw.split(/(\r\n|\n|\r)/);
  let replaced = false;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i] ?? '';
    if (/^\s*UNBLOCK_API_KEY\s*=/.test(line)) {
      parts[i] = `UNBLOCK_API_KEY=${apiKey}`;
      replaced = true;
      break;
    }
  }
  if (replaced) return parts.join('');

  const eol = detectEol(raw);
  const sep = raw.length > 0 && !raw.endsWith('\n') && !raw.endsWith('\r') ? eol : '';
  return `${raw}${sep}UNBLOCK_API_KEY=${apiKey}${eol}`;
}

function detectEol(raw: string): string {
  if (raw.includes('\r\n')) return '\r\n';
  if (raw.includes('\n')) return '\n';
  return '\n';
}

// ─── creds resolution (mirrors trace.ts) ─────────────────────────────────────

async function resolveSupabaseCreds(opts: MintApiKeyOptions): Promise<SupabaseCreds> {
  if (opts.supabaseServiceRoleKey !== undefined && opts.supabaseServiceRoleKey.trim() !== '') {
    const base = (opts.supabaseUrl ?? 'https://wzqkolqxtmqdptwchrkl.supabase.co').replace(/\/+$/, '');
    return { srvKey: opts.supabaseServiceRoleKey.trim(), base };
  }
  const fromEnv = process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') {
    const supabaseUrlEnv = process.env['SUPABASE_URL'];
    const base = (
      opts.supabaseUrl ??
      (supabaseUrlEnv !== undefined && supabaseUrlEnv.trim() !== ''
        ? supabaseUrlEnv
        : 'https://wzqkolqxtmqdptwchrkl.supabase.co')
    ).replace(/\/+$/, '');
    return { srvKey: fromEnv.trim(), base };
  }
  // .env.demo fallback (matches trace.ts pattern so operators don't have
  // to maintain a second creds-discovery mechanism).
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
      if (srvKey !== undefined && srvKey.trim() !== '') {
        return { srvKey: srvKey.trim(), base: supabaseBase };
      }
    }
  }
  const base = (opts.supabaseUrl ?? 'https://wzqkolqxtmqdptwchrkl.supabase.co').replace(/\/+$/, '');
  return { srvKey: undefined, base };
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

// ─── crypto helpers ──────────────────────────────────────────────────────────

function bufToHex(buf: Buffer): string {
  return buf.toString('hex');
}

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf-8').digest('hex');
}
