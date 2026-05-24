/**
 * `unblock remember "<content>" [--tag a,b] [--parent <block_id>]`
 *
 * Substrate verb #1. POSTs to catalog-api via the SubstrateClient.
 * Returns the new block id; exit 0 on success.
 */

import type { SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface RememberDeps {
  readonly substrateFactory: SubstrateFactory;
  /** Caller can supply a token getter once auth-issuer JWTs are wired. */
  readonly token?: () => Promise<string>;
}

export interface RememberOptions extends ConfigOverrides {
  readonly content: string;
  readonly tags?: readonly string[];
  readonly parentBlockId?: string;
}

export interface RememberOutput {
  readonly blockId: string;
  readonly storedAt: string;
}

export async function runRemember(
  deps: RememberDeps,
  opts: RememberOptions,
): Promise<RememberOutput> {
  const cfg = await resolveConfig(opts);
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
  });
  const out = await client.remember({
    content: opts.content,
    ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
    ...(opts.parentBlockId !== undefined ? { parentBlockId: opts.parentBlockId } : {}),
  });
  return { blockId: out.blockId, storedAt: out.storedAt };
}
