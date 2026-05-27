/**
 * `unblock list <block-id> --price <n> [--tier 1-5] [--summary "..."] [--delist-existing]`
 *
 * Substrate verb #4. Lists a block on the marketplace.
 * Returns the listing_id; exit 0 on success.
 *
 * Named `list-marketplace` internally (file) to avoid clashing with future
 * `list` (enumerate) semantics. The CLI command is `unblock list`.
 */

import type { ListInput, ListResult, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface ListMarketplaceDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface ListMarketplaceOptions extends ConfigOverrides {
  readonly blockId: string;
  readonly priceUnblock: number;
  readonly tier?: number;
  readonly royaltyShareWith?: ReadonlyArray<readonly [string, number]>;
  readonly delistExisting?: boolean;
  readonly summary?: string;
}

export async function runListMarketplace(
  deps: ListMarketplaceDeps,
  opts: ListMarketplaceOptions,
): Promise<ListResult> {
  const cfg = await resolveConfig(opts);
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
  });
  const input: ListInput = {
    blockId: opts.blockId,
    priceUnblock: opts.priceUnblock,
    ...(opts.tier !== undefined ? { tier: opts.tier } : {}),
    ...(opts.royaltyShareWith !== undefined ? { royaltyShareWith: opts.royaltyShareWith } : {}),
    ...(opts.delistExisting !== undefined ? { delistExisting: opts.delistExisting } : {}),
    ...(opts.summary !== undefined ? { summary: opts.summary } : {}),
  };
  return client.listMarketplace(input);
}
