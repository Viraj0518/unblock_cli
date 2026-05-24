/**
 * `unblock say "<msg>"` — fire-and-forget broadcast to the workspace firehose.
 *
 * Wire: NATS publish on `unblock.chat.ws.<workspaceId>.firehose`
 * Envelope: { kind: "say", source: <name>, ts: <ms>, msg: <text> }
 *
 * Exit codes:
 *   0   published successfully
 *   1   no persona configured / broker unreachable / publish failed
 */

import type { CommsFactory } from '../sdk/types.js';
import { buildEnvelope, chatFirehoseSubject } from '../comms/wire.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface SayDeps {
  readonly commsFactory: CommsFactory;
  readonly now?: () => number;
}

export interface SayOptions extends ConfigOverrides {
  readonly msg: string;
}

export async function runSay(deps: SayDeps, opts: SayOptions): Promise<void> {
  const cfg = await resolveConfig(opts);
  if (cfg.chatName === undefined) {
    throw new Error(
      'No chat name configured. Run `unblock login <invite-code>` or pass --name <handle>.',
    );
  }
  const subject = chatFirehoseSubject(cfg.workspaceId);
  const envelope = buildEnvelope('say', cfg.chatName, { msg: opts.msg }, deps.now);

  const client = await deps.commsFactory.connect({
    url: cfg.natsUrl,
    ...(cfg.credsPath !== undefined ? { credsPath: cfg.credsPath } : {}),
  });
  try {
    client.publish(subject, envelope);
    await client.flush();
  } finally {
    await client.close();
  }
}
