/**
 * Tests for `unblock monitor` — wake-on-event watcher with routing hooks.
 *
 * The acceptance brief locks 8 behaviors. Each is exercised by its own
 * describe-block below; the headings mirror the brief's bullets for grep
 * traceability when something regresses.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  MonitorJetStreamUnavailableError,
  MonitorRegexError,
  runMonitor,
} from '../../src/commands/monitor.js';
import { writeCommsEnv } from '../../src/auth/persona-store.js';
import { createMockCommsFactory } from '../_fixtures/mock-comms.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
  await writeCommsEnv({
    natsUrl: 'tls://nats.kaeva.app:39899',
    credsPath: '/p',
    workspaceId: 'ws-default',
    orgId: 'org',
    chatName: 'viraj-alpha',
  });
});
afterEach(async () => {
  await tmp.dispose();
});

// ─── helpers ────────────────────────────────────────────────────────────────

/**
 * Poll until `subject` has at least one registered subscriber. Same shape
 * as listen.test.ts's helper — replaces flaky fixed-sleep waits when the
 * full suite runs in parallel.
 */
async function waitForSubscriber(
  state: { subscribers: Map<string, Set<unknown>> },
  subject: string,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((state.subscribers.get(subject)?.size ?? 0) > 0) return;
    await new Promise<void>((r) => setTimeout(r, 5));
  }
}

interface CapturedOut {
  readonly stdoutLines: string[];
  readonly stderrLines: string[];
  push(chunk: string, into: string[]): void;
  stdoutWrite(chunk: string): void;
  stderrWrite(chunk: string): void;
}

function makeOut(): CapturedOut {
  const out = {
    stdoutLines: [] as string[],
    stderrLines: [] as string[],
    push(chunk: string, into: string[]) {
      // Split on newlines but keep partial last fragment as a separate entry
      // when present. Tests assert on lines emitted whole, so we strip the
      // trailing '\n' that the implementation always appends.
      for (const line of chunk.split('\n')) {
        if (line === '') continue;
        into.push(line);
      }
    },
    stdoutWrite(chunk: string) {
      out.push(chunk, out.stdoutLines);
    },
    stderrWrite(chunk: string) {
      out.push(chunk, out.stderrLines);
    },
  };
  return out;
}

/**
 * Parse stdout lines as JSON envelopes. Skips lines that aren't JSON (which
 * shouldn't happen in --json mode but keeps the helper robust).
 */
function parseEnvelopes(lines: readonly string[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Push a frame into a mock subscriber for a given subject. */
function deliver(
  state: ReturnType<typeof createMockCommsFactory>['state'],
  subject: string,
  payload: unknown,
  opts: { reply?: string } = {},
): void {
  const subs = state.subscribers.get(subject);
  if (subs === undefined) return;
  const frame = {
    subject,
    data: new TextEncoder().encode(
      typeof payload === 'string' ? payload : JSON.stringify(payload),
    ),
    ...(opts.reply !== undefined ? { reply: opts.reply } : {}),
  };
  for (const cb of subs) cb(frame);
}

const INBOX_SUBJECT = 'unblock.chat.ws.ws-default.to.viraj-alpha';

// ─── 1. Default inbox subject + grep filter applied correctly ───────────────

describe('runMonitor default inbox + --grep', () => {
  it('subscribes to inbox by default and only emits events whose payload matches --grep', async () => {
    const { factory, state } = createMockCommsFactory();
    const out = makeOut();
    const ctrl = new AbortController();

    const runPromise = runMonitor(
      {
        commsFactory: factory,
        signal: ctrl.signal,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
      },
      { grep: 'NEEDLE', json: true, ephemeral: true },
    );

    await waitForSubscriber(state, INBOX_SUBJECT);
    expect(state.subscribers.has(INBOX_SUBJECT)).toBe(true);

    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'haystack' });
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'NEEDLE found' });

    await new Promise<void>((r) => setTimeout(r, 20));
    ctrl.abort();
    const result = await runPromise;

    expect(result.emitted).toBe(1);
    const envs = parseEnvelopes(out.stdoutLines);
    expect(envs.length).toBe(1);
    expect(envs[0]!['type']).toBe('event');
    const payload = envs[0]!['payload'] as Record<string, unknown>;
    expect(payload['msg']).toBe('NEEDLE found');
  });

  it('throws MonitorRegexError on invalid --grep regex', async () => {
    const { factory } = createMockCommsFactory();
    await expect(
      runMonitor({ commsFactory: factory }, { grep: '[[invalid', timeout: 0.01 }),
    ).rejects.toBeInstanceOf(MonitorRegexError);
  });

  it('throws MonitorRegexError on invalid --until regex', async () => {
    const { factory } = createMockCommsFactory();
    await expect(
      runMonitor({ commsFactory: factory }, { until: '*invalid', timeout: 0.01 }),
    ).rejects.toBeInstanceOf(MonitorRegexError);
  });
});

