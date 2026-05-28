/**
 * `unblock listen [--subject PATTERN] [--channel NAME] [--filter REGEX]
 *                [--json] [--timeout SECONDS]
 *                [--since DURATION|ISO] [--replay-all] [--durable NAME]
 *                [--reset-durable] [--no-ack]`
 *
 * Long-running NATS subscribe for receive loops.
 *
 * Default subject = the user's DM inbox: unblock.chat.ws.<workspace>.to.<chatName>
 * --channel NAME  = unblock.channel.<name>.>
 * --subject PATTERN overrides both (accepts NATS wildcards * and >)
 *
 * Each received message is printed to stdout:
 *   - plain:  <ts> [<subject>] <payload>  (took Nms)
 *   - --json: one JSON object per message: {subject, payload, ts, headers, latency_ms}
 *
 * --filter REGEX: only print messages where JSON.stringify(payload) matches regex.
 * --timeout SECONDS: exit after N seconds (exit 0); omit = run forever.
 *
 * Auto-ack (fixes `unblock send --ack` always-timeout bug, 2026-05-28):
 *   When an incoming envelope carries a NATS request-reply `reply` subject (set
 *   by `unblock send --ack`), this listener publishes a tiny ack envelope to
 *   that subject BEFORE printing. Opt out with --no-ack. Ack shape:
 *     {kind:"ack", source:<my-chat-name>, in_reply_to:<envelope.message_id>,
 *      received_at:<iso-8601>, ts:<unix-ms>}
 *
 * JetStream replay (issue #9: messages sent while offline are dropped):
 *   NATS core pub/sub is live-tail only. The `UNBLOCK_CHAT` JetStream stream
 *   retains 30 days of messages server-side; opt into replay with:
 *     --since 1h | 30m | 7d | <ISO>   replay from that point onward
 *     --replay-all                    replay everything in retention
 *     --durable NAME                  named consumer; cursor persists
 *     --reset-durable                 delete/recreate named durable first
 *   Any of those three flags switches to JetStream consume. Bare `listen`
 *   keeps the raw subscribe code-path (lower latency, no replay).
 *
 * Exit 0: Ctrl+C or timeout.
 * Exit 1: auth failure / connection lost / unrecoverable error.
 * Exit 2: filter pattern is invalid regex, OR a replay flag was passed but
 *         the comms client doesn't expose a JetStream surface.
 */

import type {
  CommsClient,
  CommsFactory,
  DeliverPolicy,
  JetStreamFrame,
  Subscription,
} from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';
import { normalizeChatName } from '../comms/wire.js';

/** JetStream stream name configured server-side. */
const UNBLOCK_CHAT_STREAM = 'UNBLOCK_CHAT';

export interface ListenDeps {
  readonly commsFactory: CommsFactory;
  readonly now?: () => number;
  /** Abort signal for controlled shutdown (tests). */
  readonly signal?: AbortSignal;
}

export interface ListenOptions extends ConfigOverrides {
  /** NATS subject filter with wildcards. */
  readonly subject?: string;
  /** Convenience: subscribe to unblock.channel.<name>.> */
  readonly channel?: string;
  /** Regex filter on message body. */
  readonly filter?: string;
  /** Emit one JSON object per message. */
  readonly json?: boolean;
  /** Exit after N seconds. */
  readonly timeout?: number;
  /**
   * Disable auto-ack on incoming request-reply messages. Default is to ack
   * (fixes the 2026-05-28 `send --ack` always-timeout bug).
   */
  readonly noAck?: boolean;
  /**
   * Replay messages from a point in time: ISO-8601 timestamp OR a duration
   * like `1h`, `30m`, `7d`, `45s`. Switches to JetStream consume.
   */
  readonly since?: string;
  /**
   * Replay everything in the JetStream retention window (30d server-side).
   * Switches to JetStream consume.
   */
  readonly replayAll?: boolean;
  /**
   * Use a named durable JetStream consumer so the cursor persists across
   * restarts. Switches to JetStream consume.
   */
  readonly durable?: string;
  /**
   * Delete any existing named durable before creating it. Requires
   * `durable`; useful when intentionally changing subject or replay config.
   */
  readonly resetDurable?: boolean;
}

