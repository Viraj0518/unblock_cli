/**
 * `unblock chat` — interactive REPL.
 *
 * Tails the firehose AND the persona's DM inbox in parallel; accepts:
 *
 *   <text>                broadcast to firehose
 *   @<recipient> <text>   DM specific persona
 *   /a <qid> <text>       answer question by id
 *   /quit                 exit
 *
 * Tested via dependency injection — the REPL is driven by an async
 * line-iterator (`linesIn`) and an output writer, so we can drive it from
 * a vitest fixture without a real TTY.
 */

import type { CommsClient, CommsFactory } from '../sdk/types.js';
import {
  buildEnvelope,
  chatDmSubject,
  chatFirehoseSubject,
  chatReplySubject,
  parseEnvelope,
} from '../comms/wire.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';
import { formatChatEvent } from '../output/format.js';

export interface ChatReplDeps {
  readonly commsFactory: CommsFactory;
  /** Async iterator of input lines (REPL prompts). Stops on completion. */
  readonly linesIn: AsyncIterable<string>;
  /** Sink for rendered events + prompts. */
  readonly out: (line: string) => void;
  readonly now?: () => number;
}

export async function runChatRepl(
  deps: ChatReplDeps,
  opts: ConfigOverrides = {},
): Promise<void> {
  const cfg = await resolveConfig(opts);
  if (cfg.chatName === undefined) {
    throw new Error(
      'No chat name configured. Run `unblock login <invite-code>` or pass --name <handle>.',
    );
  }
  const name = cfg.chatName;
  const firehoseSubject = chatFirehoseSubject(cfg.workspaceId);
  const inboxSubject = chatDmSubject(cfg.workspaceId, name);

  const client: CommsClient = await deps.commsFactory.connect({
    url: cfg.natsUrl,
    ...(cfg.credsPath !== undefined ? { credsPath: cfg.credsPath } : {}),
    name: `unblock-chat-${name}`,
  });

  const firehoseSub = client.subscribe(firehoseSubject);
  const inboxSub = client.subscribe(inboxSubject);

  // Background tasks: print firehose + inbox events. They run until the
  // REPL exits (close → both subs end).
  const firehoseTask = pumpSubscription(firehoseSub, deps.out, name);
  const inboxTask = pumpSubscription(inboxSub, deps.out, name);

  deps.out(`connected to ${cfg.natsUrl} as ${name} (ws=${cfg.workspaceId})`);
  deps.out('type <msg> to broadcast · @<who> <msg> to DM · /a <qid> <msg> to reply · /quit to exit');

  try {
    for await (const rawLine of deps.linesIn) {
      const line = rawLine.trim();
      if (line === '') continue;
      if (line === '/quit' || line === '/exit') break;

      if (line.startsWith('@')) {
        const space = line.indexOf(' ');
        if (space < 1) {
          deps.out('usage: @<recipient> <message>');
          continue;
        }
        const to = line.slice(1, space).trim();
        const msg = line.slice(space + 1).trim();
        if (to === '' || msg === '') {
          deps.out('usage: @<recipient> <message>');
          continue;
        }
        const env = buildEnvelope('dm', name, { to, msg }, deps.now);
        client.publish(chatDmSubject(cfg.workspaceId, to), env);
        client.publish(firehoseSubject, env);
        continue;
      }

      if (line.startsWith('/a ')) {
        const rest = line.slice(3).trim();
        const space = rest.indexOf(' ');
        if (space < 1) {
          deps.out('usage: /a <question_id> <message>');
          continue;
        }
        const qid = rest.slice(0, space).trim();
        const msg = rest.slice(space + 1).trim();
        if (qid === '' || msg === '') {
          deps.out('usage: /a <question_id> <message>');
          continue;
        }
        const env = buildEnvelope('reply', name, { question_id: qid, msg }, deps.now);
        client.publish(chatReplySubject(cfg.workspaceId, qid), env);
        client.publish(firehoseSubject, env);
        continue;
      }

      // Default: broadcast.
      const env = buildEnvelope('say', name, { msg: line }, deps.now);
      client.publish(firehoseSubject, env);
    }
    await client.flush();
  } finally {
    firehoseSub.unsubscribe();
    inboxSub.unsubscribe();
    await client.close();
    // Drain background tasks (they exit when subs end).
    await Promise.allSettled([firehoseTask, inboxTask]);
  }
}

async function pumpSubscription(
  sub: {
    readonly [Symbol.asyncIterator]: () => AsyncIterator<{
      readonly subject: string;
      readonly data: Uint8Array;
    }>;
  },
  out: (line: string) => void,
  self: string,
): Promise<void> {
  try {
    for await (const msg of sub) {
      const env = parseEnvelope(msg.data);
      if (env === null) continue;
      // Don't echo our own broadcasts back to ourselves in the REPL.
      if (env.source === self && env.kind !== 'reply' && env.kind !== 'ask') continue;
      out(formatChatEvent(env));
    }
  } catch {
    /* swallow — subscription closed during shutdown */
  }
}
