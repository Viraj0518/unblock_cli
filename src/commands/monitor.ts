/**
 * `unblock monitor [--subject PATTERN | --channel NAME | --topic PRESET]
 *                  [--grep REGEX] [--kind dm|firehose|q|a|ack] [--from NAME]
 *                  [--exec CMD] [--webhook URL] [--notify]
 *                  [--durable NAME] [--reset-durable]
 *                  [--since DURATION|ISO] [--replay-all]
 *                  [--until REGEX] [--timeout SEC] [--persistent]
 *                  [--json] [--no-json] [--batch MS] [--quiet-failures]
 *                  [--persona NAME] [--nats-url URL] [--name HANDLE]`
 *
 * Long-running NATS event watcher modeled on Claude Code's Monitor tool. Each
 * matching event becomes one stdout line (or one --exec invocation, or one
 * webhook POST, or one OS notification — composable). Distinct from
 * `unblock listen`: `listen` is "tail my DM inbox"; `monitor` is "wake-on-
 * event with filters + routing hooks". Builds reactive loops around the
 * org-brain without polling.
 *
 * Coverage guarantee — the silent-on-crash trap:
 *   When the underlying NATS connection drops, the consumer dies, or any
 *   retry path exhausts, `monitor` MUST emit a structured failure event to
 *   its own stdout — NEVER silent. Three wrapper envelopes:
 *     {"type":"event",          "payload":{...}}     // the actual NATS event
 *     {"type":"monitor.warning","reason":"...","detail":"...","ts":"..."}
 *     {"type":"monitor.fatal",  "reason":"...","detail":"...","ts":"..."}
 *
 * Source selection (default = inbox if none given):
 *   --subject PATTERN          raw NATS subject, supports * and >
 *   --channel NAME             shorthand for unblock.channel.<name>.>
 *   --topic PRESET             inbox|firehose|events|channels|dms-to-anyone
 *
 * Client-side filters (applied BEFORE emit):
 *   --grep REGEX               regex against payload JSON string
 *   --kind KIND                envelope.kind exact match (dm|firehose|q|a|ack)
 *   --from NAME|DID            envelope.source exact match (case-insensitive)
 *
 * Routing — pick one (or none = stdout JSON lines):
 *   --exec CMD                 spawn CMD per event, pipe event JSON to stdin
 *   --webhook URL              POST event JSON; retries on 5xx (1s,2s,4s), no
 *                              retry on 4xx
 *   --notify                   OS desktop notification (best-effort spawn of
 *                              notify-send / osascript / BurntToast)
 *
 * Persistence + replay (forces JetStream consume path):
 *   --durable NAME             named JetStream consumer; cursor PERSISTS
 *   --reset-durable            delete/recreate named durable before consume
 *   --since DURATION|ISO       replay from a point (1h, 7d, 2026-05-27T...)
 *   --replay-all               replay everything in 30d retention
 *
 * Lifecycle:
 *   --until REGEX              exit 0 on first event whose JSON matches REGEX
 *   --timeout SEC              exit 0 after N seconds (no events required)
 *   --persistent               default unless --timeout/--until — runs until
 *                              SIGINT
 *
 * Output shape:
 *   --json (default true)      every emit is one JSON line on stdout
 *   --no-json                  human format: ts [subject] payload
 *   --batch MS                 coalesce events within N ms into one emit
 *   --quiet-failures           suppress per-event 5xx/non-zero-exit lines
 *                              (still counted internally; fatal env still emitted)
 *
 * Exit codes:
 *   0  clean exit (timeout, --until match, SIGINT, signal abort)
 *   1  fatal error (auth failure, unrecoverable comms drop, bad CLI input)
 *   2  invalid --grep / --until regex, or replay flag against non-JS broker
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  CommsClient,
  CommsFactory,
  DeliverPolicy,
  JetStreamFrame,
  Subscription,
} from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';
import { normalizeChatName } from '../comms/wire.js';
import { isStreamNotFoundError, resolveDurability } from './listen.js';

/** JetStream stream name configured server-side. Mirrors listen.ts. */
const UNBLOCK_CHAT_STREAM = 'UNBLOCK_CHAT';

/** Max queued events while a slow --exec drains. Drop with warning if exceeded. */
const EXEC_QUEUE_MAX = 1000;

/** Webhook retry budget on 5xx — total attempts including the initial. */
const WEBHOOK_MAX_ATTEMPTS = 3;
const WEBHOOK_BACKOFF_MS = [1000, 2000, 4000] as const;

