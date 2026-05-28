/**
 * Wire format — NATS subjects + JSON envelope.
 *
 * Subject builders match unblock_protocol's chat*Subject functions byte-for-byte.
 * Vendored here so the CLI doesn't take a hard local-path dep on a sibling
 * polyrepo that isn't published yet (per AGENTS.md §3 boundary contract,
 * which permits @unblock/protocol but it isn't on npm in Stage 2).
 *
 * TODO (Stage 3): once `unblock_protocol` publishes to npm, replace these
 * with `import { chatFirehoseSubject, ... } from "unblock_protocol"`.
 *
 * Source: unblock_protocol/src/subjects/index.ts (chatFirehoseSubject etc.)
 *         + unblock-v02-mig/packages/unblock-cli/src/commands/chat.ts
 *           (envelope shape — must match scripts/identity/persona_nats.py).
 */

import type { ChatEnvelope } from '../sdk/types.js';

// ─── subject builders (workspace-scoped, mirrors protocol) ───────────────────

const chatPrefix = (workspaceId: string): string => `unblock.chat.ws.${workspaceId}`;

/**
 * Canonicalize a chat handle to the form used on the wire.
 *
 * NATS subjects are case-sensitive (`unblock.chat.ws.<ws>.to.Viraj-Alpha` and
 * `...to.viraj-alpha` are DIFFERENT subjects). On 2026-05-28 a controlled
 * probe proved that sending to mixed-case `Viraj-Alpha` silently dropped
 * because the listener was subscribed under the lowercase `viraj-alpha` that
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
