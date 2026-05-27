/**
 * `unblock subscribe --url <https://...> --events block.created,... --secret <s>`
 *
 * Substrate verb #8. Registers a webhook that fires on substrate events.
 * Returns the subscription_id; exit 0 on success.
 *
 * For real-time NATS delivery use `unblock chat` — this command is for
 * webhook (HTTP push) subscriptions.
 */

import type { SubscribeInput, SubscribeResult, SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface SubscribeDeps {
  readonly substrateFactory: SubstrateFactory;
  readonly token?: () => Promise<string>;
}

export interface SubscribeOptions extends ConfigOverrides {
  readonly url: string;
  readonly events: readonly string[];
  readonly secret: string;
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly active?: boolean;
}

export async function runSubscribe(
  deps: SubscribeDeps,
  opts: SubscribeOptions,
): Promise<SubscribeResult> {
  const cfg = await resolveConfig(opts);
  const client = deps.substrateFactory.create({
    authUrl: cfg.authUrl,
    ...(deps.token !== undefined ? { token: deps.token } : {}),
  });
  const input: SubscribeInput = {
    url: opts.url,
    events: opts.events,
    secret: opts.secret,
    ...(opts.filter !== undefined ? { filter: opts.filter } : {}),
    ...(opts.active !== undefined ? { active: opts.active } : {}),
  };
  return client.subscribe(input);
}
