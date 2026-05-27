/**
 * `unblock forget <block-id> [--mode soft|hard] [--reason "..."] [--gdpr]`
 *
 * Substrate verb #11. Tombstones (soft) or permanently deletes (hard) a block.
 * Returns deletion metadata; exit 0 on success.
 *
 * Retention control: soft = tombstone (recoverable within retention window);
 * hard = GDPR-compliant purge. Default is soft.
 */

import type { ForgetInput, ForgetResult, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface ForgetDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface ForgetOptions extends ConfigOverrides {
  readonly blockId: string;
  readonly mode?: 'soft' | 'hard';
  readonly reason?: string;
  readonly gdprRequest?: boolean;
}

export async function runForget(
  deps: ForgetDeps,
  opts: ForgetOptions,
): Promise<ForgetResult> {
  const cfg = await resolveConfig(opts);
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
  });
  const input: ForgetInput = {
    blockId: opts.blockId,
    ...(opts.mode !== undefined ? { mode: opts.mode } : {}),
    ...(opts.reason !== undefined ? { reason: opts.reason } : {}),
    ...(opts.gdprRequest !== undefined ? { gdprRequest: opts.gdprRequest } : {}),
  };
  return client.forget(input);
}
