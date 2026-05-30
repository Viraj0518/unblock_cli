/**
 * Persona store — `~/.unblock/identity.json` + `~/.unblock/comms-v3.{creds,env}`.
 *
 * Layout (per parent CLAUDE.md §"One-time bootstrap per persona"):
 *
 *   ~/.unblock/identity.json     { did, agentName, ed25519PublicKeyHex, createdAt }
 *   ~/.unblock/comms-v3.creds    NATS .creds file (User JWT + nkey seed)
 *   ~/.unblock/comms-v3.env      KEY=value lines:
 *                                  UNBLOCK_NATS_URL=tls://nats.kaeva.app:39899
 *                                  UNBLOCK_NATS_CREDS=/abs/path/comms-v3.creds
 *                                  UNBLOCK_WORKSPACE_ID=<ws>
 *                                  UNBLOCK_ORG_ID=<org>
 *                                  UNBLOCK_CHAT_NAME=<persona-handle>
 *
 * v0.2 (`comms-v2.*`) is read on `whoami`/`logout` for migration cleanup
 * only — `login` always writes v0.3.
 *
 * All filesystem paths are resolved via path.join so Windows backslashes
 * are handled (per polyrepo landmines doc).
 */

import { mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

// ─── paths (computed lazily so tests can stub HOME) ──────────────────────────

/**
 * Process-level override for `unblockHome()`. Set by the CLI when the user
 * supplies `--persona NAME` so the resolution becomes:
 *
 *   1. setPersonaDirOverride(dir)      — explicit programmatic / --persona flag
 *   2. process.env.UNBLOCK_HOME        — env var (test injection + power users)
 *   3. ~/.unblock                      — built-in default
 *
 * Kept module-scoped (vs threaded through every function arg) so the existing
 * `readIdentity()` / `writeCommsCreds()` etc. surface stays unchanged. Tests
 * still use `UNBLOCK_HOME` via the tmp-home fixture; the override is for the
 * CLI's `--persona NAME` plumbing.
 */
let personaDirOverride: string | null = null;

/**
 * Force every subsequent `unblockHome()` call to resolve to `dir`.
 * Pass `null` to clear the override (test cleanup).
 *
 * Higher priority than `process.env.UNBLOCK_HOME` so a CLI flag wins over
 * a stale env var inherited from a shell that was logged-in under a
 * different persona.
 */
export function setPersonaDirOverride(dir: string | null): void {
  personaDirOverride = dir;
}

/**
 * Resolve the unblock home dir. Priority:
 *   1. setPersonaDirOverride(dir) (CLI's --persona flag)
 *   2. process.env.UNBLOCK_HOME
 *   3. ~/.unblock
 */
export function unblockHome(): string {
  if (personaDirOverride !== null && personaDirOverride.trim() !== '') {
    return personaDirOverride;
  }
  const override = process.env['UNBLOCK_HOME'];
  if (override !== undefined && override.trim() !== '') {
    return override;
  }
  return path.join(os.homedir(), '.unblock');
}

/**
 * Map a persona NAME to its canonical home dir:
 *   ~/.unblock-personas/<NAME>/
 *
 * Matches `mint`'s `resolvePersonaDir()` behavior so a `mint --persona NAME`
 * followed by `login --persona NAME` write to / read from the same dir.
 */
export function personaHomeFor(personaName: string): string {
  return path.join(os.homedir(), '.unblock-personas', personaName);
}

export function identityPath(): string {
  return path.join(unblockHome(), 'identity.json');
}

export function v3CredsPath(): string {
  return path.join(unblockHome(), 'comms-v3.creds');
}

export function v3EnvPath(): string {
  return path.join(unblockHome(), 'comms-v3.env');
}

/** v0.2 legacy paths — used only for migration cleanup. */
export function v2CredsPath(): string {
  return path.join(unblockHome(), 'comms-v2.creds');
}

export function v2EnvPath(): string {
  return path.join(unblockHome(), 'comms-v2.env');
}

// ─── identity.json ───────────────────────────────────────────────────────────

/**
 * Local persona identity. The DID is the persona's canonical name across
 * substrate, NATS, and authorization.
 */
export interface PersonaIdentity {
  /** did:key:z6Mk... — minted on first `unblock login`. */
  readonly did: string;
  /** Human-readable handle (e.g. "my-agent"). */
  readonly agentName: string;
  /** Hex-encoded Ed25519 public key derived from the DID. */
  readonly ed25519PublicKeyHex: string;
  /** ISO 8601 timestamp. */
  readonly createdAt: string;
}

export async function readIdentity(): Promise<PersonaIdentity | null> {
  try {
    const raw = await readFile(identityPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (!isIdentity(parsed)) return null;
    return parsed;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function writeIdentity(id: PersonaIdentity): Promise<void> {
  await ensureHomeDir();
  await writeFile(identityPath(), `${JSON.stringify(id, null, 2)}\n`, { mode: 0o600 });
}

function isIdentity(obj: unknown): obj is PersonaIdentity {
  if (typeof obj !== 'object' || obj === null) return false;
  const o = obj as Record<string, unknown>;
  return (
    typeof o['did'] === 'string' &&
    typeof o['agentName'] === 'string' &&
    typeof o['ed25519PublicKeyHex'] === 'string' &&
    typeof o['createdAt'] === 'string'
  );
}

// ─── comms-v3.{creds,env} ────────────────────────────────────────────────────

/**
 * Contents of `~/.unblock/comms-v3.env`. Used by every command that needs
 * a broker connection.
 */
export interface CommsEnv {
  readonly natsUrl: string;
  readonly credsPath: string;
  readonly workspaceId: string;
  readonly orgId: string;
  readonly chatName: string;
  /** ISO 8601 expiry from the JWT, if the server returned one. */
  readonly expiresAt?: string;
  /**
   * Substrate API key (`unb_<64hex>`). Written by `unblock login` when the
   * auth-issuer returned one in the enroll response (P1 substrate-unreachable
   * fix · 2026-05-27). Loaded back by `resolveConfig` so substrate verbs
   * (remember / query / share / …) auto-authenticate with no further
   * `profile add` step.
   *
   * Optional because:
   *   1. Older auth-issuer deployments don't return an api_key.
   *   2. The CLI can be used in comms-only mode (`chat`/`say`/`dm`/`ask`)
   *      without ever talking to the substrate.
   */
  readonly apiKey?: string;
}

export async function readCommsEnv(): Promise<CommsEnv | null> {
  try {
    const raw = await readFile(v3EnvPath(), 'utf-8');
    return parseCommsEnv(raw);
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export function parseCommsEnv(raw: string): CommsEnv | null {
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
  const natsUrl = map.get('UNBLOCK_NATS_URL');
  const credsPath = map.get('UNBLOCK_NATS_CREDS');
  const workspaceId = map.get('UNBLOCK_WORKSPACE_ID');
  const orgId = map.get('UNBLOCK_ORG_ID');
  const chatName = map.get('UNBLOCK_CHAT_NAME');
  if (
    natsUrl === undefined ||
    credsPath === undefined ||
    workspaceId === undefined ||
    orgId === undefined ||
    chatName === undefined
  ) {
    return null;
  }
  const expiresAt = map.get('UNBLOCK_JWT_EXPIRES_AT');
  const apiKey = map.get('UNBLOCK_API_KEY');
  // Build the result conditionally to honor exactOptionalPropertyTypes.
  const env: { -readonly [K in keyof CommsEnv]: CommsEnv[K] } = {
    natsUrl,
    credsPath,
    workspaceId,
    orgId,
    chatName,
  };
  if (expiresAt !== undefined) env.expiresAt = expiresAt;
  if (apiKey !== undefined && apiKey !== '') env.apiKey = apiKey;
  return env;
}

export async function writeCommsEnv(env: CommsEnv): Promise<void> {
  await ensureHomeDir();
  const lines: string[] = [
    '# UNBLOCK comms-v3 env (written by `unblock login`)',
    `UNBLOCK_NATS_URL=${env.natsUrl}`,
    `UNBLOCK_NATS_CREDS=${env.credsPath}`,
    `UNBLOCK_WORKSPACE_ID=${env.workspaceId}`,
    `UNBLOCK_ORG_ID=${env.orgId}`,
    `UNBLOCK_CHAT_NAME=${env.chatName}`,
  ];
  if (env.expiresAt !== undefined) {
    lines.push(`UNBLOCK_JWT_EXPIRES_AT=${env.expiresAt}`);
  }
  if (env.apiKey !== undefined && env.apiKey !== '') {
    // Substrate API key. Persisted alongside the NATS creds so `remember`
    // / `query` / … auto-authenticate without a separate `profile add`.
    // Mode 0o600 below scopes read access to the current user; the key is
    // a bearer credential and must not leak via `cat` from other accounts.
    lines.push(`UNBLOCK_API_KEY=${env.apiKey}`);
  }
  await writeFile(v3EnvPath(), `${lines.join('\n')}\n`, { mode: 0o600 });
}

export async function writeCommsCreds(credsContent: string): Promise<string> {
  await ensureHomeDir();
  const p = v3CredsPath();
  await writeFile(p, credsContent.endsWith('\n') ? credsContent : `${credsContent}\n`, {
    mode: 0o600,
  });
  return p;
}

export async function readCommsCreds(): Promise<string | null> {
  try {
    return await readFile(v3CredsPath(), 'utf-8');
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

// ─── logout / wipe ───────────────────────────────────────────────────────────

/**
 * Idempotent: removes identity.json + comms-v3.{creds,env} + legacy
 * comms-v2.{creds,env} if present. Returns the list of paths actually
 * removed so the caller can log.
 */
export async function wipePersonaStore(): Promise<readonly string[]> {
  const removed: string[] = [];
  for (const p of [identityPath(), v3CredsPath(), v3EnvPath(), v2CredsPath(), v2EnvPath()]) {
    // Check existence first so we only report files that actually went away
    // (rm with force:true silently no-ops on missing, which is the desired
    // semantics but loses the audit trail).
    let existed = false;
    try {
      await stat(p);
      existed = true;
    } catch {
      existed = false;
    }
    if (!existed) continue;
    try {
      await rm(p, { force: true });
      removed.push(p);
    } catch {
      /* swallow — file is locked or unreadable, but we tried */
    }
  }
  return removed;
}

async function ensureHomeDir(): Promise<void> {
  await mkdir(unblockHome(), { recursive: true, mode: 0o700 });
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT';
}
