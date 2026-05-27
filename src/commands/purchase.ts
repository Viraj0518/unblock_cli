/**
 * `unblock purchase --block-id <id> | --listing-id <id> [--max-price <n>] [--payment-method wallet|relay]`
 *
 * Substrate verb #5. Purchases a block or listing from the marketplace.
 * Returns block_id + receipt_id; exit 0 on success.
 */

import type { PurchaseInput, PurchaseResult, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface PurchaseDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface PurchaseOptions extends ConfigOverrides {
  readonly blockId?: string;
  readonly listingId?: string;
  readonly maxPrice?: number | null;
  readonly paymentMethod?: 'wallet' | 'relay';
  readonly walletName?: string;
}

export async function runPurchase(
  deps: PurchaseDeps,
  opts: PurchaseOptions,
): Promise<PurchaseResult> {
  const cfg = await resolveConfig(opts);
  const apiKey = cfg.apiKey;
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    substrateUrl: cfg.substrateUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
    ...(apiKey !== undefined ? { apiKey: async () => apiKey } : {}),
  });
  const input: PurchaseInput = {
    ...(opts.blockId !== undefined ? { blockId: opts.blockId } : {}),
    ...(opts.listingId !== undefined ? { listingId: opts.listingId } : {}),
    ...(opts.maxPrice !== undefined ? { maxPrice: opts.maxPrice } : {}),
    ...(opts.paymentMethod !== undefined ? { paymentMethod: opts.paymentMethod } : {}),
    ...(opts.walletName !== undefined ? { walletName: opts.walletName } : {}),
  };
  return client.purchase(input);
}
