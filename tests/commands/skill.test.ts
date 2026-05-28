/**
 * Tests for `unblock skill emit` + `unblock skill install --target X`.
 *
 * Brief acceptance criteria (W2a un-cut, YC demo install flow):
 *   - emit returns markdown matching the bundled file
 *   - install --target claude writes to mocked ~/.claude/skills/unblock/SKILL.md
 *   - install --target codex prints to stdout + notice
 *   - install --target cursor writes to mocked ~/.cursor/rules/unblock.md
 *   - install --target auto detects via mocked env vars + dispatches
 *   - --force overwrites; --dry-run doesn't write
 *   - Idempotency: second install --target X (no --force) → exit 2
 *
 * The bundled skill is located via `import.meta.url` so we don't need to
 * cp it into a tmp dir per test — the file at the repo root is the very
 * file the published bin will read. Tests pin `homedir` via deps so they
 * never touch the developer's real `~/.claude/` or `~/.cursor/`.
 */

import { Buffer } from 'node:buffer';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { main } from '../../src/main.js';
import {
  resolveBundledSkillPath,
  runSkillEmit,
} from '../../src/commands/skill-emit.js';
import {
  detectHarness,
  resolveSkillInstallPath,
  runSkillInstall,
} from '../../src/commands/skill-install.js';

let tmpHome: string;

beforeEach(async () => {
  tmpHome = await mkdtemp(path.join(tmpdir(), 'unblock-skill-test-'));
});

afterEach(async () => {
  await rm(tmpHome, { recursive: true, force: true });
});

// ─── emit ────────────────────────────────────────────────────────────────────

describe('runSkillEmit', () => {
  it('returns markdown that matches the bundled unblock-skill.md verbatim', async () => {
    const expected = await readFile(resolveBundledSkillPath(), 'utf-8');
    const result = await runSkillEmit({}, {});

    expect(result.format).toBe('markdown');
    expect(result.markdown).toBe(expected);
    expect(result.output).toBe(expected);
    expect(result.sourcePath).toBe(resolveBundledSkillPath());
  });

  it('--format=json wraps the markdown in a {name, source, markdown} envelope', async () => {
    const expected = await readFile(resolveBundledSkillPath(), 'utf-8');
    const result = await runSkillEmit({}, { format: 'json' });

    expect(result.format).toBe('json');
    const parsed = JSON.parse(result.output) as Record<string, unknown>;
    expect(parsed['name']).toBe('unblock');
    expect(parsed['markdown']).toBe(expected);
    expect(parsed['source']).toBe(resolveBundledSkillPath());
  });

  it('surfaces a clear error when the bundled skill is missing', async () => {
    await expect(
      runSkillEmit(
        { resolveSkillPath: () => path.join(tmpHome, 'does-not-exist.md') },
        {},
      ),
    ).rejects.toThrow(/bundled skill not found/);
  });

  it('CLI: `unblock skill emit` writes the bundled markdown to stdout', async () => {
    const expected = await readFile(resolveBundledSkillPath(), 'utf-8');
    const { code, stdout } = await runMainCapturing(['skill', 'emit']);
    expect(code).toBe(0);
    expect(stdout).toBe(expected);
  });

  it('CLI: --format=json emits a parseable JSON envelope', async () => {
    const { code, stdout } = await runMainCapturing([
      'skill',
      'emit',
      '--format',
      'json',
    ]);
    expect(code).toBe(0);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed['name']).toBe('unblock');
    expect(typeof parsed['markdown']).toBe('string');
  });

  it('CLI: rejects unknown --format with exit 1', async () => {
    const { code, stderr } = await runMainCapturing([
      'skill',
      'emit',
      '--format',
      'xml',
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--format must be markdown \| json/);
  });
});

// ─── install --target claude ─────────────────────────────────────────────────

describe('runSkillInstall (target=claude)', () => {
  it('writes to <home>/.claude/skills/unblock/SKILL.md', async () => {
    const expected = await readFile(resolveBundledSkillPath(), 'utf-8');
    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: {} },
      { target: 'claude' },
    );

    const installedPath = path.join(
      tmpHome,
      '.claude',
      'skills',
      'unblock',
      'SKILL.md',
    );
    expect(result.status).toBe('installed');
    expect(result.target).toBe('claude');
    expect(result.path).toBe(installedPath);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.join('\n')).toMatch(/^installed /);

    const written = await readFile(installedPath, 'utf-8');
    expect(written).toBe(expected);
  });

  it('creates the parent directory tree when missing (mkdir -p)', async () => {
    // tmpHome is empty — .claude/skills/unblock/ does NOT exist yet.
    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: {} },
      { target: 'claude' },
    );
    expect(result.exitCode).toBe(0);
    const parent = path.dirname(result.path ?? '');
    const st = await stat(parent);
    expect(st.isDirectory()).toBe(true);
  });
});

// ─── install --target codex ──────────────────────────────────────────────────

describe('runSkillInstall (target=codex)', () => {
  it('prints markdown to stdout with a no-persist notice and exits 0', async () => {
    const expected = await readFile(resolveBundledSkillPath(), 'utf-8');
    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: {} },
      { target: 'codex' },
    );

    expect(result.target).toBe('codex');
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('emitted-no-persist');
    expect(result.path).toBeUndefined();
    expect(result.stdout[0]).toBe(expected);
    expect(result.stdout.join('\n')).toMatch(
      /Codex has no persistent skill mechanism/,
    );
  });
});

