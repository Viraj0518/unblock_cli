/**
 * Profile registry — `~/.unblock/profiles.json` + per-profile dirs.
 *
 * Backs the `unblock profile {add|list|use|rm}` subcommands (Wave-1 tracer of
 * `docs/plans/PORT-PLAN-cli-from-010.md`). One workstation may host several
 * personas (Viraj-Alpha + Viraj-Beta + Codex + future) — each needs its own
 * api key + checkpoint + (eventually) catalog-api endpoint without overwriting
 * the others' state.
 *
 * On-disk layout:
 *
 *   ~/.unblock/profiles.json                           registry (this file)
 *   ~/.unblock/profiles/<name>/api_key                 per-profile key (mode 600)
 *   ~/.unblock/profiles/<name>/import-progress.db      per-profile checkpoint
 *
 * Concurrency: writes are serialised behind a directory-mkdir lock and
 * gated by a monotonic generation counter (compare-and-swap). Multiple
 * `unblock` processes running in parallel never lose each other's writes —
 * a CAS miss triggers a bounded retry; an exhausted retry surfaces a clear
 * error instead of clobbering. Ported from `tla/HarnessProfile.tla`
 * `RegistryAtomicWrite` / `ResolutionPrecedence` / `KeyFileMode600`.
 *
 * Boundary notes (AGENTS.md §3 + §7):
 *   - `node:fs/promises` only — already in use repo-wide
 *   - `unblockHome()` re-exported from `auth/persona-store.ts` (honours
 *     `UNBLOCK_HOME` for test isolation)
 *   - No chalk, no ora, no prompts. Plain text output lives in `commands.ts`.
 *   - `process.env` is read by `unblockHome` (already gated there); this
 *     module never touches `process.env` directly.
 */

import { mkdir, readFile, rename, rm, stat, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { unblockHome } from '../auth/persona-store.js';

// ─── types ───────────────────────────────────────────────────────────────────

export interface ProfileEntry {
  /** Catalog API URL for this profile (overrides the SDK default). */
  readonly catalog_api?: string;
  /** Free-form description (e.g. "alpha-laptop", "rotating-eval-key"). */
  readonly note?: string;
  /** Unix-seconds creation timestamp. */
  readonly created_at: number;
}

export interface ProfileRegistry {
  /** Monotonic registry epoch; rejects stale read-modify-write saves. */
  readonly generation: number;
  /** Name of the currently-active profile, or null if none. */
  readonly active: string | null;
  readonly profiles: Readonly<Record<string, ProfileEntry>>;
}

// ─── paths ───────────────────────────────────────────────────────────────────

export function profilesRegistryPath(): string {
  return path.join(unblockHome(), 'profiles.json');
}

export function profileDir(name: string): string {
  return path.join(unblockHome(), 'profiles', name);
}

export function profileKeyPath(name: string): string {
  return path.join(profileDir(name), 'api_key');
}

export function profileCheckpointPath(name: string): string {
  return path.join(profileDir(name), 'import-progress.db');
}

function registryLockPath(): string {
  return `${profilesRegistryPath()}.lock`;
}

// ─── name + key validation ───────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9-_]{0,31}$/;

export function isValidProfileName(name: string): boolean {
  return NAME_RE.test(name);
}

const API_KEY_RE = /^unb_[0-9a-f]{32}$/;

export function isValidApiKey(key: string): boolean {
  return API_KEY_RE.test(key);
}

// ─── load / save ─────────────────────────────────────────────────────────────

function registryGeneration(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function isProfileEntry(v: unknown): v is ProfileEntry {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['created_at'] === 'number';
}

function normalizeProfiles(raw: unknown): Record<string, ProfileEntry> {
  if (typeof raw !== 'object' || raw === null) return {};
  const out: Record<string, ProfileEntry> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (isProfileEntry(v)) out[k] = v;
  }
  return out;
}

export async function loadRegistry(): Promise<ProfileRegistry> {
  const p = profilesRegistryPath();
  try {
    const raw = await readFile(p, 'utf-8');
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error('not a JSON object');
    }
    const o = parsed as Record<string, unknown>;
    return {
      generation: registryGeneration(o['generation']),
      active: typeof o['active'] === 'string' ? o['active'] : null,
      profiles: normalizeProfiles(o['profiles']),
    };
  } catch (err) {
    if (isEnoent(err)) {
      return { generation: 0, active: null, profiles: {} };
    }
    throw new Error(
      `failed to read ${p}: ${err instanceof Error ? err.message : String(err)}. Delete the file or fix the JSON.`,
    );
  }
}

/**
 * Commit a registry image by writing a same-directory temp file and renaming
 * it over `profiles.json`. Readers never observe a half-written registry.
 * Concrete code shape for `RegistryAtomicWrite`.
 */
