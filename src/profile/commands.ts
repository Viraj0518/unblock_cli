/**
 * Profile subcommands — `unblock profile {add|list|use|rm}`.
 *
 * Each function returns a `ProfileResult` (testable) and an integer exit code.
 * The CLI wrapper in `src/main.ts` calls the function, prints any messages,
 * and sets `process.exitCode`. Output is plain text — no chalk, no ora — for
 * consistency with the rest of the comms CLI (see `whoami.ts`, `login.ts`).
 */

import {
  isValidApiKey,
  isValidProfileName,
  loadRegistry,
  profileKeyPath,
  removeProfileDir,
  updateRegistryCAS,
  withRegistryLock,
  writeProfileKey,
  type ProfileRegistry,
} from './registry.js';

export interface ProfileResult {
  /** Exit code: 0 = ok, 1 = generic error, 2 = bad input. */
  readonly exitCode: number;
  /** Lines to print on stdout. */
  readonly stdout: readonly string[];
  /** Lines to print on stderr. */
  readonly stderr: readonly string[];
}

function ok(stdout: readonly string[]): ProfileResult {
  return { exitCode: 0, stdout, stderr: [] };
}

function badInput(line: string): ProfileResult {
  return { exitCode: 2, stdout: [], stderr: [line] };
}

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

// ─── add ─────────────────────────────────────────────────────────────────────

export interface AddProfileOptions {
  readonly name: string;
  readonly apiKey: string;
  readonly catalogApi?: string;
  readonly note?: string;
  /** Allow overwriting an existing profile entry. */
  readonly force?: boolean;
}

/**
 * Add a profile. Lock-protects key write + registry mutation + generation bump
 * in one critical section (matches the 0.1.0 fix for `tla/HarnessProfile-REDTEAM.md`
 * HIGH lost-update finding).
 */
export async function cmdProfileAdd(opts: AddProfileOptions): Promise<ProfileResult> {
  if (!isValidProfileName(opts.name)) {
    return badInput(
      `error: invalid profile name "${opts.name}". Use [a-z0-9][a-z0-9-_]{0,31}.`,
    );
  }
  const key = opts.apiKey.trim();
  if (!isValidApiKey(key)) {
    return badInput('error: api-key does not match unb_<32hex>.');
  }
  let collided = false;
  let activated = false;
  await withRegistryLock(async () => {
    const reg = await loadRegistry();
    if (reg.profiles[opts.name] && opts.force !== true) {
      collided = true;
      return;
    }
    await writeProfileKey(opts.name, key);
    const entry = {
      ...(opts.catalogApi !== undefined ? { catalog_api: opts.catalogApi } : {}),
      ...(opts.note !== undefined ? { note: opts.note } : {}),
      created_at: nowSeconds(),
    };
    const nextProfiles = { ...reg.profiles, [opts.name]: entry };
    const nextActive = reg.active ?? opts.name;
    activated = reg.active === null;
    const next: ProfileRegistry = {
      generation: reg.generation + 1,
      active: nextActive,
      profiles: nextProfiles,
    };
    // Inside an open lock; bypass CAS (we already hold the lock).
    await writeRegistryUnderLock(next);
  });
  if (collided) {
    return {
      exitCode: 2,
      stdout: [],
      stderr: [`error: profile "${opts.name}" already exists. Use --force to overwrite.`],
    };
  }
  const lines = [
    `ok added profile "${opts.name}" (key …${key.slice(-8)})`,
    `  key path: ${profileKeyPath(opts.name)}`,
  ];
  if (activated) {
    lines.push(`  active profile -> ${opts.name} (was none)`);
  }
  return ok(lines);
}

// ─── list ────────────────────────────────────────────────────────────────────

export interface ListProfileOptions {
  readonly json?: boolean;
}

export async function cmdProfileList(opts: ListProfileOptions = {}): Promise<ProfileResult> {
  const reg = await loadRegistry();
  if (opts.json === true) {
    return ok([JSON.stringify(reg, null, 2)]);
  }
  const names = Object.keys(reg.profiles).sort();
  if (names.length === 0) {
    return ok(['no profiles. Add one with `unblock profile add <name> --api-key <key>`.']);
  }
  const lines: string[] = ['UNBLOCK profiles'];
  for (const name of names) {
    const entry = reg.profiles[name];
    if (entry === undefined) continue;
    const tag = name === reg.active ? ' (active)' : '';
    const url = entry.catalog_api !== undefined ? `  -> ${entry.catalog_api}` : '';
    const note = entry.note !== undefined ? `  ${entry.note}` : '';
    lines.push(`  ${name}${tag}${url}${note}`);
  }
  return ok(lines);
}

// ─── use ─────────────────────────────────────────────────────────────────────

export async function cmdProfileUse(name: string): Promise<ProfileResult> {
  if (!isValidProfileName(name)) {
    return badInput(`error: invalid profile name "${name}".`);
  }
  let missing = false;
  await updateRegistryCAS<void>((reg) => {
    if (!reg.profiles[name]) {
      missing = true;
      return { commit: false, result: undefined };
    }
    const next: ProfileRegistry = {
      ...reg,
      active: name,
    };
    return { commit: true, result: undefined, next };
  });
  if (missing) {
    return {
      exitCode: 2,
      stdout: [],
      stderr: [`error: profile "${name}" not found.`],
    };
  }
  return ok([`ok active profile -> ${name}`]);
}

// ─── rm ──────────────────────────────────────────────────────────────────────

export async function cmdProfileRm(name: string): Promise<ProfileResult> {
  if (!isValidProfileName(name)) {
    return badInput(`error: invalid profile name "${name}".`);
  }
  let missing = false;
  await updateRegistryCAS<void>((reg) => {
    if (!reg.profiles[name]) {
      missing = true;
      return { commit: false, result: undefined };
    }
    const nextProfiles: Record<string, typeof reg.profiles[string]> = { ...reg.profiles };
    delete nextProfiles[name];
    const next: ProfileRegistry = {
      generation: reg.generation,
      active: reg.active === name ? null : reg.active,
      profiles: nextProfiles,
    };
    return { commit: true, result: undefined, next };
  });
  if (missing) {
    return {
      exitCode: 2,
      stdout: [],
      stderr: [`error: profile "${name}" not found.`],
    };
  }
  // Best-effort wipe of the per-profile dir (key + checkpoint).
  await removeProfileDir(name);
  return ok([`ok removed profile "${name}"`]);
}

// ─── internal: registry write inside an already-held lock ────────────────────

import { mkdir, rename, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { profilesRegistryPath } from './registry.js';

/**
 * Write the registry atomically *without* re-acquiring the lock. Only call
 * from inside `withRegistryLock`. The companion `writeRegistryAtomic` in
 * `registry.ts` is private; mirroring the dozen lines here keeps the lock
 * lifecycle obvious at every call site (no hidden re-entrancy).
 */
async function writeRegistryUnderLock(reg: ProfileRegistry): Promise<void> {
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
      /* best-effort */
    }
    throw err;
  }
}
