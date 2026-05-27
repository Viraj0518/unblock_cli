/**
 * `unblock invite --org <did> --role <role> [--expires-in-days N] [--json] [--persona NAME]`
 *
 * Mint an org invite code that another agent can redeem via `unblock login <code>`.
 *
 * Closes onboarding Gap A: previously the only way to enroll a fresh persona
 * was to `curl` the auth-issuer directly, which violates the "everything is
 * CLI" directive in the parent CLAUDE.md.
 *
 * Flow:
 *   1. Resolve persona dir (--persona NAME > UNBLOCK_HOME env > ~/.unblock).
 *   2. Read `<persona-dir>/comms-v3.creds`, extract the NATS User JWT.
 *   3. POST <authUrl>/v1/org/invite with `Authorization: Bearer <jwt>` and
 *      JSON body `{ org_id, role, expires_in_days? }`.
 *   4. Print invite_code + expires_at to stdout (or full JSON with --json).
 *
 * Auth-issuer endpoint consumed:
 *   POST <authUrl>/v1/org/invite
 *     headers: Authorization: Bearer <admin-jwt>
 *     body:    { org_id, role, expires_in_days }
 *     returns: { invite_code, role, expires_at, org_id }
 */

import path from 'node:path';
import { readFile } from 'node:fs/promises';
import {
  unblockHome,
  setPersonaDirOverride,
  personaHomeFor,
} from '../auth/persona-store.js';
import { extractJwtFromCreds } from '../auth/jwt.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

// ─── public API ──────────────────────────────────────────────────────────────

export interface InviteDeps {
  /** Injectable fetch for unit tests. Defaults to globalThis.fetch. */
  readonly fetcher?: typeof globalThis.fetch;
}

export type InviteRole = 'admin' | 'member' | 'guest';

export interface InviteOptions extends ConfigOverrides {
  /** Org DID to invite into (e.g. did:web:unblock.kaeva.app). Required. */
  readonly org: string;
  /** Role to grant the invitee. Required. */
  readonly role: InviteRole;
  /** Default 7, clamped to [1, 90]. */
  readonly expiresInDays?: number;
  /**
   * Persona NAME — routes auth from `~/.unblock-personas/<NAME>/comms-v3.creds`
   * instead of `~/.unblock/comms-v3.creds`. Sets a process-wide
   * `personaDirOverride` for the duration of the call.
   */
  readonly persona?: string;
}

export interface InviteResult {
  readonly inviteCode: string;
  readonly role: InviteRole;
  readonly expiresAt: string;
  readonly orgId: string;
  /**
   * Raw response body for `--json` printing. Includes any extra fields the
   * server may add (e.g. invite_url).
   */
  readonly raw: Record<string, unknown>;
}

// ─── implementation ──────────────────────────────────────────────────────────

const VALID_ROLES: readonly InviteRole[] = ['admin', 'member', 'guest'];
const MAX_EXPIRES_DAYS = 90;
const MIN_EXPIRES_DAYS = 1;
const DEFAULT_EXPIRES_DAYS = 7;