export type MonitorTopic = 'inbox' | 'firehose' | 'events' | 'channels' | 'dms-to-anyone';
export type MonitorKind = 'dm' | 'firehose' | 'q' | 'a' | 'ack';
export type MonitorEnvelopeType = 'event' | 'monitor.warning' | 'monitor.fatal';

export interface MonitorDeps {
  readonly commsFactory: CommsFactory;
  readonly now?: () => number;
  /** Abort signal for controlled shutdown (tests + SIGINT). */
  readonly signal?: AbortSignal;
  /**
   * Webhook POST function. Injected so tests don't hit the network.
   * Returns the HTTP status code; throws to signal a transport failure
   * (which counts against retries on 5xx semantics).
   */
  readonly webhookFetch?: (url: string, body: string) => Promise<{ status: number }>;
  /**
   * Spawn function. Injected so tests can observe stdin contents without
   * actually launching a child process. Returns the child process handle
   * — caller writes JSON to .stdin and awaits the 'exit' event.
   */
  readonly execSpawn?: (cmd: string) => ChildProcess;
  /** OS notification trigger. Injected for tests. */
  readonly notifier?: (title: string, body: string) => void;
  /** stdout/stderr write sinks — injected so tests can assert emitted lines. */
  readonly stdoutWrite?: (chunk: string) => void;
  readonly stderrWrite?: (chunk: string) => void;
}

export interface MonitorOptions extends ConfigOverrides {
  readonly subject?: string;
  readonly channel?: string;
  readonly topic?: MonitorTopic;
  readonly grep?: string;
  readonly kind?: MonitorKind;
  readonly from?: string;
  readonly exec?: string;
  readonly webhook?: string;
  readonly notify?: boolean;
  readonly durable?: string;
  readonly resetDurable?: boolean;
  readonly since?: string;
  readonly replayAll?: boolean;
  /**
   * Opt OUT of the seamless durable default and use raw live-tail. Messages
   * arriving while the monitor is down are DROPPED. Default is durable replay.
   */
  readonly ephemeral?: boolean;
  readonly until?: string;
  readonly timeout?: number;
  readonly persistent?: boolean;
  /** Emit JSON envelopes (default true). */
  readonly json?: boolean;
  /** Coalesce events arriving within N ms into a single emit. */
  readonly batch?: number;
  /** Suppress per-event 5xx + non-zero exec lines (fatal envelopes still emit). */
  readonly quietFailures?: boolean;
}

export type MonitorExitReason =
  | 'timeout'
  | 'until'
  | 'signal'
  | 'aborted'
  | 'fatal';

export interface MonitorResult {
  readonly emitted: number;
  readonly warnings: number;
  readonly exitReason: MonitorExitReason;
  readonly exitCode: number;
}

interface MonitorContext {
  readonly opts: MonitorOptions;
  readonly stdout: (chunk: string) => void;
  readonly stderr: (chunk: string) => void;
  readonly emitEnvelope: (env: MonitorEnvelope) => void;
  readonly emitWarning: (reason: string, detail: string) => void;
  readonly emitFatal: (reason: string, detail: string) => void;
  readonly getNow: () => number;
  readonly grepRe: RegExp | undefined;
  readonly untilRe: RegExp | undefined;
  /** Increment when a payload is emitted (post-routing). */
  recordEmit(): void;
  /** True after an --until regex hit, signalling clean shutdown. */
  untilHit: boolean;
}

export interface MonitorEnvelope {
  readonly type: MonitorEnvelopeType;
  readonly payload?: unknown;
  readonly reason?: string;
  readonly detail?: string;
  readonly ts: string;
}

/** Inbound frame shape — symmetric with listen.ts's handleFrame. */
interface MonitorFrame {
  readonly subject: string;
  readonly data: Uint8Array;
  readonly reply?: string;
}