export interface ListenResult {
  readonly received: number;
  readonly exitReason: 'timeout' | 'signal' | 'aborted';
}

export async function runListen(deps: ListenDeps, opts: ListenOptions): Promise<ListenResult> {
  const cfg = await resolveConfig(opts);
  const getNow = deps.now ?? Date.now;
  if (opts.resetDurable === true && opts.durable === undefined) {
    throw new ListenResetDurableError();
  }

  // Compile filter regex if provided
  let filterRe: RegExp | undefined;
  if (opts.filter !== undefined) {
    try {
      filterRe = new RegExp(opts.filter);
    } catch {
      throw new ListenFilterError(opts.filter);
    }
  }

  // Resolve subject
  const subject = resolveSubject(opts, {
    workspaceId: cfg.workspaceId,
    chatName: cfg.chatName !== undefined ? cfg.chatName : undefined,
  });

  const client = await deps.commsFactory.connect({
    url: cfg.natsUrl,
    ...(cfg.credsPath !== undefined ? { credsPath: cfg.credsPath } : {}),
  });

  // Decide replay vs live-tail BEFORE setting up subscribers. Any replay flag
  // → JetStream consume; otherwise raw subscribe (unchanged behaviour).
  const replayMode = pickReplayMode(opts);

  let received = 0;
  let exitReason: 'timeout' | 'signal' | 'aborted' = 'signal';

  // Set up timeout
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  // Per-message handler — shared between raw subscribe and JetStream paths.
  // Returns false when the caller should stop iterating (timed out).
  const ackEnabled = opts.noAck !== true;
  const myChatName = cfg.chatName ?? 'me';
  const handleFrame = (
    frame: { readonly subject: string; readonly data: Uint8Array; readonly reply?: string },
  ): boolean => {
    if (timedOut) return false;
    const arrivedAt = getNow();
    const payloadStr = new TextDecoder().decode(frame.data);

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(payloadStr) as unknown;
    } catch {
      parsedPayload = payloadStr;
    }

    // Auto-ack BEFORE filter check + print so a non-matching filter still
    // unblocks the sender (the sender doesn't know our filter). Two paths:
    //   1. NATS request-reply: frame.reply set → publish ack there.
    //   2. Envelope-level reply_to (transport-agnostic; works through
    //      JetStream where `reply` isn't preserved): publish to that subject.
    if (ackEnabled) {
      const ackSubject =
        frame.reply ?? extractReplyToFromEnvelope(parsedPayload);
      if (ackSubject !== undefined && ackSubject !== '') {
        publishAck(client, ackSubject, parsedPayload, myChatName, arrivedAt);
      }
    }

    // Filter check
    if (filterRe !== undefined && !filterRe.test(payloadStr)) return true;

    received++;

    if (opts.json === true) {
      const msg = {
        subject: frame.subject,
        payload: parsedPayload,
        ts: new Date(arrivedAt).toISOString(),
        headers: {},
        latency_ms: 0,
      };
      process.stdout.write(`${JSON.stringify(msg)}\n`);
    } else {
      const ts = new Date(arrivedAt).toISOString();
      const preview =
        typeof parsedPayload === 'string'
          ? parsedPayload
          : JSON.stringify(parsedPayload);
      const snippet = preview.length > 200 ? `${preview.slice(0, 200)}…` : preview;
      process.stdout.write(`${ts} [${frame.subject}] ${snippet}\n`);
    }
    return true;
  };

  // Diagnostic: surface the subject the listener resolved to. JS subscribers
  // can be looking at the wrong subject for many reasons (mixed-case persona,
  // misspelled --channel, stale env), and the 2026-05-28 zero-events bug took
  // hours to triangulate precisely because we had no signal of which subject
  // was on the wire. Written to stderr so --json stdout stays parseable.
  // Suppress with UNBLOCK_LISTEN_QUIET=1 for scripting use-cases that pipe
  // stderr too.
  if (process.env['UNBLOCK_LISTEN_QUIET'] !== '1') {
    const mode = replayMode === null ? 'live-tail' : `js-replay(${replayMode.kind})`;
    process.stderr.write(`[listen] subscribing to subject: ${subject} mode=${mode}\n`);
  }

  if (replayMode !== null) {
    const jsResult = await runJetStreamReplay({
      client,
      subject,
      replayMode,
      ...(opts.durable !== undefined ? { durableName: opts.durable } : {}),
      ...(opts.resetDurable === true ? { resetDurable: true } : {}),
      ...(opts.timeout !== undefined ? { timeoutSec: opts.timeout } : {}),
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      handleFrame,
      onTimedOut: () => {
        timedOut = true;
      },
    });
    // `received` is incremented by handleFrame against the runListen closure,
    // not against runJetStreamReplay's local counter — return it here.
    return { received, exitReason: jsResult.exitReason };
  }

  const sub = client.subscribe(subject);

  // ── P0 defensive subscribe: legacy mixed-case chat_name ────────────────────
  // Symmetric to the wire-side normalization in `resolveSubject`. With the
  // 2026-05-28 fix, `subject` above is now the LOWERCASED form (matching
  // what every current sender publishes to). If the persona's
  // `UNBLOCK_CHAT_NAME` is still mixed-case in `comms-v3.env`, a legacy
  // sender that hasn't picked up the normalization will publish to the
  // mixed-case subject and we'd miss those messages — so we also subscribe
  // to the as-loaded mixed-case variant as a transitional safety net.
  // Operators see a one-shot WARN so they know to fix the underlying
  // chat_name (re-mint, or hand-edit the env file).
  let auxSub: Subscription | undefined;
  if (
    opts.subject === undefined &&
    opts.channel === undefined &&
    cfg.chatName !== undefined &&
    cfg.chatName !== normalizeChatName(cfg.chatName)
  ) {
    const auxSubject = `unblock.chat.ws.${cfg.workspaceId}.to.${cfg.chatName}`;
    process.stderr.write(
      `WARN: chat_name "${cfg.chatName}" has uppercase chars — NATS subjects are case-sensitive, ` +
      `messages may be dropped. Also subscribing to "${auxSubject}" as a transitional safety net for ` +
      `legacy senders that haven't been updated to lowercase recipients. ` +
      `Re-run \`unblock login <new-invite-code>\` (or hand-edit ~/.unblock/comms-v3.env) to lowercase it.\n`,
    );
    auxSub = client.subscribe(auxSubject);
  }

  // Use an AbortController-like mechanism for timeout
  const stopPromise = new Promise<'timeout' | 'aborted'>((resolve) => {
    if (opts.timeout !== undefined && opts.timeout > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        sub.unsubscribe();
        if (auxSub !== undefined) auxSub.unsubscribe();
        resolve('timeout');
      }, opts.timeout * 1000);
    }
    if (deps.signal !== undefined) {
      if (deps.signal.aborted) {
        sub.unsubscribe();
        if (auxSub !== undefined) auxSub.unsubscribe();
        resolve('aborted');
      } else {
        deps.signal.addEventListener('abort', () => {
          sub.unsubscribe();
          if (auxSub !== undefined) auxSub.unsubscribe();
          resolve('aborted');
        }, { once: true });
      }
    }
  });

  const pumpOne = async (s: Subscription): Promise<void> => {
    try {
      for await (const frame of s) {
        const carryOn = handleFrame(frame);
        if (!carryOn) break;
      }
    } catch {
      // Iterator closed (unsubscribed) — normal shutdown
    }
  };

  const listenPromise: Promise<void> = auxSub !== undefined
    ? Promise.all([pumpOne(sub), pumpOne(auxSub)]).then(() => undefined)
    : pumpOne(sub);

  const raceResult = await Promise.race([
    stopPromise,
    listenPromise.then(() => 'done' as const),
  ]);

  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);

  try {
    await client.close();
  } catch {
    /* best-effort */
  }

  exitReason =
    raceResult === 'timeout' ? 'timeout'
    : raceResult === 'aborted' ? 'aborted'
    : 'signal';

  return { received, exitReason };
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function resolveSubject(
  opts: ListenOptions,
  cfg: { workspaceId: string; chatName: string | undefined },
): string {
  if (opts.subject !== undefined) return opts.subject;
  if (opts.channel !== undefined) return `unblock.channel.${opts.channel}.>`;
  // Default: DM inbox for current persona. We lowercase the chat name to
  // match send/dm/ask's `chatDmSubject(...)` — those normalize via
  // `normalizeChatName()` in src/comms/wire.ts, so a listener that does NOT
  // normalize subscribes to a different subject than current senders publish
  // to. That mismatch was the 2026-05-28 P1 root cause for `--since 30m
  // --timeout 15` emitting 0 events on a legacy mixed-case persona
  // (`UNBLOCK_CHAT_NAME=Viraj-Alpha`): the JetStream consumer's
  // `filter_subject` was mixed-case while every retained message in the
  // 30-day window was published to the lowercased subject.
  //
  // For raw subscribe (non-JetStream) the auxSub double-subscribe in
  // runListen() still adds the mixed-case variant on top, so legacy senders
  // that haven't been updated yet are also covered.
  const chatName = cfg.chatName !== undefined ? normalizeChatName(cfg.chatName) : 'me';
  return `unblock.chat.ws.${cfg.workspaceId}.to.${chatName}`;
}

