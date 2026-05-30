/**
 * Wire format — NATS subjects + JSON envelope.
 *
 * Subject builders match the shared `@unblock/protocol` chat*Subject
 * functions byte-for-byte. Vendored here so the CLI doesn't take a hard
 * dep on a package that isn't published to npm yet (per AGENTS.md §3
 * boundary contract).
 *
 * TODO: once `@unblock/protocol` publishes to npm, replace these with
 * `import { chatFirehoseSubject, ... } from "@unblock/protocol"`.
 */

import { createHash } from 'node:crypto';
import type { ChatEnvelope } from '../sdk/types.js';

// ─── subject builders (workspace-scoped, mirrors protocol) ───────────────────

const chatPrefix = (workspaceId: string): string => `unblock.chat.ws.${workspaceId}`;

/**
 * Canonicalize a chat handle to the form used on the wire.
 *
 * NATS subjects are case-sensitive (`unblock.chat.ws.<ws>.to.My-Agent` and
 * `...to.my-agent` are DIFFERENT subjects). On 2026-05-28 a controlled
 * probe proved that sending to a mixed-case handle silently dropped
 * because the listener was subscribed under the lowercase handle that
 * the auth-issuer minted into the persona's `comms-v3.env`. No error, no
 * warning — worst kind of bug.
 *
 * Single fix point: every DM-recipient and every persona-name lookup goes
 * through this helper. That keeps the wire contract honest and matches the
 * enrollment normalization landing in auth-issuer
 * (`services/auth-issuer/src/handlers/identity-enroll.ts`, same PR).
 *
 * The normalization is intentionally trivial (lowercase) — chat handles are
 * ASCII-only in v0.1 (validated at enrollment). If we ever support unicode
 * handles, replace with a proper NFKC fold + lowercase.
 */
export function normalizeChatName(handle: string): string {
  return handle.toLowerCase();
}

/**
 * Derive a STABLE durable JetStream consumer name for the seamless-default
 * listen/monitor path (issue #9: bare `listen` was live-tail only, so any
 * disconnect silently dropped every message sent while offline — this cost
 * multiple personas multi-hour blackouts on 2026-05-28).
 *
 * Stability is the whole point: the same (chatName, subject) MUST map to the
 * same name across process restarts, so the durable's stored cursor resumes
 * and replays the gap instead of starting fresh. We derive from a sha256 of
 * the subject (subjects contain `.`/`*`/`>` which are illegal in NATS consumer
 * names) plus the persona handle for human-readability when listing consumers.
 *
 * Server-side, deriving the name is sufficient: a durable created once with
 * deliver_policy=new resumes from its ack-floor on every later `consume` with
 * the same name (see nats-client.ts `ensureConsumer`), so first launch starts
 * "from now" (no 30-day dump) and every restart replays only the missed gap.
 */
export function autoDurableName(subject: string, chatName: string | undefined): string {
  const handle = (chatName !== undefined ? normalizeChatName(chatName) : 'anon')
    .replace(/[^a-z0-9]/g, '')
    .slice(0, 24) || 'anon';
  const hash = createHash('sha256').update(subject).digest('hex').slice(0, 10);
  return `cli-${handle}-${hash}`;
}

export function chatFirehoseSubject(workspaceId: string): string {
  return `${chatPrefix(workspaceId)}.firehose`;
}

export function chatDmSubject(workspaceId: string, recipient: string): string {
  return `${chatPrefix(workspaceId)}.to.${normalizeChatName(recipient)}`;
}

export function chatQuestionSubject(workspaceId: string, questionId: string): string {
  return `${chatPrefix(workspaceId)}.q.${questionId}`;
}

export function chatReplySubject(workspaceId: string, questionId: string): string {
  return `${chatPrefix(workspaceId)}.a.${questionId}`;
}

// ─── envelope ────────────────────────────────────────────────────────────────

/**
 * Build a UTF-8 JSON envelope. Must match Python's _chat_envelope so
 * cross-runtime parity holds (Python pubs → Node subs and vice versa).
 *
 * `ts` is injected from the caller so tests can be deterministic.
 */
export function buildEnvelope(
  kind: string,
  source: string,
  extra: Readonly<Record<string, unknown>>,
  now: () => number = Date.now,
): Uint8Array {
  const payload: ChatEnvelope = { kind, source, ts: now(), ...extra };
  return new TextEncoder().encode(JSON.stringify(payload));
}

/**
 * Parse an envelope. Returns `null` on any decode/JSON/shape error
 * (the firehose is best-effort — bad frames are dropped, not thrown).
 */
export function parseEnvelope(data: Uint8Array): ChatEnvelope | null {
  try {
    const obj: unknown = JSON.parse(new TextDecoder().decode(data));
    if (
      typeof obj === 'object' &&
      obj !== null &&
      !Array.isArray(obj) &&
      typeof (obj as { kind?: unknown }).kind === 'string' &&
      typeof (obj as { source?: unknown }).source === 'string' &&
      typeof (obj as { ts?: unknown }).ts === 'number'
    ) {
      return obj as ChatEnvelope;
    }
  } catch {
    /* swallow */
  }
  return null;
}