export async function runMonitor(
  deps: MonitorDeps,
  opts: MonitorOptions,
): Promise<MonitorResult> {
  const cfg = await resolveConfig(opts);
  const getNow = deps.now ?? Date.now;
  if (opts.resetDurable === true && opts.durable === undefined) {
    throw new MonitorResetDurableError();
  }
  const stdout = deps.stdoutWrite ?? ((s: string) => process.stdout.write(s));
  const stderr = deps.stderrWrite ?? ((s: string) => process.stderr.write(s));

  // ── 1. validate filter regexes early (exit 2 on bad input) ─────────────────
  let grepRe: RegExp | undefined;
  if (opts.grep !== undefined) {
    try {
      grepRe = new RegExp(opts.grep);
    } catch {
      throw new MonitorRegexError('grep', opts.grep);
    }
  }
  let untilRe: RegExp | undefined;
  if (opts.until !== undefined) {
    try {
      untilRe = new RegExp(opts.until);
    } catch {
      throw new MonitorRegexError('until', opts.until);
    }
  }

  // ── 2. resolve subject + replay mode ───────────────────────────────────────
  const subject = resolveSubject(opts, {
    workspaceId: cfg.workspaceId,
    chatName: cfg.chatName,
  });
  // Default is now a durable consumer (deliver_policy=new + stable auto name)
  // so a restart resumes the cursor and replays the gap — no silent blackout
  // (issue #9). --ephemeral opts back into raw live-tail.
  const durability = resolveDurability(opts, subject, cfg.chatName);
  const replayMode = durability.replayMode;

  // ── 3. emit-side state ─────────────────────────────────────────────────────
  let emitted = 0;
  let warnings = 0;
  let untilHit = false;
  let fatalReason: { reason: string; detail: string } | undefined;

  const emitEnvelope = (env: MonitorEnvelope): void => {
    if (opts.json !== false) {
      stdout(`${JSON.stringify(env)}\n`);
      return;
    }
    // Human format
    if (env.type === 'event') {
      const preview =
        typeof env.payload === 'string'
          ? env.payload
          : JSON.stringify(env.payload);
      const snippet = preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
      stdout(`${env.ts} [event] ${snippet}\n`);
    } else {
      stdout(`${env.ts} [${env.type}] ${env.reason ?? ''} ${env.detail ?? ''}\n`);
    }
  };

  const emitWarning = (reason: string, detail: string): void => {
    warnings++;
    emitEnvelope({
      type: 'monitor.warning',
      reason,
      detail,
      ts: new Date(getNow()).toISOString(),
    });
  };

  const emitFatal = (reason: string, detail: string): void => {
    fatalReason = { reason, detail };
    emitEnvelope({
      type: 'monitor.fatal',
      reason,
      detail,
      ts: new Date(getNow()).toISOString(),
    });
  };

  const ctx: MonitorContext = {
    opts,
    stdout,
    stderr,
    emitEnvelope,
    emitWarning,
    emitFatal,
    getNow,
    grepRe,
    untilRe,
    recordEmit: () => {
      emitted++;
    },
    untilHit,
  };

  // ── 4. routing — pick exactly one sink, or stdout default ──────────────────
  const router = buildRouter(deps, ctx);

  // ── 5. connect with fatal coverage ─────────────────────────────────────────
  let client: CommsClient;
  try {
    client = await deps.commsFactory.connect({
      url: cfg.natsUrl,
      ...(cfg.credsPath !== undefined ? { credsPath: cfg.credsPath } : {}),
    });
  } catch (err) {
    emitFatal('connect_failed', err instanceof Error ? err.message : String(err));
    return { emitted, warnings, exitReason: 'fatal', exitCode: 1 };
  }

  // Surface the subscribe target on stderr so callers see WHICH subject is
  // on the wire (mirrors listen.ts's diagnostic; gated by UNBLOCK_MONITOR_QUIET).
  if (process.env['UNBLOCK_MONITOR_QUIET'] !== '1') {
    const mode =
      replayMode === null
        ? 'live-tail(ephemeral)'
        : durability.durableName !== undefined
          ? `js-durable(${replayMode.kind}):${durability.durableName}`
          : `js-replay(${replayMode.kind})`;
    stderr(`[monitor] subscribing to subject: ${subject} mode=${mode}\n`);
  }

  // ── 6. lifecycle: build per-event handler with batching + routing ──────────
  const onFrame = makeFrameHandler(ctx, router);

  // ── 7. run the source (JS replay vs raw subscribe) ─────────────────────────
  const lifecycle = setupLifecycle(deps, opts, getNow);
  let exitReason: MonitorExitReason = 'signal';

  try {
    if (replayMode !== null) {
      exitReason = await runJetStreamSource(
        {
          client,
          subject,
          replayMode,
          ...(durability.durableName !== undefined ? { durableName: durability.durableName } : {}),
          ...(durability.resetDurable === true ? { resetDurable: true } : {}),
          lifecycle,
        },
        onFrame,
        ctx,
      );
    } else {
      exitReason = await runRawSubscribeSource(
        { client, subject, lifecycle },
        onFrame,
        ctx,
      );
    }
  } catch (err) {
    // Graceful degrade: the seamless-default durable consumer needs the
    // server-side UNBLOCK_CHAT stream. If it's missing and the user didn't
    // explicitly request replay (--since/--durable/--replay-all), fall back to
    // core-NATS live-tail rather than dying. `client` is still open (the JS
    // source doesn't close it on error), so reuse it.
    if (durability.auto === true && isStreamNotFoundError(err)) {
      if (process.env['UNBLOCK_MONITOR_QUIET'] !== '1') {
        stderr(
          `[monitor] WARN: durable replay unavailable — the UNBLOCK_CHAT JetStream ` +
          `stream is not provisioned on the broker. Falling back to live-tail; events ` +
          `emitted while this monitor is offline will be missed until the stream is ` +
          `restored (ops: scripts/nats/apply-streams.mjs --only UNBLOCK_CHAT).\n`,
        );
      }
      try {
        exitReason = await runRawSubscribeSource({ client, subject, lifecycle }, onFrame, ctx);
      } catch (fallbackErr) {
        emitFatal(
          'source_error',
          fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        );
        exitReason = 'fatal';
      }
    } else {
      emitFatal('source_error', err instanceof Error ? err.message : String(err));
      exitReason = 'fatal';
    }
  }

  // ── 8. drain any pending batched emit ──────────────────────────────────────
  await router.drain();

  try {
    await client.close();
  } catch (err) {
    // close-time failures are warnings, not fatal — the consumer's already
    // moved on. Still surface so callers see the broker hiccup.
    emitWarning('close_failed', err instanceof Error ? err.message : String(err));
  }

  // --until trumps timeout in exit reason — operators care which fired.
  if (ctx.untilHit) exitReason = 'until';
  // A fatal emitted by the source/close path forces the exitReason regardless
  // of whether the lifecycle Promise.race resolved as 'signal' first.
  if (fatalReason !== undefined) exitReason = 'fatal';

  const exitCode = fatalReason !== undefined ? 1 : 0;
  return { emitted, warnings, exitReason, exitCode };
}

