/**
 * `unblock skill <emit|install>` — noun-command registration.
 *
 * Wires the two subcommands to a parent `skill` Commander node so the help
 * tree groups them under one heading instead of polluting the top-level
 * verb list. The subcommand handlers themselves live in `skill-emit.ts`
 * and `skill-install.ts` so they can be tested in isolation (no Commander
 * argv parsing required).
 *
 * Why a separate file: keeping the registration adjacent to the handlers
 * means future skill subcommands (e.g. `skill list`, `skill diff`) land
 * here without growing main.ts further. main.ts only needs to call
 * `registerSkillCommands(program)`.
 */

import type { Command } from 'commander';
import process from 'node:process';
import { runSkillEmit, type SkillEmitFormat } from './skill-emit.js';
import { runSkillInstall, type SkillTarget } from './skill-install.js';

/**
 * Attach the `skill` noun and its subcommands to a Commander program.
 * Callers should invoke this exactly once during program construction.
 */
export function registerSkillCommands(program: Command): void {
  const skill = program
    .command('skill')
    .description(
      'Manage the bundled UNBLOCK agent skill (canonical instructions for AI personas).\n' +
        'Subcommands:\n' +
        '  emit     print SKILL.md to stdout (pipe into an agent prompt)\n' +
        '  install  write SKILL.md into the harness-native location',
    );

  skill
    .command('emit')
    .description(
      'Print the bundled UNBLOCK skill markdown to stdout. ' +
        'Default --format=markdown emits the raw .md; ' +
        '--format=json wraps it as {name, source, markdown}.',
    )
    .option('--format <fmt>', 'markdown | json (default markdown)')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const rawFormat = opts['format'];
        let format: SkillEmitFormat = 'markdown';
        if (typeof rawFormat === 'string') {
          if (rawFormat !== 'markdown' && rawFormat !== 'json') {
            process.stderr.write(
              `error: --format must be markdown | json (got "${rawFormat}")\n`,
            );
            process.exitCode = 1;
            return;
          }
          format = rawFormat;
        }
        const result = await runSkillEmit({}, { format });
        process.stdout.write(result.output);
      } catch (err) {
        process.stderr.write(
          `${err instanceof Error ? `error: ${err.message}` : `error: ${String(err)}`}\n`,
        );
        process.exitCode = 1;
      }
    });

  skill
    .command('install')
    .description(
      'Write the bundled UNBLOCK skill to the harness-native location. ' +
        'Targets: claude → ~/.claude/skills/unblock/SKILL.md · ' +
        'codex → stdout + notice · cursor → ~/.cursor/rules/unblock.md · ' +
        'auto → detect via env (CLAUDE_*/CURSOR_*/CODEX_*). ' +
        'Exit 0=installed, 1=error, 2=already installed (skip without --force).',
    )
    .requiredOption('--target <name>', 'claude | codex | cursor | auto')
    .option('--force', 'overwrite an existing skill file', false)
    .option('--dry-run', 'print what would happen without writing', false)
    .action(async (opts: Record<string, unknown>) => {
      try {
        const rawTarget = opts['target'];
        if (
          typeof rawTarget !== 'string' ||
          (rawTarget !== 'claude' &&
            rawTarget !== 'codex' &&
            rawTarget !== 'cursor' &&
            rawTarget !== 'auto')
        ) {
          process.stderr.write(
            `error: --target must be claude | codex | cursor | auto (got "${String(rawTarget)}")\n`,
          );
          process.exitCode = 1;
          return;
        }
        const result = await runSkillInstall(
          {},
          {
            target: rawTarget as SkillTarget,
            force: opts['force'] === true,
            dryRun: opts['dryRun'] === true,
          },
        );
        for (const line of result.stdout) process.stdout.write(`${line}\n`);
        for (const line of result.stderr) process.stderr.write(`${line}\n`);
        process.exitCode = result.exitCode;
      } catch (err) {
        process.stderr.write(
          `${err instanceof Error ? `error: ${err.message}` : `error: ${String(err)}`}\n`,
        );
        process.exitCode = 1;
      }
    });
}
