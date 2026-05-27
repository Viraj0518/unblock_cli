/**
 * `unblock verify --block-id <id> | --content-hash <hash> [--signature <sig>]`
 *
 * Substrate verb #6. Verifies a block's signature and retrieves its attestations.
 * Returns signature_valid + attestation list; exit 0 on success.
 */

import type { VerifyInput, VerifyResult, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface VerifyDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface VerifyOptions extends ConfigOverrides {
  readonly blockId?: string | null;
  readonly contentHash?: string | null;
  readonly signature?: string | null;
}

export async function runVerify(
  deps: VerifyDeps,
  opts: VerifyOptions,
): Promise<VerifyResult> {
  const cfg = await resolveConfig(opts);
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
  });
  const input: VerifyInput = {
    ...(opts.blockId !== undefined ? { blockId: opts.blockId } : {}),
    ...(opts.contentHash !== undefined ? { contentHash: opts.contentHash } : {}),
    ...(opts.signature !== undefined ? { signature: opts.signature } : {}),
  };
  return client.verify(input);
}