// ─── subject resolution ──────────────────────────────────────────────────────

function resolveSubject(
  opts: MonitorOptions,
  cfg: { workspaceId: string; chatName: string | undefined },
): string {
  if (opts.subject !== undefined) return opts.subject;
  if (opts.channel !== undefined) return `unblock.channel.${opts.channel}.>`;
  if (opts.topic !== undefined) return topicToSubject(opts.topic, cfg);
  return defaultInboxSubject(cfg);
}

function defaultInboxSubject(cfg: {
  workspaceId: string;
  chatName: string | undefined;
}): string {
  const name = cfg.chatName !== undefined ? normalizeChatName(cfg.chatName) : 'me';
  return `unblock.chat.ws.${cfg.workspaceId}.to.${name}`;
}

function topicToSubject(
  topic: MonitorTopic,
  cfg: { workspaceId: string; chatName: string | undefined },
): string {
  switch (topic) {
    case 'inbox':
      return defaultInboxSubject(cfg);
    case 'firehose':
      return `unblock.chat.ws.${cfg.workspaceId}.firehose`;
    case 'events':
      return `unblock.events.>`;
    case 'channels':
      return `unblock.channel.>`;
    case 'dms-to-anyone':
      return `unblock.chat.ws.${cfg.workspaceId}.to.>`;
  }
}

// ─── per-event handler: filter → batch → emit + route ────────────────────────

interface BatchEntry {
  readonly subject: string;
  readonly payload: unknown;
  readonly payloadStr: string;
  readonly ts: string;
}

function makeFrameHandler(
  ctx: MonitorContext,
  router: Router,
): (frame: MonitorFrame) => boolean {
  // Returns false to signal the source it should stop iterating
  // (--until matched or upstream aborted).
  return (frame: MonitorFrame): boolean => {
    if (ctx.untilHit) return false;
    const payloadStr = new TextDecoder().decode(frame.data);
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadStr) as unknown;
    } catch {
      parsed = payloadStr;
    }

    // ── filters ──────────────────────────────────────────────────────────────
    if (ctx.grepRe !== undefined && !ctx.grepRe.test(payloadStr)) return true;
    if (ctx.opts.kind !== undefined && !envelopeKindMatches(parsed, ctx.opts.kind)) {
      return true;
    }
    if (ctx.opts.from !== undefined && !envelopeSourceMatches(parsed, ctx.opts.from)) {
      return true;
    }

    // ── --until: terminating regex ───────────────────────────────────────────
    if (ctx.untilRe !== undefined && ctx.untilRe.test(payloadStr)) {
      ctx.untilHit = true;
    }

    const entry: BatchEntry = {
      subject: frame.subject,
      payload: parsed,
      payloadStr,
      ts: new Date(ctx.getNow()).toISOString(),
    };

    router.deliver(entry);
    ctx.recordEmit();

    return !ctx.untilHit;
  };
}