/**
 * Pick the JetStream deliver-policy from the user's replay flags. Returns
 * null when no replay flag was given (caller uses raw subscribe instead).
 *
 * Precedence: --replay-all > --since > --durable.
 */
function pickReplayMode(opts: ListenOptions): DeliverPolicy | null {
  if (opts.replayAll === true) return { kind: 'all' };
  if (opts.since !== undefined && opts.since.trim() !== '') {
    const startTime = parseSinceToIso(opts.since.trim());
    return { kind: 'by_start_time', startTime };
  }
  if (opts.durable !== undefined && opts.durable.trim() !== '') {
    return { kind: 'all' };
  }
  return null;
}

/**
 * Parse `--since` value into an ISO-8601 timestamp. Accepts:
 *   - relative durations: `1h`, `30m`, `7d`, `45s`, `2w`
 *   - ISO-8601 timestamps: `2026-05-27T12:00:00Z` (passed through)
 */
export function parseSinceToIso(value: string, now: number = Date.now()): string {
  if (value.includes('T') || /\d{4}-\d{2}-\d{2}/.test(value)) {
    const t = Date.parse(value);
    if (!Number.isNaN(t)) return new Date(t).toISOString();
  }
  const match = /^(\d+)\s*([smhdw])$/i.exec(value);
  if (match === null) throw new ListenSinceParseError(value);
  const n = Number.parseInt(match[1] ?? '0', 10);
  const unit = (match[2] ?? '').toLowerCase();
  const multMs: Record<string, number> = {
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  const mult = multMs[unit];
  if (mult === undefined) throw new ListenSinceParseError(value);
  return new Date(now - n * mult).toISOString();
}

/**
 * Extract an envelope-level reply-to subject if present. Senders that fan
 * out through JetStream lose the NATS `reply` header, so they include
 * `reply_to` in the JSON envelope.
 */
function extractReplyToFromEnvelope(payload: unknown): string | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const rec = payload as Record<string, unknown>;
  const v = rec['reply_to'];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/**
 * Publish an ack envelope. Fire-and-forget — never throws. Interop shape
 * with `unblock send --ack`'s consumer (commands/send.ts): matches on
 * `kind==='ack'` OR `in_reply_to===<message_id>`.
 */
function publishAck(
  client: CommsClient,
  ackSubject: string,
  envelope: unknown,
  source: string,
  receivedAtMs: number,
): void {
  let inReplyTo: string | undefined;
  if (typeof envelope === 'object' && envelope !== null) {
    const rec = envelope as Record<string, unknown>;
    if (typeof rec['message_id'] === 'string') inReplyTo = rec['message_id'];
  }
  const ack = {
    kind: 'ack',
    source,
    received_at: new Date(receivedAtMs).toISOString(),
    ts: receivedAtMs,
    ...(inReplyTo !== undefined ? { in_reply_to: inReplyTo } : {}),
  };
  try {
    client.publish(ackSubject, new TextEncoder().encode(JSON.stringify(ack)));
  } catch {
    /* ack is best-effort */
  }
}

interface JetStreamReplayDeps {
  readonly client: CommsClient;
  readonly subject: string;
  readonly replayMode: DeliverPolicy;
  readonly durableName?: string;
  readonly resetDurable?: boolean;
  readonly timeoutSec?: number;
  readonly signal?: AbortSignal;
  readonly handleFrame: (
    frame: { readonly subject: string; readonly data: Uint8Array; readonly reply?: string },
  ) => boolean;
  readonly onTimedOut: () => void;
}

async function runJetStreamReplay(d: JetStreamReplayDeps): Promise<ListenResult> {
  if (d.client.jetstream === undefined) {
    try {
      await d.client.close();
    } catch {
      /* best-effort */
    }
    throw new ListenJetStreamUnavailableError();
  }

  let exitReason: 'timeout' | 'signal' | 'aborted' = 'signal';

  const abortCtrl = new AbortController();
  const stopFn = (): void => {
    d.onTimedOut();
    abortCtrl.abort();
  };
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  if (d.timeoutSec !== undefined && d.timeoutSec > 0) {
    timeoutHandle = setTimeout(() => {
      exitReason = 'timeout';
      stopFn();
    }, d.timeoutSec * 1000);
  }
  if (d.signal !== undefined) {
    if (d.signal.aborted) {
      exitReason = 'aborted';
      stopFn();
    } else {
      d.signal.addEventListener(
        'abort',
        () => {
          exitReason = 'aborted';
          stopFn();
        },
        { once: true },
      );
    }
  }

  const consumeOpts = {
    stream: UNBLOCK_CHAT_STREAM,
    filterSubject: d.subject,
    deliverPolicy: d.replayMode,
    signal: abortCtrl.signal,
    ...(d.durableName !== undefined ? { durableName: d.durableName } : {}),
    ...(d.resetDurable === true ? { resetDurable: true } : {}),
  };

  try {
    for await (const frame of d.client.jetstream.consume(consumeOpts)) {
      const carryOn = d.handleFrame(frameFromJs(frame));
      // Always ack so the durable cursor advances.
      try {
        frame.ack();
      } catch {
        /* best-effort */
      }
      if (!carryOn) break;
    }
  } catch (err) {
    if (!abortCtrl.signal.aborted) {
      try {
        await d.client.close();
      } catch {
        /* best-effort */
      }
      throw err;
    }
  }

  if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  try {
    await d.client.close();
  } catch {
    /* best-effort */
  }
  // `received` is owned by the caller's closure-bound handleFrame; only
  // exitReason needs propagating back.
  return { received: 0, exitReason };
}

function frameFromJs(
  frame: JetStreamFrame,
): { readonly subject: string; readonly data: Uint8Array; readonly reply?: string } {
  return { subject: frame.subject, data: frame.data };
}

export class ListenFilterError extends Error {
  constructor(pattern: string) {
    super(`listen: invalid --filter regex "${pattern}"`);
    this.name = 'ListenFilterError';
  }
}

export class ListenSinceParseError extends Error {
  constructor(value: string) {
    super(
      `listen: --since "${value}" is neither an ISO-8601 timestamp nor a duration like 1h/30m/7d.`,
    );
    this.name = 'ListenSinceParseError';
  }
}

export class ListenJetStreamUnavailableError extends Error {
  constructor() {
    super(
      'listen: --since / --replay-all / --durable require a JetStream-capable broker. ' +
        'The current comms client does not expose one.',
    );
    this.name = 'ListenJetStreamUnavailableError';
  }
}

export class ListenResetDurableError extends Error {
  constructor() {
    super('listen: --reset-durable requires --durable NAME.');
    this.name = 'ListenResetDurableError';
  }
}
