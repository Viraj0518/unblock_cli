/**
 * `unblock mint [--persona NAME] [--ttl 30d] [--scope SCOPE] [--write|--print] [--json]`
 *
 * Re-mints fresh NATS credentials for a persona without a full invite-code flow.
 *
 * Flow:
 *   1. Resolve the current persona (from UNBLOCK_HOME or identity.json).
 *   2. Fetch MACAROON_ROOT_SECRET from MACAROON_ROOT_SECRET env or Supabase
 *      service-role API (unblock_app.app_secrets row).
 *   3. POST <authUrl>/v1/nats/token with { did, agent_name, ttl_seconds }.
 *   4. Receive { nats_creds, jwt_expires_at }.
 *   5. --write (default): write ~/.unblock/comms-v3.{creds,env} with LF endings.
 *      --print: dump JSON to stdout, skip writes.
 *
 * Max TTL = 30 days (2_592_000 seconds).
 * Known landmine: CRLF line endings break nkeys — always write LF (enforced here).
 *
 * Auth-issuer endpoints consumed:
 *   POST <authUrl>/v1/nats/token
 * Supabase endpoint consumed (optional, if MACAROON_ROOT_SECRET not in env):
 *   GET <SUPABASE_URL>/rest/v1/app_secrets?select=value&name=eq.macaroon_root_secret
 *     with Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY>
 */

import path from 'node:path';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  readIdentity,
  writeCommsCreds,
  writeCommsEnv,
  unblockHome,
  personaHomeFor,
} from '../auth/persona-store.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

// ─── public API ──────────────────────────────────────────────────────────────

export interface MintDeps {
  /**
   * Injectable fetch for unit tests. Defaults to globalThis.fetch.
   */
  readonly fetcher?: typeof globalThis.fetch;
  /** Injectable clock for test determinism. */
  readonly now?: () => number;
}

export interface MintOptions extends ConfigOverrides {
  /** Persona name override. Defaults to current persona. */
  readonly persona?: string;
  /**
   * TTL string: "30d", "1h", "2592000" (raw seconds). Defaults to "30d".
   * Max = 30d.
   */
  readonly ttl?: string;
  /**
   * When true, print JSON to stdout instead of writing files.
   * Default = false (write mode).
   */
  readonly print?: boolean;
  /** Supabase service-role key for fetching macaroon secret (optional). */
  readonly supabaseServiceRoleKey?: string;
  /** Supabase project URL (optional; falls back to SUPABASE_URL env). */
  readonly supabaseUrl?: string;
}

export interface MintResult {
  readonly persona: string;
  readonly did: string;
  readonly jwtExpiresAt: string;
  readonly ttlSeconds: number;
  /** Absolute path to the written creds file (undefined when --print). */
  readonly credsPath: string | undefined;
  /** Absolute path to the written env file (undefined when --print). */
  readonly envPath: string | undefined;
  /** Raw NATS creds string (always present). */
  readonly natsCreds: string;
}

// ─── implementation ──────────────────────────────────────────────────────────

const MAX_TTL_SECONDS = 2_592_000; // 30 days — hard cap
const MISSING_MACAROON_ROOT_SECRET_HINT =
  'MACAROON_ROOT_SECRET env var is not set. Export it and retry: `export MACAROON_ROOT_SECRET=<secret>; unblock mint ...`.';