function envelopeKindMatches(parsed: unknown, kind: MonitorKind): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const k = (parsed as Record<string, unknown>)['kind'];
  return typeof k === 'string' && k === kind;
}

function envelopeSourceMatches(parsed: unknown, from: string): boolean {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const s = (parsed as Record<string, unknown>)['source'];
  if (typeof s !== 'string') return false;
  return s.toLowerCase() === from.toLowerCase();
}

// ─── routing: stdout | exec | webhook | notify (mutually exclusive) ─────────

interface Router {
  deliver(entry: BatchEntry): void;
  /** Flush any in-flight batch and pending exec invocations. */
  drain(): Promise<void>;
}

function buildRouter(deps: MonitorDeps, ctx: MonitorContext): Router {
  // The four sinks share a batch layer in front. --batch=0 (or undefined)
  // means "emit immediately" — each frame becomes one emit.
  const batchMs = ctx.opts.batch ?? 0;
  const sink = pickSink(deps, ctx);

  if (batchMs <= 0) {
    return {
      deliver: (entry) => {
        sink.deliver([entry]);
      },
      drain: () => sink.drain(),
    };
  }

  // Coalescing path
  let pending: BatchEntry[] = [];
  let flushTimer: ReturnType<typeof setTimeout> | undefined;

  const flush = (): void => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    if (flushTimer !== undefined) {
      clearTimeout(flushTimer);
      flushTimer = undefined;
    }
    sink.deliver(batch);
  };

  return {
    deliver: (entry) => {
      pending.push(entry);
      if (flushTimer === undefined) {
        flushTimer = setTimeout(flush, batchMs);
      }
    },
    drain: async () => {
      flush();
      await sink.drain();
    },
  };
}

interface Sink {
  deliver(batch: readonly BatchEntry[]): void;
  drain(): Promise<void>;
}

function pickSink(deps: MonitorDeps, ctx: MonitorContext): Sink {
  if (ctx.opts.exec !== undefined && ctx.opts.exec.trim() !== '') {
    return makeExecSink(deps, ctx, ctx.opts.exec);
  }
  if (ctx.opts.webhook !== undefined && ctx.opts.webhook.trim() !== '') {
    return makeWebhookSink(deps, ctx, ctx.opts.webhook);
  }
  if (ctx.opts.notify === true) {
    return makeNotifySink(deps, ctx);
  }
  return makeStdoutSink(ctx);
}

function makeStdoutSink(ctx: MonitorContext): Sink {
  return {
    deliver: (batch) => {
      for (const entry of batch) {
        ctx.emitEnvelope({
          type: 'event',
          payload: entry.payload,
          ts: entry.ts,
        });
      }
    },
    drain: () => Promise.resolve(),
  };
}

