/**
 * `unblock update <block-id> <content> [--revision-reason "..."] [--tag a,b] [--client-msg-id <id>]`
 *
 * Substrate verb #9. Creates a new version of an existing block.
 * Returns block_id + content_hash; exit 0 on success.
 */

import type { UpdateInput, UpdateResult, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface UpdateDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface UpdateOptions extends ConfigOverrides {
  readonly blockId: string;
  readonly content: unknown;
  readonly rejectedAlternatives?: readonly string[];
  readonly revisionReason?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly clientMsgId?: string;
}

export async function runUpdate(
  deps: UpdateDeps,
  opts: UpdateOptions,
): Promise<UpdateResult> {
  const cfg = await resolveConfig(opts);
  const apiKey = cfg.apiKey;
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    substrateUrl: cfg.substrateUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
    ...(apiKey !== undefined ? { apiKey: async () => apiKey } : {}),
  });
  const input: UpdateInput = {
    blockId: opts.blockId,
    content: opts.content,
    ...(opts.rejectedAlternatives !== undefined ? { rejectedAlternatives: opts.rejectedAlternatives } : {}),
    ...(opts.revisionReason !== undefined ? { revisionReason: opts.revisionReason } : {}),
    ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
    ...(opts.clientMsgId !== undefined ? { clientMsgId: opts.clientMsgId } : {}),
  };
  return client.update(input);
}
