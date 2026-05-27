/**
 * `unblock send <to> <msg> [--ack] [--timeout SECONDS] [--json]`
 *
 * Enhanced dm with optional acknowledgement. Extends `runDm` behaviour.
 *
 * When --ack is NOT set: behaves identically to `unblock dm`.
 * When --ack is set:
 *   1. Subscribe to a reply inbox (`_INBOX.<uid>`) BEFORE publishing.
 *   2. Publish the DM with `reply_to` set to that inbox subject.
 *   3. Wait up to --timeout seconds (default 30) for an ack message.
 *   4. Ack envelope: {kind:"ack", source:<recipient>, in_reply_to:<message_id>, ts}
 *   5. Exit 0 if ack received; exit 2 on timeout; exit 1 on send failure.
 *
 * The `message_id` is a deterministic UUID-v4-shaped string minted from the
 * message content + timestamp so callers can correlate in logs.
 *
 * Wire format:
 *   publish to DM subject + firehose (same as `unblock dm`)
 *   envelope: {kind:"dm", source, to, msg, message_id, reply_to?}
 *
 * --json output: {to, message_id, ack_received, ack_source?, ts, elapsed_ms}
 *
 * Exit codes:
 *   0 = success (ack received when --ack; sent when no --ack)
 *   1 = send failure
 *   2 = ack timeout (only when --ack)
 */

import { randomUUID } from 'node:crypto';
import type { CommsFactory } from '../sdk/types.js';
import { buildEnvelope, chatDmSubject, chatFirehoseSubject } from '../comms/wire.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface SendDeps {
  readonly commsFactory: CommsFactory;
  readonly now?: () => number;
}

export interface SendOptions extends ConfigOverrides {
  readonly to: string;
  readonly msg: string;
  /** When true, wait for an ack message from recipient. */
  readonly ack?: boolean;
  /** Seconds to wait for ack. Default 30. */
  readonly timeout?: number;
  /** Emit machine-readable JSON. */
  readonly json?: boolean;
}

export interface SendResult {
  readonly to: string;
  readonly messageId: string;
  /** Only present when --ack was passed. */
  readonly ackReceived?: boolean;
  readonly ackSource?: string;
  readonly ts: string;
  readonly elapsedMs: number;
  /** 0=ok, 2=ack-timeout */
  readonly exitCode: number;
}

export async function runSend(deps: SendDeps, opts: SendOptions): Promise<SendResult> {
  const cfg = await resolveConfig(opts);
  const getNow = deps.now ?? Date.now;

  if (cfg.chatName === undefined) {
    throw new Error(
      'No chat name configured. Run `unblock login <invite-code>` or pass --name <handle>.',
    );
  }

  const startMs = getNow();
  const messageId = randomUUID();
  const timeoutSec = opts.timeout ?? 30;

  // Build inbox subject for ack reply
  const inboxSubject = `_INBOX.${messageId.replace(/-/g, '')}`;

  const dmSubject = chatDmSubject(cfg.workspaceId, opts.to);
  const fhSubject = chatFirehoseSubject(cfg.workspaceId);

  const envelope = buildEnvelope(
    'dm',
    cfg.chatName,
    {
      to: opts.to,
      msg: opts.msg,
      message_id: messageId,
      ...(opts.ack === true ? { reply_to: inboxSubject } : {}),
    },
    deps.now,
  );

  const client = await deps.commsFactory.connect({
    url: cfg.natsUrl,
    ...(cfg.credsPath !== undefined ? { credsPath: cfg.credsPath } : {}),
  });

  let ackReceived = false;
  let ackSource: string | undefined;
  let exitCode = 0;

  try {
    if (opts.ack === true) {
      // Subscribe BEFORE publish (critical ordering)
      const sub = client.subscribe(inboxSubject);

      client.publish(dmSubject, envelope);
      client.publish(fhSubject, envelope);
      await client.flush();

      // Race: wait for ack vs timeout
      const ackWait = new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          sub.unsubscribe();
          resolve(false);
        }, timeoutSec * 1000);

        (async () => {
          try {
            for await (const frame of sub) {
              let parsed: Record<string, unknown> | undefined;
              try {
                parsed = JSON.parse(new TextDecoder().decode(frame.data)) as Record<string, unknown>;
              } catch {
                continue;
              }
              if (
                typeof parsed === 'object' &&
                parsed !== null &&
                (parsed['kind'] === 'ack' || parsed['in_reply_to'] === messageId)
              ) {
                ackSource = typeof parsed['source'] === 'string' ? parsed['source'] : undefined;
                clearTimeout(timer);
                sub.unsubscribe();
                resolve(true);
                return;
              }
            }
          } catch {
            // subscription closed
          }
          clearTimeout(timer);
          resolve(false);
        })().catch(() => {
          clearTimeout(timer);
          resolve(false);
        });
      });

      ackReceived = await ackWait;
      if (!ackReceived) exitCode = 2;
    } else {
      // Simple send — no ack
      client.publish(dmSubject, envelope);
      client.publish(fhSubject, envelope);
      await client.flush();
    }
  } finally {
    await client.close();
  }

  const elapsedMs = getNow() - startMs;

  return {
    to: opts.to,
    messageId,
    ...(opts.ack === true ? { ackReceived } : {}),
    ...(ackSource !== undefined ? { ackSource } : {}),
    ts: new Date(startMs).toISOString(),
    elapsedMs,
    exitCode,
  };
}