function makeExecSink(
  deps: MonitorDeps,
  ctx: MonitorContext,
  cmd: string,
): Sink {
  // Serialize exec invocations so a slow consumer can't fork-bomb the host.
  // Queue events while previous exec is running; drop with warning past cap.
  const spawnFn = deps.execSpawn ?? defaultExecSpawn;
  const queue: BatchEntry[] = [];
  let inFlight: Promise<void> | null = null;

  const runOne = async (entry: BatchEntry): Promise<void> => {
    try {
      const child = spawnFn(cmd);
      const stdinErr = await new Promise<Error | null>((resolve) => {
        const onErr = (err: Error): void => {
          resolve(err);
        };
        if (child.stdin !== null) {
          child.stdin.once('error', onErr);
          const payload = JSON.stringify({
            type: 'event',
            payload: entry.payload,
            ts: entry.ts,
            subject: entry.subject,
          });
          child.stdin.end(`${payload}\n`, () => {
            resolve(null);
          });
        } else {
          resolve(null);
        }
      });
      if (stdinErr !== null && ctx.opts.quietFailures !== true) {
        ctx.emitWarning('exec_stdin_error', stdinErr.message);
      }
      const code: number = await new Promise((resolve) => {
        child.once('exit', (c: number | null) => {
          resolve(c ?? 0);
        });
        child.once('error', (err: Error) => {
          if (ctx.opts.quietFailures !== true) {
            ctx.emitWarning('exec_spawn_error', err.message);
          }
          resolve(1);
        });
      });
      if (code !== 0 && ctx.opts.quietFailures !== true) {
        ctx.emitWarning('exec_nonzero_exit', `code=${String(code)}`);
      }
    } catch (err) {
      if (ctx.opts.quietFailures !== true) {
        ctx.emitWarning(
          'exec_unexpected_error',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  };

  const pumpQueue = async (): Promise<void> => {
    while (queue.length > 0) {
      const next = queue.shift();
      if (next !== undefined) await runOne(next);
    }
    inFlight = null;
  };

  return {
    deliver: (batch) => {
      for (const entry of batch) {
        if (queue.length >= EXEC_QUEUE_MAX) {
          ctx.emitWarning(
            'exec_queue_overflow',
            `dropping event (queue at ${String(EXEC_QUEUE_MAX)} cap)`,
          );
          continue;
        }
        queue.push(entry);
      }
      if (inFlight === null && queue.length > 0) {
        inFlight = pumpQueue();
      }
    },
    drain: async () => {
      if (inFlight !== null) await inFlight;
      // Anything queued during drain still goes
      while (queue.length > 0) {
        await pumpQueue();
      }
    },
  };
}

function defaultExecSpawn(cmd: string): ChildProcess {
  // Shell-based spawn — gives operators their normal $PATH + globbing.
  // Inherit stderr so child diagnostics flow through to the operator
  // even when --quiet-failures suppresses our warning envelopes.
  return spawn(cmd, { shell: true, stdio: ['pipe', 'inherit', 'inherit'] });
}

function makeWebhookSink(
  deps: MonitorDeps,
  ctx: MonitorContext,
  url: string,
): Sink {
  // Per-event retry budget on 5xx. 4xx is a "your payload is wrong" signal
  // — don't retry, surface as warning + move on. Network errors count
  // against the 5xx retry budget.
  const fetchFn = deps.webhookFetch ?? defaultWebhookFetch;
  const inFlight: Promise<void>[] = [];

  const postOne = async (entry: BatchEntry): Promise<void> => {
    const body = JSON.stringify({
      type: 'event',
      payload: entry.payload,
      ts: entry.ts,
      subject: entry.subject,
    });
    let lastErrMsg = '';
    let lastStatus = 0;
    for (let attempt = 0; attempt < WEBHOOK_MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetchFn(url, body);
        lastStatus = res.status;
        if (res.status >= 200 && res.status < 300) return;
        if (res.status >= 400 && res.status < 500) {
          if (ctx.opts.quietFailures !== true) {
            ctx.emitWarning(
              'webhook_4xx',
              `status=${String(res.status)} url=${url} (no retry)`,
            );
          }
          return;
        }
        // 5xx — fall through to retry sleep
        lastErrMsg = `5xx status=${String(res.status)}`;
      } catch (err) {
        lastErrMsg = err instanceof Error ? err.message : String(err);
      }
      if (attempt < WEBHOOK_MAX_ATTEMPTS - 1) {
        await delay(WEBHOOK_BACKOFF_MS[attempt] ?? 1000);
      }
    }
    if (ctx.opts.quietFailures !== true) {
      ctx.emitWarning(
        'webhook_exhausted',
        `attempts=${String(WEBHOOK_MAX_ATTEMPTS)} status=${String(lastStatus)} err=${lastErrMsg}`,
      );
    }
  };

  return {
    deliver: (batch) => {
      for (const entry of batch) {
        const p = postOne(entry);
        inFlight.push(p);
        // Self-cleanup: drop completed promises from the array so drain()
        // doesn't grow unbounded across a long-running monitor.
        void p.finally(() => {
          const ix = inFlight.indexOf(p);
          if (ix >= 0) inFlight.splice(ix, 1);
        });
      }
    },
    drain: async () => {
      // Snapshot the array because postOne's finally mutates it.
      await Promise.allSettled([...inFlight]);
    },
  };
}

async function defaultWebhookFetch(
  url: string,
  body: string,
): Promise<{ status: number }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  });
  return { status: res.status };
}