// ─── 2. --exec invoked once per event with correct stdin ────────────────────

describe('runMonitor --exec', () => {
  it('spawns the exec command once per event and pipes event JSON to stdin', async () => {
    const { factory, state } = createMockCommsFactory();
    const out = makeOut();
    const ctrl = new AbortController();

    const stdinWrites: string[] = [];
    const exits: Array<() => void> = [];

    const fakeSpawn = (): {
      stdin: {
        once: (ev: string, cb: (err: Error) => void) => void;
        end: (data: string, cb: () => void) => void;
      };
      once: (ev: string, cb: (code: number | null) => void) => void;
    } => {
      let exitCb: ((code: number | null) => void) | undefined;
      return {
        stdin: {
          once: () => undefined,
          end: (data: string, cb: () => void) => {
            stdinWrites.push(data);
            cb();
            // Defer exit so the next-event call to deliver() can stack a
            // second spawn behind the first via the serial-exec queue.
            setTimeout(() => {
              exits.push(() => exitCb?.(0));
              exitCb?.(0);
            }, 0);
          },
        },
        once: (ev: string, cb: (code: number | null) => void) => {
          if (ev === 'exit') exitCb = cb;
        },
      };
    };

    const runPromise = runMonitor(
      {
        commsFactory: factory,
        signal: ctrl.signal,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
        // Cast through unknown — the helper returns a structural subset of
        // ChildProcess that satisfies what the exec sink actually uses.
        execSpawn: fakeSpawn as unknown as (cmd: string) => import('node:child_process').ChildProcess,
      },
      { exec: 'true', json: true, ephemeral: true },
    );

    await waitForSubscriber(state, INBOX_SUBJECT);
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'one' });
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'two' });

    // Allow exec queue to drain
    await new Promise<void>((r) => setTimeout(r, 30));
    ctrl.abort();
    const result = await runPromise;

    expect(result.emitted).toBe(2);
    expect(stdinWrites.length).toBe(2);
    // Each stdin chunk should be one JSON envelope + newline.
    for (const chunk of stdinWrites) {
      const env = JSON.parse(chunk.trim()) as Record<string, unknown>;
      expect(env['type']).toBe('event');
      expect((env['payload'] as Record<string, unknown>)['source']).toBe('a');
    }
    expect((JSON.parse(stdinWrites[0]!.trim()) as Record<string, unknown>)['payload']).toMatchObject({
      msg: 'one',
    });
    expect((JSON.parse(stdinWrites[1]!.trim()) as Record<string, unknown>)['payload']).toMatchObject({
      msg: 'two',
    });
  });
});

// ─── 3. --webhook retry on 5xx; no retry on 4xx ─────────────────────────────