async function writeRegistryAtomic(reg: ProfileRegistry): Promise<void> {
  const p = profilesRegistryPath();
  await mkdir(path.dirname(p), { recursive: true, mode: 0o700 });
  const tmp = `${p}.tmp.${String(process.pid)}.${String(Date.now())}.${randomUUID()}`;
  try {
    await writeFile(tmp, `${JSON.stringify(reg, null, 2)}\n`, {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await rename(tmp, p);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}

// ─── locking + CAS ───────────────────────────────────────────────────────────

const REGISTRY_LOCK_TIMEOUT_MS = 10_000;
const REGISTRY_LOCK_STALE_MS = 30_000;
const REGISTRY_LOCK_RETRY_MS = 10;
const REGISTRY_CAS_MAX_RETRIES = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Acquire the registry lock as a *directory*, not a file — `mkdir` is the
 * cross-platform atomic primitive Node gives us on both POSIX and Windows.
 * Stale locks (older than 30s) are forcibly removed so a crashed `unblock`
 * process can't wedge the CLI indefinitely.
 */
async function acquireRegistryLock(): Promise<() => Promise<void>> {
  const lock = registryLockPath();
  await mkdir(path.dirname(lock), { recursive: true, mode: 0o700 });
  const deadline = Date.now() + REGISTRY_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      await mkdir(lock, { mode: 0o700 });
      return async (): Promise<void> => {
        await rm(lock, { recursive: true, force: true });
      };
    } catch (err) {
      if (!isErrno(err, 'EEXIST')) throw err;
    }
    try {
      const st = await stat(lock);
      if (Date.now() - st.mtimeMs > REGISTRY_LOCK_STALE_MS) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
    } catch (err) {
      if (isEnoent(err)) continue;
      throw err;
    }
    if (Date.now() >= deadline) {
      throw new Error(`timed out waiting for ${lock}`);
    }
    await sleep(REGISTRY_LOCK_RETRY_MS);
  }
}

/**
 * Serialise a registry mutation behind the lock. Callback owns the whole
 * critical section — callers cannot accidentally read outside the lock and
 * then overwrite another process's newer image.
 */
export async function withRegistryLock<T>(fn: () => Promise<T>): Promise<T> {
  const release = await acquireRegistryLock();
  try {
    return await fn();
  } finally {
    await release();
  }
}

/**
 * Save only if the registry generation still matches the caller's read.
 * A mismatch means another `unblock` process committed first, so the caller
 * must re-read + re-apply rather than drop that process's profile.
 */
async function saveRegistryIfGeneration(
  reg: ProfileRegistry,
  expectedGeneration: number,
): Promise<boolean> {
  return await withRegistryLock(async () => {
    const current = await loadRegistry();
    if (current.generation !== expectedGeneration) {
      return false;
    }
    await writeRegistryAtomic({
      ...reg,
      generation: expectedGeneration + 1,
    });
    return true;
  });
}

/**
 * Compare-and-swap registry updater for commands that can race (`use`, `rm`).
 * Bounded retry — profile commands are interactive CLI work, not a background
 * consensus loop.
 */
export async function updateRegistryCAS<T>(
  mutate: (reg: ProfileRegistry) => { commit: boolean; result: T; next?: ProfileRegistry },
): Promise<T> {
  for (let attempt = 0; attempt < REGISTRY_CAS_MAX_RETRIES; attempt += 1) {
    const reg = await loadRegistry();
    const expectedGeneration = reg.generation;
    const mutation = mutate(reg);
    if (!mutation.commit) {
      return mutation.result;
    }
    const next = mutation.next ?? reg;
    if (await saveRegistryIfGeneration(next, expectedGeneration)) {
      return mutation.result;
    }
  }
  throw new Error('profile registry changed too many times; retry the command');
}

// ─── per-profile key file ────────────────────────────────────────────────────

export async function writeProfileKey(name: string, key: string): Promise<string> {
  if (!isValidApiKey(key)) {
    throw new Error(`invalid API key for profile ${name}: expected unb_<32hex>`);
  }
  const dir = profileDir(name);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const p = profileKeyPath(name);
  await writeFile(p, `${key}\n`, { mode: 0o600 });
  return p;
}

export async function readProfileKey(name: string): Promise<string | null> {
  try {
    const raw = await readFile(profileKeyPath(name), 'utf-8');
    const t = raw.trim();
    return t.length > 0 ? t : null;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

export async function removeProfileDir(name: string): Promise<void> {
  await rm(profileDir(name), { recursive: true, force: true });
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function isEnoent(err: unknown): boolean {
  return isErrno(err, 'ENOENT');
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === code;
}
