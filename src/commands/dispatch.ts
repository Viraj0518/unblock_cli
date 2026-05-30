/**
 * `unblock dispatch <payload_kind> <recipient_role> <content>
 *      [--intent DELEGATE] [--timeout SECONDS] [--json]`
 *
 * Client side of the auto-dispatch coordinator — the org-brain's reflex arc.
 * A blocked agent publishes an ASK to the coordinator and blocks until the
 * COMMITTED / REJECT / FYI reply (or --timeout). This is how a stuck neuron
 * gets the brain to dispatch help WITHOUT a human relay.
 *
 * Coordinator contract (mirrors unblock_coordinator/src/envelope.ts +
 * examples/live-dispatch-loop.mjs — do not invent):
 *
 *   publish subject : unblock.coord.dispatch.<asker>.<msgId>
 *                     (the coordinator subscribes to `unblock.coord.dispatch.>`)
 *   publish payload : the DispatchEnvelope
 *     { intent: "ASK"|"DELEGATE", payload_kind, recipient_role, asker,
 *       content, reply_to, msg_id, args? }
 *   reply subject   : unblock.coord.replies.<asker>.<msgId>  (== reply_to)
 *   reply payload   : the DispatchReply
 *     { kind: "COMMITTED"|"REJECT"|"FYI", msg_id?, asker, payload_kind,
 *       strategy, body, ts }
 *
 * asker  = the loaded persona's chat_name (same resolution say/dm/ask use).
 * msgId  = a fresh client-side id (crypto.randomUUID).
 *
 * The asker is used VERBATIM in the coord subject (NOT lowercased like the
 * case-sensitive chat-inbox tree): the coordinator routes on the asker as
 * given and publishes the reply back to `reply_to`, so both subjects must
 * match the asker byte-for-byte (see live-dispatch-loop.mjs's `Viraj-Alpha`).
 *
 * Exit codes (returned as `exitCode` on the result; main.ts sets process.exitCode):
 *   0  COMMITTED (or FYI — informational, the ask was accepted/handled)
 *   1  REJECT    (no matching routing rule / strategy refused / cost cap)
 *   2  timeout   (no reply within --timeout, default 120s)
 */

import type { CommsClient, CommsFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

// ─── coordinator wire types (mirror unblock_coordinator/src/envelope.ts) ─────

/** Inbound dispatch intent. The coordinator routes ASK + DELEGATE. */
export type DispatchIntent = 'ASK' | 'DELEGATE';

/** Outcome kind on the reply. */
export type DispatchOutcomeKind = 'COMMITTED' | 'REJECT' | 'FYI';

/** The envelope published to the dispatch subject. */
export interface DispatchEnvelope {
  readonly intent: DispatchIntent;
  readonly payload_kind: string;
  readonly recipient_role: string;
  readonly asker: string;
  readonly content: string;
  readonly reply_to: string;
  readonly msg_id: string;
  readonly args?: Record<string, unknown>;
}

/** The reply published back on `reply_to`. */
export interface DispatchReply {
  readonly kind: DispatchOutcomeKind;
  readonly msg_id?: string;
  readonly asker: string;
  readonly payload_kind: string;
  readonly strategy: string;
  readonly body: string;
  readonly ts: number;
}

// ─── pure subject builders (mirror chatQuestionSubject / chatReplySubject) ────

/**
 * Subject the coordinator subscribes to (`unblock.coord.dispatch.>`).
 * Asker is used verbatim — the coord namespace is independent of the
 * case-sensitive agent-inbox tree, and the coordinator example routes on
 * the asker exactly as sent.
 */
export function dispatchSubject(asker: string, msgId: string): string {
  return `unblock.coord.dispatch.${asker}.${msgId}`;
}

/** Subject the coordinator publishes the {@link DispatchReply} back on. */
export function dispatchReplySubject(asker: string, msgId: string): string {
  return `unblock.coord.replies.${asker}.${msgId}`;
}

// ─── command ─────────────────────────────────────────────────────────────────

export interface DispatchDeps {
  readonly commsFactory: CommsFactory;
  readonly now?: () => number;
  /** Test injection — defaults to `globalThis.crypto.randomUUID()`. */
  readonly randomUUID?: () => string;
}

export interface DispatchOptions extends ConfigOverrides {
  /** e.g. "code-review-needed" — routes to a coordinator rule. */
  readonly payloadKind: string;
  /** e.g. "senior", "sysops", "human". */
  readonly recipientRole: string;
  /** Free-form task description. */
  readonly content: string;
  /** When true, send intent=DELEGATE instead of the default ASK. */
  readonly delegate?: boolean;
  /** Strategy-specific args attached to the envelope. */
  readonly args?: Record<string, unknown>;
  /** Seconds to wait for the reply. Default 120. */
  readonly timeout?: number;
  /** Emit machine-readable JSON (consumed by main.ts). */
  readonly json?: boolean;
}

export interface DispatchResult {
  /** "COMMITTED" | "REJECT" | "FYI" when a reply landed, else "timeout". */
  readonly outcome: DispatchOutcomeKind | 'timeout';
  /** The parsed reply (absent on timeout / undecodable frame). */
  readonly reply?: DispatchReply;
  /** The msg_id this dispatch was published under (for logs / correlation). */
  readonly msgId: string;
  /** The asker this dispatch was published as. */
  readonly asker: string;
  /** 0=COMMITTED/FYI, 1=REJECT, 2=timeout. */
  readonly exitCode: number;
}

export async function runDispatch(
  deps: DispatchDeps,
  opts: DispatchOptions,
): Promise<DispatchResult> {
  const cfg = await resolveConfig(opts);
  if (cfg.chatName === undefined || cfg.chatName === '') {
    throw new Error(
      'No chat name configured. Run `unblock login <invite-code>` or pass --name <handle>.',
    );
  }

  const asker = cfg.chatName;
  const msgId = (deps.randomUUID ?? defaultRandomUUID)();
  const timeoutMs = (opts.timeout ?? 120) * 1000;

  const subject = dispatchSubject(asker, msgId);
  const replySubject = dispatchReplySubject(asker, msgId);

  const envelope: DispatchEnvelope = {
    intent: opts.delegate === true ? 'DELEGATE' : 'ASK',
    payload_kind: opts.payloadKind,
    recipient_role: opts.recipientRole,
    asker,
    content: opts.content,
    reply_to: replySubject,
    msg_id: msgId,
    ...(opts.args !== undefined ? { args: opts.args } : {}),
  };
  // The DispatchEnvelope carries NO `ts` (the coordinator's parseEnvelope does
  // not read one; only the reply carries `ts`). Serialize the contract shape
  // exactly — extra fields are ignored by the coordinator but we keep the wire
  // honest. See unblock_coordinator/examples/live-dispatch-loop.mjs.
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));

  const client = await deps.commsFactory.connect({
    url: cfg.natsUrl,
    ...(cfg.credsPath !== undefined ? { credsPath: cfg.credsPath } : {}),
  });

  try {
    // Subscribe to the reply BEFORE publishing so we don't race the
    // coordinator's reply (mirrors ask / send --ack ordering).
    const sub = client.subscribe(replySubject);
    client.publish(subject, bytes);
    await client.flush();

    const replyBytes = await firstReplyOrTimeout(sub, timeoutMs);
    if (replyBytes === null) {
      return { outcome: 'timeout', msgId, asker, exitCode: 2 };
    }
    const reply = parseReply(replyBytes);
    if (reply === null) {
      // Undecodable frame on the reply subject — treat as timeout (no usable
      // outcome) rather than crashing the caller.
      return { outcome: 'timeout', msgId, asker, exitCode: 2 };
    }
    return { outcome: reply.kind, reply, msgId, asker, exitCode: exitCodeFor(reply.kind) };
  } finally {
    await client.close();
  }
}

