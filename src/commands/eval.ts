/**
 * `unblock eval <locomo10|longmemeval|all> [opts]`
 *
 * Runs the substrate bench harness against the locally-installed substrate
 * dist and writes results to `~/.unblock/eval-<bench>-<timestamp>.json`.
 *
 * Architecture: this command is a thin shim over substrate's bench runner.
 * The CLI does NOT take a hard dep on the substrate runtime — it shells
 * into substrate's `scripts/eval/run-bench.mjs` via Node `child_process`.
 * That keeps the CLI's bundle small + lets the bench evolve independently.
 *
 * Per LT-6 in project_unblock_yc_lockin_tests_20260524: the goal is honest
 * baseline numbers YC reviewers can rerun on a fresh machine. The CLI
 * surface is the supported entry point; the script is the implementation.
 */

import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { existsSync, statSync } from 'node:fs';

import { resolveConfig, type ConfigOverrides } from '../config.js';

export type EvalBench = 'locomo10' | 'longmemeval' | 'all';

export interface EvalOptions extends ConfigOverrides {
  readonly bench: EvalBench;
  /** 'full' or 'stratified:N' (default stratified:10) */
  readonly strategy?: string;
  /** path to LoCoMo10 JSON (overrides packaged fixture) */
  readonly dataLocomo?: string;
  /** path to LongMemEval JSON (overrides packaged fixture) */
  readonly dataLongmemeval?: string;
  /** output directory (default ~/.unblock/) */
  readonly out?: string;
  /** 'none' (default) or 'openai' */
  readonly synth?: string;
  /** 'noop' (default) or 'openai' */
  readonly judge?: string;
}

export interface EvalDeps {
  /**
   * Override the child-process spawn. Tests pass a fake; production uses
   * node:child_process.spawn directly.
   */
  readonly spawn?: typeof spawn;
  /**
   * Locate the substrate bench-runner script. Tests inject a stub path.
   */
  readonly resolveBenchScript?: () => string;
  /** Override stdout/stderr writers (tests inject buffers). */
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
}

export interface EvalOutput {
  /** Exit code from the bench-runner subprocess. */
  readonly exitCode: number;
}

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Locate the substrate bench-runner script. Mirrors the resolution chain in
 * commands/ingest-substrate-load.ts: env override → sibling polyrepo.
 */
export function resolveBenchScriptDefault(): string {
  const envOverride = process.env['UNBLOCK_SUBSTRATE_BENCH_SCRIPT'];
  if (envOverride && envOverride.length > 0 && existsSync(envOverride)) {
    return envOverride;
  }
  // From dist/commands/eval.js, sibling polyrepo is ../../../unblock_substrate
  const candidate = path.resolve(
    HERE,
    '..',
    '..',
    '..',
    'unblock_substrate',
    'scripts',
    'eval',
    'run-bench.mjs',
  );
  if (existsSync(candidate)) return candidate;
  // Same path from src/commands during dev (without --build first).
  const dev = path.resolve(
    HERE,
    '..',
    '..',
    '..',
    '..',
    'unblock_substrate',
    'scripts',
    'eval',
    'run-bench.mjs',
  );
  if (existsSync(dev)) return dev;
  throw new Error(
    'eval: could not locate substrate bench-runner script. ' +
      'Set UNBLOCK_SUBSTRATE_BENCH_SCRIPT to the absolute path to run-bench.mjs.',
  );
}

function defaultOutDir(): string {
  const home = process.env['HOME'] ?? process.env['USERPROFILE'];
  if (!home) return path.resolve('.unblock');
  return path.join(home, '.unblock');
}

function defaultsForArgs(opts: EvalOptions, outDir: string): string[] {
  const args: string[] = [opts.bench];
  args.push('--strategy', opts.strategy ?? 'stratified:10');
  args.push('--out', outDir);
  args.push('--synth', opts.synth ?? 'none');
  args.push('--judge', opts.judge ?? 'noop');
  if (opts.dataLocomo) args.push('--data-locomo', opts.dataLocomo);
  if (opts.dataLongmemeval) args.push('--data-longmemeval', opts.dataLongmemeval);
  return args;
}

/**
 * Run `unblock eval`. Returns when the subprocess exits.
 */
export async function runEval(deps: EvalDeps, opts: EvalOptions): Promise<EvalOutput> {
  // Touch the resolved config so an unresolved persona doesn't silently swallow
  // env failures. We don't *use* the config here — the bench runner doesn't
  // need auth — but reading it surfaces broken installs earlier.
  await resolveConfig(opts);

  const stdout = deps.stdout ?? ((s: string): void => {
    process.stdout.write(s);
  });
  const stderr = deps.stderr ?? ((s: string): void => {
    process.stderr.write(s);
  });

  const script = (deps.resolveBenchScript ?? resolveBenchScriptDefault)();
  const scriptStat = statSync(script);
  if (!scriptStat.isFile()) {
    throw new Error(`eval: bench-runner path '${script}' is not a file`);
  }

  const outDir = opts.out ?? defaultOutDir();
  const args = defaultsForArgs(opts, outDir);

  const spawner = deps.spawn ?? spawn;
  const child = spawner(process.execPath, [script, ...args], {
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout?.on('data', (chunk: Buffer): void => {
    stdout(chunk.toString('utf-8'));
  });
  child.stderr?.on('data', (chunk: Buffer): void => {
    stderr(chunk.toString('utf-8'));
  });

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 1));
  });
  return { exitCode };
}
