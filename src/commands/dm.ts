/**
 * `unblock dm <target> "<msg>"` — direct message a recipient.
 *
 * Wire: NATS publish on `unblock.chat.ws.<workspaceId>.to.<recipient>`
 *       AND mirrored to firehose so watching humans see DM traffic.
 *
 * The mirror-to-firehose behavior matches v02-mig's `cmdDm` — DMs are
 * observable by humans on `unblock chat` REPLs, never private.
 */

import type { CommsFactory } from '../sdk/types.js';
import { buildEnvelope, chatDmSubject, chatFirehoseSubject } from '../comms/wire.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface DmDeps {
  readonly commsFactory: CommsFactory;
  readonly now?: () => number;
}

export interface DmOptions extends ConfigOverrides {
  readonly to: string;
  readonly msg: string;
}

export async function runDm(deps: DmDeps, opts: DmOptions): Promise<void> {
  const cfg = await resolveConfig(opts);
  if (cfg.chatName === undefined) {
    throw new Error(
      'No chat name configured. Run `unblock login <invite-code>` or pass --name <handle>.',
    );
  }
  const envelope = buildEnvelope('dm', cfg.chatName, { to: opts.to, msg: opts.msg }, deps.now);
  const dmSubject = chatDmSubject(cfg.workspaceId, opts.to);
  const fhSubject = chatFirehoseSubject(cfg.workspaceId);

  const client = await deps.commsFactory.connect({
    url: cfg.natsUrl,
    ...(cfg.credsPath !== undefined ? { credsPath: cfg.credsPath } : {}),
  });
  try {
    client.publish(dmSubject, envelope);
    client.publish(fhSubject, envelope);
    await client.flush();
  } finally {
    await client.close();
  }
}