/** REJECT is the only non-zero outcome; COMMITTED + FYI are accepted. */
function exitCodeFor(kind: DispatchOutcomeKind): number {
  return kind === 'REJECT' ? 1 : 0;
}

type ReplySubscription = ReturnType<CommsClient['subscribe']>;

async function firstReplyOrTimeout(
  sub: ReplySubscription,
  timeoutMs: number,
): Promise<Uint8Array | null> {
  const reader = sub[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const readPromise = (async (): Promise<Uint8Array | null> => {
    const next = await reader.next();
    if (next.done === true) return null;
    return next.value.data;
  })();
  try {
    return await Promise.race([readPromise, timeoutPromise]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    sub.unsubscribe();
  }
}

/**
 * Parse a {@link DispatchReply} from raw bytes. Returns null on non-JSON,
 * non-object, or any missing/mis-typed required field (defensive — a garbage
 * frame on the reply subject must not crash the asker).
 */
function parseReply(data: Uint8Array): DispatchReply | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(data));
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null;
  }
  const o = parsed as Record<string, unknown>;
  const kind = o['kind'];
  if (kind !== 'COMMITTED' && kind !== 'REJECT' && kind !== 'FYI') return null;
  const asker = o['asker'];
  const payload_kind = o['payload_kind'];
  const strategy = o['strategy'];
  const body = o['body'];
  const ts = o['ts'];
  if (
    typeof asker !== 'string' ||
    typeof payload_kind !== 'string' ||
    typeof strategy !== 'string' ||
    typeof body !== 'string' ||
    typeof ts !== 'number'
  ) {
    return null;
  }
  const out: { -readonly [K in keyof DispatchReply]: DispatchReply[K] } = {
    kind,
    asker,
    payload_kind,
    strategy,
    body,
    ts,
  };
  const msg_id = o['msg_id'];
  if (typeof msg_id === 'string' && msg_id.length > 0) out.msg_id = msg_id;
  return out;
}

function defaultRandomUUID(): string {
  return globalThis.crypto.randomUUID();
}

/** Human-readable one-block summary printed by the CLI's default output. */
export function formatDispatch(result: DispatchResult): string {
  const lines = [`msg_id:   ${result.msgId}`, `outcome:  ${result.outcome}`];
  if (result.reply !== undefined) {
    lines.push(`strategy: ${result.reply.strategy}`);
    lines.push(`body:     ${result.reply.body}`);
  } else {
    lines.push(`body:     (no reply within timeout)`);
  }
  return lines.join('\n') + '\n';
}
