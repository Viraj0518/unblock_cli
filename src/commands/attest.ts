/**
 * `unblock attest <block-id> --score <0-1> [--text "..."] [--signature <sig>]`
 *
 * Substrate verb #7. Attaches a quality attestation to a block.
 * Returns the attestation_id; exit 0 on success.
 */

import type { AttestInput, AttestResult, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface AttestDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface AttestOptions extends ConfigOverrides {
  readonly blockId: string;
  readonly score: number;
  readonly attestationText?: string;
  readonly signature?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export async function runAttest(
  deps: AttestDeps,
  opts: AttestOptions,
): Promise<AttestResult> {
  const cfg = await resolveConfig(opts);
  const apiKey = cfg.apiKey;
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    substrateUrl: cfg.substrateUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
    ...(apiKey !== undefined ? { apiKey: async () => apiKey } : {}),
  });
  const input: AttestInput = {
    blockId: opts.blockId,
    score: opts.score,
    ...(opts.attestationText !== undefined ? { attestationText: opts.attestationText } : {}),
    ...(opts.signature !== undefined ? { signature: opts.signature } : {}),
    ...(opts.metadata !== undefined ? { metadata: opts.metadata } : {}),
  };
  return client.attest(input);
}
