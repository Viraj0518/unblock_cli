/**
 * `unblock skill emit [--format markdown|json]`
 *
 * Prints the bundled UNBLOCK skill (canonical agent instructions) to stdout.
 *
 * W2a (un-cut for YC demo install flow): a fresh `curl install.unblock.app | sh`
 * needs to drop the skill into the agent's harness location without a manual
 * copy step. `skill emit` is the pipe-into-prompt path; `skill install` is the
 * write-to-disk path. Both read from the same bundled `unblock-skill.md` at
 * the package root so there's exactly one source of truth — no drift between
 * "what the CLI emits" and "what the install command writes."
 *
 * The file is located via `import.meta.url` so it works in both `tsx`/dev
 * (src/commands/skill-emit.ts → ../../unblock-skill.md) and the published
 * dist build (dist/commands/skill-emit.js → ../../unblock-skill.md). It MUST
 * be listed in package.json `files[]` so npm publish includes it.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export type SkillEmitFormat = 'markdown' | 'json';

export interface SkillEmitOptions {
  readonly format?: SkillEmitFormat;
}

export interface SkillEmitDeps {
  /** Override the bundled-skill resolver (tests inject a tmp path). */
  readonly resolveSkillPath?: () => string;
  /** Override the file reader (tests inject an in-memory reader). */
  readonly readFile?: (p: string) => Promise<string>;
}

export interface SkillEmitResult {
  /** The markdown source (always present, regardless of format). */
  readonly markdown: string;
  /** The bytes the caller should write to stdout for the requested format. */
  readonly output: string;
  /** Resolved absolute path the markdown was read from. */
  readonly sourcePath: string;
  /** The format that was emitted. */
  readonly format: SkillEmitFormat;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Default resolution: walk up from the compiled file to the package root,
 * where `unblock-skill.md` sits next to package.json.
 *
 * - Dev:  src/commands/skill-emit.ts        → ../../unblock-skill.md
 * - Dist: dist/commands/skill-emit.js       → ../../unblock-skill.md
 */
export function resolveBundledSkillPath(): string {
  return path.resolve(HERE, '..', '..', 'unblock-skill.md');
}

/**
 * Load the bundled skill markdown and return it shaped for the requested
 * `--format`. JSON wraps the markdown verbatim so downstream tooling can
 * pipe it into agents that prefer structured envelopes without losing the
 * formatting.
 */
export async function runSkillEmit(
  deps: SkillEmitDeps,
  opts: SkillEmitOptions,
): Promise<SkillEmitResult> {
  const format: SkillEmitFormat = opts.format ?? 'markdown';
  const sourcePath = (deps.resolveSkillPath ?? resolveBundledSkillPath)();
  const reader = deps.readFile ?? ((p: string) => readFile(p, 'utf-8'));

  let markdown: string;
  try {
    markdown = await reader(sourcePath);
  } catch (err) {
    if (
      typeof err === 'object' &&
      err !== null &&
      (err as { code?: string }).code === 'ENOENT'
    ) {
      throw new Error(
        `skill emit: bundled skill not found at ${sourcePath}. ` +
          `(if running from src, confirm unblock-skill.md sits at the package root)`,
      );
    }
    throw err;
  }

  const output =
    format === 'json'
      ? `${JSON.stringify({ name: 'unblock', source: sourcePath, markdown }, null, 2)}\n`
      : markdown;

  return { markdown, output, sourcePath, format };
}