describe('runMonitor --webhook retries', () => {
  it('retries on 5xx up to 3 attempts then emits webhook_exhausted warning', async () => {
    const { factory, state } = createMockCommsFactory();
    const out = makeOut();
    const ctrl = new AbortController();

    const attempts: string[] = [];
    const fakeFetch = async (url: string, _body: string): Promise<{ status: number }> => {
      attempts.push(url);
      return { status: 500 };
    };

    const runPromise = runMonitor(
      {
        commsFactory: factory,
        signal: ctrl.signal,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
        webhookFetch: fakeFetch,
      },
      { webhook: 'https://example.test/hook', json: true, ephemeral: true },
    );

    await waitForSubscriber(state, INBOX_SUBJECT);
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'will fail' });

    // Backoff is 1+2 = 3s before the third attempt finishes. Wait long enough
    // for all three retries to land then abort.
    await new Promise<void>((r) => setTimeout(r, 3500));
    ctrl.abort();
    const result = await runPromise;

    expect(attempts.length).toBe(3);
    expect(result.warnings).toBeGreaterThanOrEqual(1);
    const envs = parseEnvelopes(out.stdoutLines);
    const exhausted = envs.find(
      (e) => e['type'] === 'monitor.warning' && e['reason'] === 'webhook_exhausted',
    );
    expect(exhausted).toBeDefined();
  }, 10000);

  it('does NOT retry on 4xx and emits webhook_4xx warning exactly once', async () => {
    const { factory, state } = createMockCommsFactory();
    const out = makeOut();
    const ctrl = new AbortController();

    let calls = 0;
    const fakeFetch = async (): Promise<{ status: number }> => {
      calls++;
      return { status: 404 };
    };

    const runPromise = runMonitor(
      {
        commsFactory: factory,
        signal: ctrl.signal,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
        webhookFetch: fakeFetch,
      },
      { webhook: 'https://example.test/hook', json: true, ephemeral: true },
    );

    await waitForSubscriber(state, INBOX_SUBJECT);
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'bad-payload' });

    await new Promise<void>((r) => setTimeout(r, 50));
    ctrl.abort();
    await runPromise;

    expect(calls).toBe(1);
    const envs = parseEnvelopes(out.stdoutLines);
    const fourXx = envs.filter(
      (e) => e['type'] === 'monitor.warning' && e['reason'] === 'webhook_4xx',
    );
    expect(fourXx.length).toBe(1);
  });

  it('--quiet-failures suppresses the warning envelope for 5xx exhaustion', async () => {
    const { factory, state } = createMockCommsFactory();
    const out = makeOut();
    const ctrl = new AbortController();

    const fakeFetch = async (): Promise<{ status: number }> => ({ status: 500 });

    const runPromise = runMonitor(
      {
        commsFactory: factory,
        signal: ctrl.signal,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
        webhookFetch: fakeFetch,
      },
      { webhook: 'https://example.test/hook', json: true, quietFailures: true, ephemeral: true },
    );

    await waitForSubscriber(state, INBOX_SUBJECT);
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'silenced' });

    await new Promise<void>((r) => setTimeout(r, 3500));
    ctrl.abort();
    await runPromise;

    const envs = parseEnvelopes(out.stdoutLines);
    const warns = envs.filter((e) => e['type'] === 'monitor.warning');
    expect(warns.length).toBe(0);
  }, 10000);
});

// ─── 4. --until <regex> exits 0 on match ────────────────────────────────────

describe('runMonitor --until', () => {
  it('exits 0 with exitReason=until on first matching event', async () => {
    const { factory, state } = createMockCommsFactory();
    const out = makeOut();

    const runPromise = runMonitor(
      {
        commsFactory: factory,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
      },
      { until: 'test-event', json: true, timeout: 5, ephemeral: true },
    );

    await waitForSubscriber(state, INBOX_SUBJECT);
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'just a chatty msg' });
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'test-event present' });

    const result = await runPromise;
    expect(result.exitReason).toBe('until');
    expect(result.exitCode).toBe(0);
    // First non-matching frame must have been emitted too (it's still
    // a valid event by the inbox filter — we only suppress on grep, not
    // on --until).
    expect(result.emitted).toBeGreaterThanOrEqual(1);
  });
});

// ─── 5. --timeout N exits 0 cleanly (no .catch crash, safeStop pattern) ─────

describe('runMonitor --timeout (clean exit, no crash)', () => {
  it('exits 0 with exitReason=timeout when no events arrive', async () => {
    const { factory } = createMockCommsFactory();
    const out = makeOut();

    const result = await runMonitor(
      {
        commsFactory: factory,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
      },
      { timeout: 0.05, json: true },
    );

    expect(result.exitReason).toBe('timeout');
    expect(result.exitCode).toBe(0);
    expect(result.emitted).toBe(0);
  });

  it('--timeout survives abort during JS replay setup (safeStop regression)', async () => {
    // Mirrors listen.test.ts's "survives abort during JS setup race".
    const { factory } = createMockCommsFactory();
    const ctrl = new AbortController();
    ctrl.abort(); // abort BEFORE runMonitor even starts

    const result = await runMonitor(
      { commsFactory: factory, signal: ctrl.signal },
      { since: '5m', json: true, timeout: 0.05 },
    );

    // No crash — either aborted or timeout is acceptable.
    expect(['aborted', 'timeout']).toContain(result.exitReason);
    expect(result.exitCode).toBe(0);
  });
});

// ─── 6. --durable creates named JetStream consumer ──────────────────────────

