/**
 * `unblock skill install --target <claude|codex|cursor|auto> [--force] [--dry-run]`
 *
 * Writes the bundled UNBLOCK skill markdown to the harness-native location
 * so the agent picks it up on its next session. Companion to `skill emit`.
 *
 * Targets:
 *   claude  → ~/.claude/skills/unblock/SKILL.md
 *   codex   → stdout + notice (Codex has no persistent skill mechanism)
 *   cursor  → ~/.cursor/rules/unblock.md
 *   auto    → detect via env (CLAUDE_*, CURSOR_*, CODEX_*), then dispatch
 *
 * Exit codes:
 *   0 — installed (or codex emitted)
 *   1 — error (bad target, write failure, etc.)
 *   2 — already installed (skipped because --force was not set)
 *
 * Persona-store invariants don't apply here: the skill is workstation-global
 * agent guidance, not a per-persona credential. We use `os.homedir()` so a
 * test that pins `process.env.HOME`/`USERPROFILE` to a tmp dir gets a fully
 * isolated install location.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { resolveBundledSkillPath } from './skill-emit.js';

export type SkillTarget = 'claude' | 'codex' | 'cursor' | 'auto';

export type SkillInstallStatus =
  | 'installed'
  | 'overwritten'
  | 'already-installed'
  | 'emitted-no-persist';

export interface SkillInstallOptions {
  readonly target: SkillTarget;
  readonly force?: boolean;
  readonly dryRun?: boolean;
}

export interface SkillInstallDeps {
  /** Override the bundled-skill resolver (tests inject a tmp path). */
  readonly resolveSkillPath?: () => string;
  /** Override the file reader (tests inject an in-memory reader). */
  readonly readFile?: (p: string) => Promise<string>;
  /** Override the home-dir resolver (tests pin to a tmp dir). */
  readonly homedir?: () => string;
  /** Override env for auto-detection (tests inject a clean record). */
  readonly env?: NodeJS.ProcessEnv;
}

export interface SkillInstallResult {
  readonly status: SkillInstallStatus;
  readonly target: Exclude<SkillTarget, 'auto'>;
  /** Where the file would be / was written. Undefined for codex. */
  readonly path?: string;
  readonly exitCode: 0 | 1 | 2;
  /** Lines suitable for stdout (notices, dry-run preview, success). */
  readonly stdout: readonly string[];
  /** Lines suitable for stderr (warnings, errors). */
  readonly stderr: readonly string[];
}

/**
 * Resolve the on-disk install location for a concrete (non-auto) target.
 * Returns `null` for codex which has no persistent skill location.
 */
export function resolveSkillInstallPath(
  target: Exclude<SkillTarget, 'auto' | 'codex'>,
  home: string,
): string {
  switch (target) {
    case 'claude':
      return path.join(home, '.claude', 'skills', 'unblock', 'SKILL.md');
    case 'cursor':
      return path.join(home, '.cursor', 'rules', 'unblock.md');
  }
}

/**
 * Sniff harness env vars to pick a concrete target. We check Claude first
 * (most common UNBLOCK consumer), then Cursor, then Codex; default fallback
 * is `claude` because that's the YC demo's reference harness — getting a
 * file written somewhere predictable beats erroring out on an unknown env.
 */
export function detectHarness(env: NodeJS.ProcessEnv): Exclude<SkillTarget, 'auto'> {
  const has = (prefix: string): boolean =>
    Object.keys(env).some((k) => k.startsWith(prefix));
  if (has('CLAUDE_')) return 'claude';
  if (has('CURSOR_')) return 'cursor';
  if (has('CODEX_')) return 'codex';
  return 'claude';
}

/**
 * Install (or dry-run-install) the bundled skill at the harness-native path.
 * See the file header for exit-code semantics.
 */
export async function runSkillInstall(
  deps: SkillInstallDeps,
  opts: SkillInstallOptions,
): Promise<SkillInstallResult> {
  const env = deps.env ?? process.env;
  const home = (deps.homedir ?? homedir)();
  const sourcePath = (deps.resolveSkillPath ?? resolveBundledSkillPath)();
  const reader = deps.readFile ?? ((p: string) => readFile(p, 'utf-8'));

  // Resolve auto → concrete target before any I/O so test asserts on the
  // resolved value can run without touching the filesystem.
  const target: Exclude<SkillTarget, 'auto'> =
    opts.target === 'auto' ? detectHarness(env) : opts.target;
  const dryRun = opts.dryRun === true;
  const force = opts.force === true;

  // Read the skill once up front — both write targets and codex's stdout
  // path need the markdown body, and a missing bundle should fail fast
  // regardless of target.
  let markdown: string;
  try {
    markdown = await reader(sourcePath);
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return {
        status: 'installed',
        target,
        exitCode: 1,
        stdout: [],
        stderr: [
          `skill install: bundled skill not found at ${sourcePath}.`,
          `(confirm unblock-skill.md sits at the package root)`,
        ],
      };
    }
    return {
      status: 'installed',
      target,
      exitCode: 1,
      stdout: [],
      stderr: [`skill install: ${(err as Error).message}`],
    };
  }

  if (target === 'codex') {
    const stdout = [
      markdown,
      '',
      '# notice: Codex has no persistent skill mechanism;',
      '# pipe this into prompts (e.g. `unblock skill emit | codex exec -`).',
    ];
    return {
      status: 'emitted-no-persist',
      target,
      exitCode: 0,
      stdout,
      stderr: [],
    };
  }

  const targetPath = resolveSkillInstallPath(target, home);
  const exists = await pathExists(targetPath);

  if (exists && !force) {
    return {
      status: 'already-installed',
      target,
      path: targetPath,
      exitCode: 2,
      stdout: [
        `skill already installed at ${targetPath} (pass --force to overwrite)`,
      ],
      stderr: [],
    };
  }

  if (dryRun) {
    return {
      status: exists ? 'overwritten' : 'installed',
      target,
      path: targetPath,
      exitCode: 0,
      stdout: [
        `[dry-run] would ${exists ? 'overwrite' : 'write'} ${markdown.length} bytes → ${targetPath}`,
      ],
      stderr: [],
    };
  }

  try {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(targetPath, markdown, 'utf-8');
  } catch (err) {
    return {
      status: 'installed',
      target,
      path: targetPath,
      exitCode: 1,
      stdout: [],
      stderr: [`skill install: ${(err as Error).message}`],
    };
  }

  return {
    status: exists ? 'overwritten' : 'installed',
    target,
    path: targetPath,
    exitCode: 0,
    stdout: [
      exists
        ? `overwrote ${targetPath}`
        : `installed ${targetPath}`,
    ],
    stderr: [],
  };
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      return false;
    }
    throw err;
  }
}
