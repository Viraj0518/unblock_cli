/**
 * `unblock eval` command tests.
 *
 * Drives runEval with a fake spawner so the test asserts the CLI passes the
 * right argv to the substrate bench-runner without actually running Node
 * subprocesses (which would require the real substrate dist on disk).
 */

import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runEval } from '../../src/commands/eval.js';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter | null;
  stderr: EventEmitter | null;
}

function makeFakeSpawn(opts: { exitCode?: number; stdout?: string; stderr?: string } = {}): {
  spawn: (cmd: string, args: readonly string[]) => FakeChild;
  state: { calls: { cmd: string; args: readonly string[] }[] };
} {
  const state = { calls: [] as { cmd: string; args: readonly string[] }[] };
  const spawnImpl = (cmd: string, args: readonly string[]): FakeChild => {
    state.calls.push({ cmd, args });
    const child = new EventEmitter() as FakeChild;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    setImmediate(() => {
      if (opts.stdout) child.stdout?.emit('data', Buffer.from(opts.stdout, 'utf-8'));
      if (opts.stderr) child.stderr?.emit('data', Buffer.from(opts.stderr, 'utf-8'));
      child.emit('close', opts.exitCode ?? 0);
    });
    return child;
  };
  return { spawn: spawnImpl, state };
}

function makeStubScriptPath(): string {
  // Create a fake "run-bench.mjs" so statSync passes. Contents don't matter
  // — the fake spawner doesn't execute Node.
  const dir = mkdtempSync(path.join(tmpdir(), 'unblock-eval-test-'));
  const p = path.join(dir, 'run-bench.mjs');
  writeFileSync(p, '// fake', 'utf-8');
  return p;
}

describe('runEval', () => {
  it('passes bench + default strategy to the bench-runner script', async () => {
    const fake = makeFakeSpawn({ exitCode: 0 });
    const script = makeStubScriptPath();
    const outBuf: string[] = [];
    const errBuf: string[] = [];
    const result = await runEval(
      {
        spawn: fake.spawn,
        resolveBenchScript: () => script,
        stdout: (s) => outBuf.push(s),
        stderr: (s) => errBuf.push(s),
      },
      { bench: 'locomo10' },
    );
    expect(result.exitCode).toBe(0);
    expect(fake.state.calls).toHaveLength(1);
    const call = fake.state.calls[0];
    expect(call?.args[0]).toBe(script);
    // bench is the second arg; strategy default is 'stratified:10'.
    expect(call?.args).toContain('locomo10');
    expect(call?.args).toContain('--strategy');
    expect(call?.args).toContain('stratified:10');
    expect(call?.args).toContain('--judge');
    expect(call?.args).toContain('noop');
    expect(call?.args).toContain('--synth');
    expect(call?.args).toContain('none');
  });

  it('forwards --data-locomo and --data-longmemeval flags', async () => {
    const fake = makeFakeSpawn({ exitCode: 0 });
    const script = makeStubScriptPath();
    await runEval(
      {
        spawn: fake.spawn,
        resolveBenchScript: () => script,
        stdout: () => {},
        stderr: () => {},
      },
      {
        bench: 'all',
        dataLocomo: '/tmp/locomo10.json',
        dataLongmemeval: '/tmp/lme.json',
      },
    );
    const args = fake.state.calls[0]?.args ?? [];
    expect(args).toContain('--data-locomo');
    expect(args).toContain('/tmp/locomo10.json');
    expect(args).toContain('--data-longmemeval');
    expect(args).toContain('/tmp/lme.json');
  });

  it('returns the subprocess exit code', async () => {
    const fake = makeFakeSpawn({ exitCode: 2 });
    const script = makeStubScriptPath();
    const result = await runEval(
      {
        spawn: fake.spawn,
        resolveBenchScript: () => script,
        stdout: () => {},
        stderr: () => {},
      },
      { bench: 'locomo10' },
    );
    expect(result.exitCode).toBe(2);
  });

  it('honors --strategy full', async () => {
    const fake = makeFakeSpawn({ exitCode: 0 });
    const script = makeStubScriptPath();
    await runEval(
      {
        spawn: fake.spawn,
        resolveBenchScript: () => script,
        stdout: () => {},
        stderr: () => {},
      },
      { bench: 'longmemeval', strategy: 'full' },
    );
    expect(fake.state.calls[0]?.args).toContain('full');
  });

  it('routes subprocess stdout/stderr to the supplied writers', async () => {
    const fake = makeFakeSpawn({ exitCode: 0, stdout: 'OUT', stderr: 'ERR' });
    const script = makeStubScriptPath();
    const outBuf: string[] = [];
    const errBuf: string[] = [];
    await runEval(
      {
        spawn: fake.spawn,
        resolveBenchScript: () => script,
        stdout: (s) => outBuf.push(s),
        stderr: (s) => errBuf.push(s),
      },
      { bench: 'locomo10' },
    );
    expect(outBuf.join('')).toContain('OUT');
    expect(errBuf.join('')).toContain('ERR');
  });
});