export async function runMint(deps: MintDeps, opts: MintOptions): Promise<MintResult> {
  const fetch = deps.fetcher ?? globalThis.fetch;
  const cfg = await resolveConfig(opts);

  // 1. Resolve identity
  const identity = await readIdentity();
  if (identity === null) {
    throw new Error(
      'No persona found. Run `unblock login <invite-code>` first, or set UNBLOCK_HOME to a persona dir.',
    );
  }

  const personaName = opts.persona ?? identity.agentName;
  const ttlSeconds = parseTtl(opts.ttl ?? '30d');

  // 2. Resolve macaroon root secret
  const rootSecret = await resolveMacaroonRootSecret(opts, fetch);

  // 3. POST /v1/nats/token
  const authBase = cfg.authUrl.replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    did: identity.did,
    agent_name: personaName,
    ttl_seconds: ttlSeconds,
  };
  if (rootSecret !== undefined) {
    body['macaroon_root_secret'] = rootSecret;
  }

  const res = await fetch(`${authBase}/v1/nats/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await safeText(res);
    if (isMissingMacaroonRootSecretError(res.status, text)) {
      throw new Error(`mint: ${MISSING_MACAROON_ROOT_SECRET_HINT}`);
    }
    throw new Error(`mint: auth-issuer /v1/nats/token returned ${res.status}: ${text}`);
  }

  const raw: unknown = await res.json();
  const mintResp = parseMintResponse(raw);

  // 4. Write or print
  let credsPath: string | undefined;
  let envPath: string | undefined;

  if (opts.print !== true) {
    // Ensure persona dir exists for multi-persona layout
    const personaDir = personaHomeFor(personaName);
    await mkdir(personaDir, { recursive: true, mode: 0o700 });

    // Write creds with LF line endings (CRLF breaks nkeys — see landmines doc)
    const normalised = normaliseToLf(mintResp.natsCreds);
    const credsFile = path.join(personaDir, 'comms-v3.creds');
    await writeFile(credsFile, normalised, { mode: 0o600, encoding: 'utf-8' });
    credsPath = credsFile;

    // Write env
    const envFile = path.join(personaDir, 'comms-v3.env');
    const envContent = buildEnvContent(cfg.natsUrl, credsFile, cfg.workspaceId, cfg.orgId ?? '', personaName, mintResp.jwtExpiresAt);
    await writeFile(envFile, envContent, { mode: 0o600, encoding: 'utf-8' });
    envPath = envFile;

    // Also update the canonical ~/.unblock location if this persona matches
    if (personaDir === unblockHome()) {
      await writeCommsCreds(normalised);
      await writeCommsEnv({
        natsUrl: cfg.natsUrl,
        credsPath: credsFile,
        workspaceId: cfg.workspaceId,
        orgId: cfg.orgId ?? '',
        chatName: personaName,
        expiresAt: mintResp.jwtExpiresAt,
      });
    }
  }

  return {
    persona: personaName,
    did: identity.did,
    jwtExpiresAt: mintResp.jwtExpiresAt,
    ttlSeconds,
    credsPath,
    envPath,
    natsCreds: mintResp.natsCreds,
  };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Parse TTL string to seconds.
 * Accepts: "30d", "1h", "60m", "2592000" (raw number string), or a number.
 * Caps at MAX_TTL_SECONDS.
 */
export function parseTtl(ttl: string): number {
  const trimmed = ttl.trim();

  const units: Record<string, number> = {
    d: 86_400,
    h: 3_600,
    m: 60,
    s: 1,
  };

  for (const [suffix, factor] of Object.entries(units)) {
    if (trimmed.toLowerCase().endsWith(suffix)) {
      const n = Number.parseFloat(trimmed.slice(0, -1));
      if (!Number.isFinite(n) || n <= 0) break;
      const secs = Math.floor(n * factor);
      return Math.min(secs, MAX_TTL_SECONDS);
    }
  }

  // Raw seconds
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`mint: invalid --ttl "${ttl}". Use e.g. "30d", "1h", "2592000".`);
  }
  return Math.min(n, MAX_TTL_SECONDS);
}

function normaliseToLf(s: string): string {
  return s.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function buildEnvContent(
  natsUrl: string,
  credsPath: string,
  workspaceId: string,
  orgId: string,
  chatName: string,
  jwtExpiresAt: string,
): string {
  const lines = [
    '# UNBLOCK comms-v3 env (written by `unblock mint`)',
    `UNBLOCK_NATS_URL=${natsUrl}`,
    `UNBLOCK_NATS_CREDS=${credsPath}`,
    `UNBLOCK_WORKSPACE_ID=${workspaceId}`,
    `UNBLOCK_ORG_ID=${orgId}`,
    `UNBLOCK_CHAT_NAME=${chatName}`,
    `UNBLOCK_JWT_EXPIRES_AT=${jwtExpiresAt}`,
  ];
  return `${lines.join('\n')}\n`;
}

interface MintApiResponse {
  readonly natsCreds: string;
  readonly jwtExpiresAt: string;
}

function parseMintResponse(body: unknown): MintApiResponse {
  if (typeof body !== 'object' || body === null) {
    throw new Error('mint: /v1/nats/token response is not an object');
  }
  const b = body as Record<string, unknown>;

  // Accept nats_creds or natsCreds
  const natsCreds =
    typeof b['nats_creds'] === 'string'
      ? b['nats_creds']
      : typeof b['natsCreds'] === 'string'
        ? b['natsCreds']
        : undefined;
  if (natsCreds === undefined) {
    throw new Error('mint: /v1/nats/token response missing nats_creds');
  }

  // Accept jwt_expires_at or jwtExpiresAt
  const jwtExpiresAt =
    typeof b['jwt_expires_at'] === 'string'
      ? b['jwt_expires_at']
      : typeof b['jwtExpiresAt'] === 'string'
        ? b['jwtExpiresAt']
        : new Date(Date.now() + MAX_TTL_SECONDS * 1000).toISOString();

  return { natsCreds, jwtExpiresAt };
}

async function resolveMacaroonRootSecret(
  opts: MintOptions,
  fetch: typeof globalThis.fetch,
): Promise<string | undefined> {
  // Priority 1: direct env
  const fromEnv = process.env['MACAROON_ROOT_SECRET'];
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();

  // Priority 2: Supabase app_secrets
  const srvKey =
    opts.supabaseServiceRoleKey ??
    process.env['SUPABASE_SERVICE_ROLE_KEY'];
  if (srvKey === undefined || srvKey.trim() === '') {
    throw new Error(`mint: ${MISSING_MACAROON_ROOT_SECRET_HINT}`);
  }

  const supabaseUrl =
    opts.supabaseUrl ??
    process.env['SUPABASE_URL'] ??
    'https://wzqkolqxtmqdptwchrkl.supabase.co';

  const base = supabaseUrl.replace(/\/+$/, '');
  const res = await fetch(
    `${base}/rest/v1/app_secrets?select=value&name=eq.macaroon_root_secret`,
    {
      headers: {
        apikey: srvKey,
        authorization: `Bearer ${srvKey}`,
        accept: 'application/json',
      },
    },
  );

  if (!res.ok) return undefined;

  const rows: unknown = await res.json();
  if (!Array.isArray(rows) || rows.length === 0) return undefined;
  const first = rows[0] as Record<string, unknown>;
  if (typeof first['value'] !== 'string') return undefined;
  return first['value'];
}

function isMissingMacaroonRootSecretError(status: number, text: string): boolean {
  if (status !== 400) return false;
  const lower = text.toLowerCase();
  return lower.includes('macaroon') && (lower.includes('required') || lower.includes('missing'));
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}