// ─── install --target cursor ─────────────────────────────────────────────────

describe('runSkillInstall (target=cursor)', () => {
  it('writes to <home>/.cursor/rules/unblock.md', async () => {
    const expected = await readFile(resolveBundledSkillPath(), 'utf-8');
    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: {} },
      { target: 'cursor' },
    );

    const installedPath = path.join(tmpHome, '.cursor', 'rules', 'unblock.md');
    expect(result.path).toBe(installedPath);
    expect(result.exitCode).toBe(0);
    const written = await readFile(installedPath, 'utf-8');
    expect(written).toBe(expected);
  });
});

// ─── install --target auto ───────────────────────────────────────────────────

describe('runSkillInstall (target=auto)', () => {
  it('detects CLAUDE_* env and dispatches to claude', async () => {
    expect(detectHarness({ CLAUDE_PLUGIN_ROOT: '/p' })).toBe('claude');

    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: { CLAUDE_PLUGIN_ROOT: '/p' } },
      { target: 'auto' },
    );
    expect(result.target).toBe('claude');
    expect(result.path).toBe(
      path.join(tmpHome, '.claude', 'skills', 'unblock', 'SKILL.md'),
    );
    expect(result.exitCode).toBe(0);
  });

  it('detects CURSOR_* env and dispatches to cursor', async () => {
    expect(detectHarness({ CURSOR_SESSION: '1' })).toBe('cursor');

    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: { CURSOR_SESSION: '1' } },
      { target: 'auto' },
    );
    expect(result.target).toBe('cursor');
    expect(result.path).toBe(
      path.join(tmpHome, '.cursor', 'rules', 'unblock.md'),
    );
    expect(result.exitCode).toBe(0);
  });

  it('detects CODEX_* env and dispatches to codex (stdout, no persist)', async () => {
    expect(detectHarness({ CODEX_HOME: '/p' })).toBe('codex');

    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: { CODEX_HOME: '/p' } },
      { target: 'auto' },
    );
    expect(result.target).toBe('codex');
    expect(result.status).toBe('emitted-no-persist');
    expect(result.path).toBeUndefined();
  });

  it('falls back to claude when no harness env is set', async () => {
    expect(detectHarness({})).toBe('claude');
  });
});

// ─── --force + --dry-run + idempotency ──────────────────────────────────────

describe('runSkillInstall (--force / --dry-run / idempotency)', () => {
  it('idempotency: second install without --force returns exit 2 (already-installed)', async () => {
    const first = await runSkillInstall(
      { homedir: () => tmpHome, env: {} },
      { target: 'claude' },
    );
    expect(first.exitCode).toBe(0);

    const second = await runSkillInstall(
      { homedir: () => tmpHome, env: {} },
      { target: 'claude' },
    );
    expect(second.exitCode).toBe(2);
    expect(second.status).toBe('already-installed');
    expect(second.stdout.join('\n')).toMatch(/pass --force to overwrite/);
  });

  it('--force overwrites an existing file', async () => {
    const targetPath = resolveSkillInstallPath('claude', tmpHome);
    await mkdtempParent(targetPath);
    await writeFile(targetPath, 'old content', 'utf-8');

    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: {} },
      { target: 'claude', force: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.status).toBe('overwritten');

    const expected = await readFile(resolveBundledSkillPath(), 'utf-8');
    const written = await readFile(targetPath, 'utf-8');
    expect(written).toBe(expected);
    expect(written).not.toBe('old content');
  });

  it('--dry-run does not write a file and exits 0', async () => {
    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: {} },
      { target: 'claude', dryRun: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.join('\n')).toMatch(/\[dry-run\] would write/);

    // File must NOT exist after dry-run.
    await expect(stat(result.path ?? '')).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it('--dry-run on existing file announces overwrite without writing', async () => {
    const targetPath = resolveSkillInstallPath('claude', tmpHome);
    await mkdtempParent(targetPath);
    await writeFile(targetPath, 'preserved', 'utf-8');

    const result = await runSkillInstall(
      { homedir: () => tmpHome, env: {} },
      { target: 'claude', force: true, dryRun: true },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.join('\n')).toMatch(/\[dry-run\] would overwrite/);

    // File still has old content because dry-run skipped the write.
    expect(await readFile(targetPath, 'utf-8')).toBe('preserved');
  });
});

// ─── CLI argv plumbing for install ──────────────────────────────────────────

describe('unblock skill install (CLI argv)', () => {
  it('rejects an unknown --target with exit 1', async () => {
    const { code, stderr } = await runMainCapturing([
      'skill',
      'install',
      '--target',
      'emacs',
    ]);
    expect(code).toBe(1);
    expect(stderr).toMatch(/--target must be claude \| codex \| cursor \| auto/);
  });

  it('requires --target', async () => {
    const { code, stderr } = await runMainCapturing(['skill', 'install']);
    // commander exits non-zero on missing requiredOption.
    expect(code).not.toBe(0);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

async function mkdtempParent(p: string): Promise<void> {
  const { mkdir } = await import('node:fs/promises');
  await mkdir(path.dirname(p), { recursive: true });
}

async function runMainCapturing(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exitCode = origExitCode;
  }
}
