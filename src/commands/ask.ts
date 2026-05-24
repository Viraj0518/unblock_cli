/**
 * `unblock ask "<question>" --options=A,B,C --timeout=300 --default=abort`
 *
 * Blocking decision: publish question, subscribe to reply subject, return
 * first reply (or `default` after timeout). Exit code:
 *   0   reply received → printed to stdout
 *   2   timeout fired + --default supplied → default printed to stdout
 *   1   no --default and timeout → error to stderr, no stdout
 *
 * The question_id is generated client-side (UUIDv4-ish via crypto.randomUUID).
 * Replies arrive on `unblock.chat.ws.<ws>.a.<question_id>` (also mirrored
 * to firehose by the responder's `unblock reply`).
 */

import type { CommsFactory } from '../sdk/types.js';
import {
  buildEnvelope,
  chatFirehoseSubject,
  chatQuestionSubject,
  chatReplySubject,
  parseEnvelope,
} from '../comms/wire.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface AskDeps {
  readonly commsFactory: CommsFactory;
  readonly now?: () => number;
  /** Test injection — defaults to `globalThis.crypto.randomUUID()`. */
  readonly randomUUID?: () => string;
}

export interface AskOptions extends ConfigOverrides {
  readonly question: string;
  readonly options?: string;
  /** Seconds to wait. Default 300. */
  readonly timeout?: number;
  readonly default?: string;
}

export interface AskResult {
  /** "reply" if a reply landed, "timeout" if we fell back to the default. */
  readonly outcome: 'reply' | 'timeout';
  /** Reply body (or the default value on timeout). */
  readonly answer: string;
  /** The question_id this ask was published under (for logs). */
  readonly questionId: string;
}

export async function runAsk(deps: AskDeps, opts: AskOptions): Promise<AskResult> {
  const cfg = await resolveConfig(opts);
  if (cfg.chatName === undefined) {
    throw new Error(
      'No chat name configured. Run `unblock login <invite-code>` or pass --name <handle>.',
    );
  }
  const questionId = (deps.randomUUID ?? defaultRandomUUID)();
  const timeoutMs = (opts.timeout ?? 300) * 1000;
  const options = parseOptions(opts.options);

  const askSubject = chatQuestionSubject(cfg.workspaceId, questionId);
  const replySubject = chatReplySubject(cfg.workspaceId, questionId);
  const firehoseSubject = chatFirehoseSubject(cfg.workspaceId);

  const askExtra: Record<string, unknown> = {
    question_id: questionId,
    msg: opts.question,
  };
  if (options !== undefined) askExtra['options'] = options;
  const askEnv = buildEnvelope('ask', cfg.chatName, askExtra, deps.now);

  const client = await deps.commsFactory.connect({
    url: cfg.natsUrl,
    ...(cfg.credsPath !== undefined ? { credsPath: cfg.credsPath } : {}),
  });

  try {
    // Subscribe BEFORE publishing so we don't race the reply.
    const sub = client.subscribe(replySubject);
    client.publish(askSubject, askEnv);
    client.publish(firehoseSubject, askEnv);
    await client.flush();

    const reply = await firstReplyOrTimeout(sub, timeoutMs);
    if (reply !== null) {
      return { outcome: 'reply', answer: extractMsg(reply), questionId };
    }
    if (opts.default !== undefined) {
      return { outcome: 'timeout', answer: opts.default, questionId };
    }
    throw new Error(
      `ask timeout after ${String(opts.timeout ?? 300)}s with no --default (qid=${questionId})`,
    );
  } finally {
    await client.close();
  }
}

async function firstReplyOrTimeout(
  sub: {
    readonly [Symbol.asyncIterator]: () => AsyncIterator<{ readonly data: Uint8Array }>;
    unsubscribe(): void;
  },
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

function parseOptions(raw: string | undefined): readonly string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function extractMsg(data: Uint8Array): string {
  const env = parseEnvelope(data);
  if (env === null) return '';
  const m = env['msg'];
  return typeof m === 'string' ? m : '';
}

function defaultRandomUUID(): string {
  return globalThis.crypto.randomUUID();
}
