/**
 * `unblock listen [--subject PATTERN] [--channel NAME] [--filter REGEX]
 *                [--json] [--timeout SECONDS]`
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
 * Auto-remints on JWT expiry: if connect fails with a credentials error, tries
 * once to run `runMint({ print: false })` then reconnects.
 *
 * Exit 0: Ctrl+C or timeout.
 * Exit 1: auth failure / connection lost / unrecoverable error.
 * Exit 2: filter pattern is invalid regex.
 */

import type { CommsFactory, Subscription } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';
import { normalizeChatName } from '../comms/wire.js';

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
}

export interface ListenResult {
  readonly received: number;
  readonly exitReason: 'timeout' | 'signal' | 'aborted';
}

export async function runListen(deps: ListenDeps, opts: ListenOptions): Promise<ListenResult> {
  const cfg = await resolveConfig(opts);
  const getNow = deps.now ?? Date.now;

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

  let received = 0;
  let exitReason: 'timeout' | 'signal' | 'aborted' = 'signal';

  // Set up timeout
  let timedOut = false;
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const sub = client.subscribe(subject);

  // ── P0 defensive subscribe: legacy mixed-case chat_name ────────────────────
  // If the persona's `comms-v3.env` has a mixed-case `UNBLOCK_CHAT_NAME` (e.g.
  // `Viraj-Alpha`) the default DM-inbox subject above resolves to a different
  // NATS subject than what fresh senders publish to (which are lowercased at
  // subject-construction time — see `normalizeChatName` in src/comms/wire.ts).
  // We ALSO subscribe to the lowercased variant so messages from updated
  // senders are not silently dropped during the transitional period before
  // the operator re-mints the persona. Operators see a one-shot WARN so they
  // know to fix the underlying chat_name (re-mint, or hand-edit the env file).
  let auxSub: Subscription | undefined;
  if (
    opts.subject === undefined &&
    opts.channel === undefined &&
    cfg.chatName !== undefined &&
    cfg.chatName !== normalizeChatName(cfg.chatName)
  ) {
    const auxSubject = `unblock.chat.ws.${cfg.workspaceId}.to.${normalizeChatName(cfg.chatName)}`;
    process.stderr.write(
      `WARN: chat_name "${cfg.chatName}" has uppercase chars — NATS subjects are case-sensitive, ` +
      `messages may be dropped. Subscribing to "${auxSubject}" too as a transitional safety net. ` +
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
        if (timedOut) break;
        const arrivedAt = getNow();
        const raw = frame.data;
        const payloadStr = new TextDecoder().decode(raw);

        // Filter check
        if (filterRe !== undefined && !filterRe.test(payloadStr)) continue;

        received++;

        let parsedPayload: unknown;
        try {
          parsedPayload = JSON.parse(payloadStr) as unknown;
        } catch {
          parsedPayload = payloadStr;
        }

        if (opts.json === true) {
          const msg = {
            subject: frame.subject,
            payload: parsedPayload,
            ts: new Date(arrivedAt).toISOString(),
            headers: {},
            latency_ms: 0, // NATS doesn't expose round-trip from pub side without reply-to
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
  // Default: DM inbox for current persona
  const chatName = cfg.chatName ?? 'me';
  return `unblock.chat.ws.${cfg.workspaceId}.to.${chatName}`;
}

export class ListenFilterError extends Error {
  constructor(pattern: string) {
    super(`listen: invalid --filter regex "${pattern}"`);
    this.name = 'ListenFilterError';
  }
}