export async function runInvite(deps: InviteDeps, opts: InviteOptions): Promise<InviteResult> {
  const fetch = deps.fetcher ?? globalThis.fetch;

  // Validate required + role enum up front so callers get clean errors.
  const org = opts.org.trim();
  if (org === '') {
    throw new Error('invite: --org <org_did> is required');
  }
  if (!VALID_ROLES.includes(opts.role)) {
    throw new Error(
      `invite: --role must be one of ${VALID_ROLES.join(' | ')} (got "${String(opts.role)}")`,
    );
  }

  const expiresInDays = clampExpiresInDays(opts.expiresInDays ?? DEFAULT_EXPIRES_DAYS);

  // Persona routing: --persona NAME wins; otherwise the existing
  // UNBLOCK_HOME / ~/.unblock resolution applies. The override is reset
  // on the way out so concurrent callers don't observe stale state.
  const persona = opts.persona?.trim();
  const restoreOverride =
    persona !== undefined && persona !== ''
      ? withPersonaOverride(personaHomeFor(persona))
      : noop;

  try {
    const credsPath = path.join(unblockHome(), 'comms-v3.creds');
    const credsContent = await readCredsOrThrow(credsPath, persona);
    const jwt = extractJwtFromCreds(credsContent);
    if (jwt === null || jwt === '') {
      throw new Error(
        `invite: could not extract NATS User JWT from ${credsPath}. ` +
          'Run `unblock login <invite-code>` (or `unblock mint`) to refresh creds.',
      );
    }

    const cfg = await resolveConfig(opts);
    const authBase = cfg.authUrl.replace(/\/+$/, '');

    const body = {
      org_id: org,
      role: opts.role,
      expires_in_days: expiresInDays,
    };

    const res = await fetch(`${authBase}/v1/org/invite`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${jwt}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await safeJson(res);
      const { code, message } = extractError(errBody, res.status);
      throw new Error(`invite: ${code} ${message}`);
    }

    const raw: unknown = await res.json();
    return parseInviteResponse(raw, opts.role);
  } finally {
    restoreOverride();
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Clamp expires-in-days to [MIN_EXPIRES_DAYS, MAX_EXPIRES_DAYS]. Non-finite
 * inputs fall back to the default. This makes the CLI flag idiot-proof —
 * `--expires-in-days 9999` becomes 90 rather than a server-side rejection.
 */
export function clampExpiresInDays(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_EXPIRES_DAYS;
  const rounded = Math.floor(n);
  if (rounded < MIN_EXPIRES_DAYS) return MIN_EXPIRES_DAYS;
  if (rounded > MAX_EXPIRES_DAYS) return MAX_EXPIRES_DAYS;
  return rounded;
}

function parseInviteResponse(body: unknown, requestedRole: InviteRole): InviteResult {
  if (typeof body !== 'object' || body === null) {
    throw new Error('invite: /v1/org/invite response is not an object');
  }
  const b = body as Record<string, unknown>;

  const inviteCode =
    typeof b['invite_code'] === 'string'
      ? b['invite_code']
      : typeof b['inviteCode'] === 'string'
        ? b['inviteCode']
        : undefined;
  if (inviteCode === undefined || inviteCode === '') {
    throw new Error('invite: /v1/org/invite response missing invite_code');
  }

  const expiresAt =
    typeof b['expires_at'] === 'string'
      ? b['expires_at']
      : typeof b['expiresAt'] === 'string'
        ? b['expiresAt']
        : '';

  const role =
    typeof b['role'] === 'string' && VALID_ROLES.includes(b['role'] as InviteRole)
      ? (b['role'] as InviteRole)
      : requestedRole;

  const orgId =
    typeof b['org_id'] === 'string'
      ? b['org_id']
      : typeof b['orgId'] === 'string'
        ? b['orgId']
        : '';

  return {
    inviteCode,
    role,
    expiresAt,
    orgId,
    raw: b,
  };
}

async function readCredsOrThrow(credsPath: string, persona: string | undefined): Promise<string> {
  try {
    return await readFile(credsPath, 'utf-8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT') {
      const hint =
        persona !== undefined && persona !== ''
          ? `Run \`unblock login <code> --persona ${persona}\` first.`
          : 'Run `unblock login <code>` first.';
      throw new Error(`invite: no creds at ${credsPath}. ${hint}`);
    }
    throw err;
  }
}

interface ServerError {
  readonly code: string;
  readonly message: string;
}

function extractError(body: unknown, status: number): ServerError {
  if (typeof body === 'object' && body !== null) {
    const b = body as Record<string, unknown>;
    const errRaw = b['error'];
    if (typeof errRaw === 'object' && errRaw !== null) {
      const e = errRaw as Record<string, unknown>;
      const code = typeof e['code'] === 'string' ? e['code'] : `http_${String(status)}`;
      const message = typeof e['message'] === 'string' ? e['message'] : 'unknown error';
      return { code, message };
    }
    if (typeof b['code'] === 'string' && typeof b['message'] === 'string') {
      return { code: b['code'], message: b['message'] };
    }
  }
  return { code: `http_${String(status)}`, message: typeof body === 'string' ? body : 'unknown error' };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    try {
      return await res.text();
    } catch {
      return null;
    }
  }
}

/**
 * Set the persona dir override and return a restore-fn that clears it.
 * Wrapping the setter/restorer in a closure means the call site reads as
 * a try/finally pair without exposing the module-scoped state to the rest
 * of this command.
 */
function withPersonaOverride(dir: string): () => void {
  setPersonaDirOverride(dir);
  return () => setPersonaDirOverride(null);
}

function noop(): void {
  /* no override applied */
}