describe('runMonitor --durable', () => {
  it('opens a JetStream consumer with the given durable name', async () => {
    const { factory, state } = createMockCommsFactory();

    await runMonitor(
      { commsFactory: factory },
      { durable: 'my-monitor-cursor', timeout: 0.05, json: true },
    );

    expect(state.jsConsumeCalls.length).toBe(1);
    expect(state.jsConsumeCalls[0]!.durableName).toBe('my-monitor-cursor');
    expect(state.jsConsumeCalls[0]!.filterSubject).toBe(INBOX_SUBJECT);
  });

  it('throws MonitorJetStreamUnavailableError when replay requested against non-JS client', async () => {
    const factoryNoJs = {
      connect: async () => ({
        publish: () => undefined,
        subscribe: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async () => ({ value: undefined, done: true } as const),
          }),
          unsubscribe: () => undefined,
        }),
        flush: async () => undefined,
        close: async () => undefined,
      }),
    };

    const result = await runMonitor(
      { commsFactory: factoryNoJs },
      { replayAll: true, timeout: 0.05 },
    );
    // The error path emits a fatal envelope and returns exit=1 rather than
    // throwing — the source-error branch catches it.
    expect(result.exitReason).toBe('fatal');
    expect(result.exitCode).toBe(1);
  });
});

// ─── 7. Fatal envelope emitted on connection drop ───────────────────────────

describe('runMonitor coverage guarantee (fatal envelope on failures)', () => {
  it('emits a monitor.fatal envelope when commsFactory.connect throws', async () => {
    const out = makeOut();
    const factoryThatFails = {
      connect: async (): Promise<never> => {
        throw new Error('broker unreachable');
      },
    };

    const result = await runMonitor(
      {
        commsFactory: factoryThatFails,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
      },
      { json: true, timeout: 0.05 },
    );

    expect(result.exitReason).toBe('fatal');
    expect(result.exitCode).toBe(1);
    const envs = parseEnvelopes(out.stdoutLines);
    const fatal = envs.find((e) => e['type'] === 'monitor.fatal');
    expect(fatal).toBeDefined();
    expect(fatal!['reason']).toBe('connect_failed');
    expect(String(fatal!['detail'])).toContain('broker unreachable');
  });

  it('emits monitor.fatal when the subscribe iterator throws mid-stream', async () => {
    const out = makeOut();
    let iterFn: (() => Promise<IteratorResult<unknown>>) | undefined;

    const factoryThrowingIter = {
      connect: async () => ({
        publish: () => undefined,
        subscribe: () => ({
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<unknown>> => {
              if (iterFn !== undefined) return iterFn();
              throw new Error('upstream consumer died');
            },
          }),
          unsubscribe: () => undefined,
        }),
        flush: async () => undefined,
        close: async () => undefined,
      }),
    };

    const result = await runMonitor(
      {
        commsFactory: factoryThrowingIter,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
      },
      { json: true, timeout: 0.5, ephemeral: true },
    );

    expect(result.exitReason).toBe('fatal');
    const envs = parseEnvelopes(out.stdoutLines);
    const fatal = envs.find((e) => e['type'] === 'monitor.fatal');
    expect(fatal).toBeDefined();
    expect(String(fatal!['reason'])).toContain('subscribe_iterator_error');
  });
});

// ─── 8. --batch coalesces multiple events within window ─────────────────────

describe('runMonitor --batch', () => {
  it('coalesces events arriving within the batch window into a single emit cycle', async () => {
    const { factory, state } = createMockCommsFactory();
    const out = makeOut();
    const ctrl = new AbortController();

    const runPromise = runMonitor(
      {
        commsFactory: factory,
        signal: ctrl.signal,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
      },
      { batch: 100, json: true, ephemeral: true },
    );

    await waitForSubscriber(state, INBOX_SUBJECT);

    // 5 events delivered back-to-back within the 100ms batch window.
    for (let i = 0; i < 5; i++) {
      deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: `m${String(i)}` });
    }

    // Wait past the batch flush boundary.
    await new Promise<void>((r) => setTimeout(r, 150));
    ctrl.abort();
    const result = await runPromise;

    // All 5 events should be emitted as 'event' envelopes — batching
    // groups them into one flush call, not one envelope.
    expect(result.emitted).toBe(5);
    const events = parseEnvelopes(out.stdoutLines).filter((e) => e['type'] === 'event');
    expect(events.length).toBe(5);
  });
});

// ─── extras: --kind / --from filters (covers brief's filter surface) ────────

