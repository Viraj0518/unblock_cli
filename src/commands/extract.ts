/**
 * `unblock extract --block-id <id> | --query "<text>" [--schema '{"key":"type"}']`
 *
 * Substrate verb #10. Extracts structured facts from a block or a semantic query.
 * Returns a facts array; exit 0 on success.
 */

import type { ExtractInput, ExtractResult, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface ExtractDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface ExtractOptions extends ConfigOverrides {
  readonly blockId?: string;
  readonly query?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
}

export async function runExtract(
  deps: ExtractDeps,
  opts: ExtractOptions,
): Promise<ExtractResult> {
  const cfg = await resolveConfig(opts);
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
  });
  const input: ExtractInput = {
    ...(opts.blockId !== undefined ? { blockId: opts.blockId } : {}),
    ...(opts.query !== undefined ? { query: opts.query } : {}),
    ...(opts.schema !== undefined ? { schema: opts.schema } : {}),
  };
  return client.extract(input);
}
