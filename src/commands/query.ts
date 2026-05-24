/**
 * `unblock query "<text>" [--top-k 10]`
 *
 * Substrate verb #2. GETs from catalog-api via the SubstrateClient.
 * Returns hits; printing/formatting is the caller's job.
 */

import type { QueryHit, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface QueryDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface QueryOptions extends ConfigOverrides {
  readonly query: string;
  readonly topK?: number;
}

export async function runQuery(
  deps: QueryDeps,
  opts: QueryOptions,
): Promise<readonly QueryHit[]> {
  const cfg = await resolveConfig(opts);
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
  });
  return client.query(opts.query, opts.topK !== undefined ? { topK: opts.topK } : undefined);
}