describe('runMonitor envelope filters', () => {
  it('--kind dm matches only dm-kind envelopes', async () => {
    const { factory, state } = createMockCommsFactory();
    const out = makeOut();
    const ctrl = new AbortController();

    const runPromise = runMonitor(
      {
        commsFactory: factory,
        signal: ctrl.signal,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
      },
      { kind: 'dm', json: true, ephemeral: true },
    );

    await waitForSubscriber(state, INBOX_SUBJECT);
    deliver(state, INBOX_SUBJECT, { kind: 'firehose', source: 'a', msg: 'broadcast' });
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'a', msg: 'direct' });
    deliver(state, INBOX_SUBJECT, { kind: 'ack', source: 'a' });

    await new Promise<void>((r) => setTimeout(r, 20));
    ctrl.abort();
    const result = await runPromise;

    expect(result.emitted).toBe(1);
    const events = parseEnvelopes(out.stdoutLines).filter((e) => e['type'] === 'event');
    expect(events.length).toBe(1);
    expect((events[0]!['payload'] as Record<string, unknown>)['kind']).toBe('dm');
  });

  it('--from matches case-insensitively on envelope.source', async () => {
    const { factory, state } = createMockCommsFactory();
    const out = makeOut();
    const ctrl = new AbortController();

    const runPromise = runMonitor(
      {
        commsFactory: factory,
        signal: ctrl.signal,
        stdoutWrite: out.stdoutWrite,
        stderrWrite: out.stderrWrite,
      },
      { from: 'Viraj-Alpha', json: true, ephemeral: true },
    );

    await waitForSubscriber(state, INBOX_SUBJECT);
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'someone-else', msg: 'no' });
    deliver(state, INBOX_SUBJECT, { kind: 'dm', source: 'viraj-alpha', msg: 'yes' });

    await new Promise<void>((r) => setTimeout(r, 20));
    ctrl.abort();
    const result = await runPromise;

    expect(result.emitted).toBe(1);
    const events = parseEnvelopes(out.stdoutLines).filter((e) => e['type'] === 'event');
    expect((events[0]!['payload'] as Record<string, unknown>)['msg']).toBe('yes');
  });
});

// ─── extras: --topic preset resolution ──────────────────────────────────────

describe('runMonitor --topic preset', () => {
  it('--topic firehose subscribes to the workspace firehose subject', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const runPromise = runMonitor(
      { commsFactory: factory, signal: ctrl.signal },
      { topic: 'firehose', json: true, ephemeral: true },
    );

    await waitForSubscriber(state, 'unblock.chat.ws.ws-default.firehose');
    expect(state.subscribers.has('unblock.chat.ws.ws-default.firehose')).toBe(true);

    ctrl.abort();
    await runPromise;
  });

  it('--topic events subscribes to unblock.events.>', async () => {
    const { factory, state } = createMockCommsFactory();
    const ctrl = new AbortController();

    const runPromise = runMonitor(
      { commsFactory: factory, signal: ctrl.signal },
      { topic: 'events', ephemeral: true },
    );

    await waitForSubscriber(state, 'unblock.events.>');
    expect(state.subscribers.has('unblock.events.>')).toBe(true);

    ctrl.abort();
    await runPromise;
  });
});

// ─── smoke: error classes exported ──────────────────────────────────────────

describe('monitor error class exports', () => {
  it('MonitorRegexError + MonitorJetStreamUnavailableError are reachable', () => {
    expect(MonitorRegexError).toBeDefined();
    expect(MonitorJetStreamUnavailableError).toBeDefined();
  });
});

// ─── seamless durable default (issue #9: offline blackout fix) ────────────────

describe('runMonitor default durability', () => {
  it('defaults to a durable JetStream consumer with deliver_policy=new', async () => {
    const { factory, state } = createMockCommsFactory();

    await runMonitor({ commsFactory: factory }, { timeout: 0.05, json: true });

    expect(state.jsConsumeCalls.length).toBe(1);
    const call = state.jsConsumeCalls[0]!;
    expect(call.deliverPolicy.kind).toBe('new');
    expect(call.durableName).toMatch(/^cli-[a-z0-9]+-[0-9a-f]{10}$/);
    expect(call.filterSubject).toBe(INBOX_SUBJECT);
  });

  it('--ephemeral opts back into raw live-tail (no JetStream consumer)', async () => {
    const { factory, state } = createMockCommsFactory();

    await runMonitor({ commsFactory: factory }, { ephemeral: true, timeout: 0.05, json: true });

    expect(state.jsConsumeCalls.length).toBe(0);
    expect(state.subscribers.size).toBeGreaterThan(0);
  });
});
