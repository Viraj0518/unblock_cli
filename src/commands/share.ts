/**
 * `unblock share <block-id> <recipient> [--permission read,write] [--expires-at <epoch-sec>]`
 *
 * Substrate verb #3. Grants a recipient access to a block.
 * Returns the share_id; exit 0 on success.
 */

import type { ShareInput, ShareResult, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface ShareDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface ShareOptions extends ConfigOverrides {
  readonly blockId: string;
  readonly recipient: string;
  readonly permissions?: readonly string[];
  readonly expiresAt?: number;
}

export async function runShare(
  deps: ShareDeps,
  opts: ShareOptions,
): Promise<ShareResult> {
  const cfg = await resolveConfig(opts);
  const apiKey = cfg.apiKey;
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    substrateUrl: cfg.substrateUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
    ...(apiKey !== undefined ? { apiKey: async () => apiKey } : {}),
  });
  const input: ShareInput = {
    blockId: opts.blockId,
    recipient: opts.recipient,
    ...(opts.permissions !== undefined ? { permissions: opts.permissions } : {}),
    ...(opts.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  };
  return client.share(input);
}