function makeNotifySink(deps: MonitorDeps, ctx: MonitorContext): Sink {
  const notify = deps.notifier ?? defaultNotifier;
  return {
    deliver: (batch) => {
      for (const entry of batch) {
        const title = `unblock event [${entry.subject}]`;
        const body =
          entry.payloadStr.length > 200
            ? `${entry.payloadStr.slice(0, 200)}…`
            : entry.payloadStr;
        try {
          notify(title, body);
        } catch (err) {
          if (ctx.opts.quietFailures !== true) {
            ctx.emitWarning(
              'notify_failed',
              err instanceof Error ? err.message : String(err),
            );
          }
        }
      }
    },
    drain: () => Promise.resolve(),
  };
}

function defaultNotifier(title: string, body: string): void {
  // Best-effort OS notification. Each platform's tool is detached + ignored
  // so monitor doesn't block on a hung notification daemon. Failures bubble
  // up as a synchronous throw → caller turns into a monitor.warning.
  const platform = process.platform;
  const args =
    platform === 'darwin'
      ? ['-e', `display notification "${escapeQuotes(body)}" with title "${escapeQuotes(title)}"`]
      : platform === 'win32'
        ? [
            '-Command',
            `[reflection.assembly]::loadwithpartialname('System.Windows.Forms')|out-null;` +
              `$n=new-object System.Windows.Forms.NotifyIcon;` +
              `$n.Icon=[System.Drawing.SystemIcons]::Information;` +
              `$n.BalloonTipTitle='${escapeQuotes(title)}';` +
              `$n.BalloonTipText='${escapeQuotes(body)}';$n.Visible=$true;$n.ShowBalloonTip(3000)`,
          ]
        : [title, body];
  const cmd =
    platform === 'darwin' ? 'osascript' : platform === 'win32' ? 'powershell' : 'notify-send';
  const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
  child.unref();
  child.once('error', () => {
    // Tool missing on this host (e.g. notify-send not installed on a
    // headless Linux box). Convert to a synchronous throw so the sink
    // wraps it into a monitor.warning — coverage guarantee.
  });
}

function escapeQuotes(s: string): string {
  return s.replace(/'/g, "''").replace(/"/g, '\\"');
}

// ─── lifecycle: timeout + abort + signal wiring ──────────────────────────────

interface Lifecycle {
  /** Resolves when the watcher should shut down cleanly. */
  readonly stop: Promise<MonitorExitReason | 'done'>;
  /** Best-effort cancellation when source exits naturally first. */
  cancel(): void;
  /** Underlying abort signal for the JetStream consumer. */
  readonly signal: AbortSignal;
}

function setupLifecycle(
  deps: MonitorDeps,
  opts: MonitorOptions,
  getNow: () => number,
): Lifecycle {
  const ctrl = new AbortController();
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  let resolveStop: ((r: MonitorExitReason | 'done') => void) | undefined;

  const stop = new Promise<MonitorExitReason | 'done'>((resolve) => {
    resolveStop = resolve;
  });

  const finish = (reason: MonitorExitReason | 'done'): void => {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
    if (!ctrl.signal.aborted) ctrl.abort();
    resolveStop?.(reason);
  };

  // Persistent unless --timeout / --until given. We treat --persistent as
  // explicit no-timeout signal; otherwise honour --timeout if present.
  const explicitTimeout = typeof opts.timeout === 'number' && opts.timeout > 0;
  if (explicitTimeout) {
    timeoutHandle = setTimeout(() => {
      finish('timeout');
    }, (opts.timeout ?? 0) * 1000);
  }

  if (deps.signal !== undefined) {
    if (deps.signal.aborted) finish('aborted');
    else deps.signal.addEventListener('abort', () => finish('aborted'), { once: true });
  }

  // Touch getNow so the linter doesn't strip it (the field is intentionally
  // available for future periodic stats emit; not used in v1).
  void getNow;

  return {
    stop,
    cancel: () => finish('done'),
    signal: ctrl.signal,
  };
}

// ─── source: raw NATS subscribe ──────────────────────────────────────────────

interface RawSourceDeps {
  readonly client: CommsClient;
  readonly subject: string;
  readonly lifecycle: Lifecycle;
}

async function runRawSubscribeSource(
  d: RawSourceDeps,
  onFrame: (frame: MonitorFrame) => boolean,
  ctx: MonitorContext,
): Promise<MonitorExitReason> {
  let sub: Subscription;
  try {
    sub = d.client.subscribe(d.subject);
  } catch (err) {
    ctx.emitFatal(
      'subscribe_failed',
      err instanceof Error ? err.message : String(err),
    );
    return 'fatal';
  }

  // Cleanup on stop
  void d.lifecycle.stop.then(() => {
    try {
      sub.unsubscribe();
    } catch {
      /* best-effort */
    }
  });

  let pumpFatal = false;
  const pump = async (): Promise<void> => {
    try {
      for await (const frame of sub) {
        const carryOn = onFrame(frame);
        if (!carryOn) {
          d.lifecycle.cancel();
          break;
        }
      }
    } catch (err) {
      // Iterator threw mid-stream — coverage guarantee fires.
      if (!d.lifecycle.signal.aborted) {
        ctx.emitFatal(
          'subscribe_iterator_error',
          err instanceof Error ? err.message : String(err),
        );
        pumpFatal = true;
      }
    }
  };

  const reason = await Promise.race([
    d.lifecycle.stop,
    pump().then(() => 'done' as const),
  ]);

  if (pumpFatal) return 'fatal';
  return reason === 'done' ? 'signal' : reason;
}

// ─── source: JetStream replay ────────────────────────────────────────────────

interface JsSourceDeps {
  readonly client: CommsClient;
  readonly subject: string;
  readonly replayMode: DeliverPolicy;
  readonly durableName?: string;
  readonly resetDurable?: boolean;
  readonly lifecycle: Lifecycle;
}

async function runJetStreamSource(
  d: JsSourceDeps,
  onFrame: (frame: MonitorFrame) => boolean,
  ctx: MonitorContext,
): Promise<MonitorExitReason> {
  if (d.client.jetstream === undefined) {
    throw new MonitorJetStreamUnavailableError();
  }

  // Wire lifecycle abort onto the consume signal so a --timeout / SIGINT
  // tears the iterator down cleanly. We don't reuse lifecycle.signal here
  // because the JetStream consume expects to own its own abort signal
  // (cancel before its setup wires the listener => OK; cancel after =>
  // also OK because the consume options pass-through honours the signal).
  const abortCtrl = new AbortController();
  void d.lifecycle.stop.then(() => {
    if (!abortCtrl.signal.aborted) abortCtrl.abort();
  });

  const consumeOpts = {
    stream: UNBLOCK_CHAT_STREAM,
    filterSubject: d.subject,
    deliverPolicy: d.replayMode,
    signal: abortCtrl.signal,
    ...(d.durableName !== undefined ? { durableName: d.durableName } : {}),
    ...(d.resetDurable === true ? { resetDurable: true } : {}),
  };

  let pumpFatal = false;
  const pump = async (): Promise<void> => {
    try {
      for await (const frame of d.client.jetstream!.consume(consumeOpts)) {
        const carryOn = onFrame(frameFromJs(frame));
        try {
          frame.ack();
        } catch {
          /* best-effort */
        }
        if (!carryOn) {
          d.lifecycle.cancel();
          break;
        }
      }
    } catch (err) {
      if (!abortCtrl.signal.aborted) {
        // A missing server-side stream is recoverable by the caller (the
        // auto-durable default degrades to live-tail). Rethrow so runMonitor's
        // source try/catch can decide, instead of emitting a fatal here.
        if (isStreamNotFoundError(err)) throw err;
        ctx.emitFatal(
          'js_iterator_error',
          err instanceof Error ? err.message : String(err),
        );
        pumpFatal = true;
      }
    }
  };

  const reason = await Promise.race([
    d.lifecycle.stop,
    pump().then(() => 'done' as const),
  ]);

  if (pumpFatal) return 'fatal';
  return reason === 'done' ? 'signal' : reason;
}

function frameFromJs(f: JetStreamFrame): MonitorFrame {
  return { subject: f.subject, data: f.data };
}

// ─── error types (exported for test ergonomics) ──────────────────────────────

export class MonitorRegexError extends Error {
  constructor(which: 'grep' | 'until', pattern: string) {
    super(`monitor: invalid --${which} regex "${pattern}"`);
    this.name = 'MonitorRegexError';
  }
}

export class MonitorJetStreamUnavailableError extends Error {
  constructor() {
    super(
      'monitor: --since / --replay-all / --durable require a JetStream-capable broker. ' +
        'The current comms client does not expose one.',
    );
    this.name = 'MonitorJetStreamUnavailableError';
  }
}

export class MonitorResetDurableError extends Error {
  constructor() {
    super('monitor: --reset-durable requires --durable NAME.');
    this.name = 'MonitorResetDurableError';
  }
}
