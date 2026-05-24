/**
 * NATS comms factory — wraps the `nats` package behind our CommsClient
 * interface. Production code constructs this via `createNatsFactory()`;
 * tests inject a fake CommsFactory directly.
 *
 * The `nats` package is imported dynamically so that:
 *   - tests can run without the dep installed (the fake never reaches here);
 *   - the package can be made optional in package.json (consumers who only
 *     use `unblock remember` / `query` won't pull NATS).
 *
 * Refuses to connect to localhost without `UNBLOCK_ALLOW_LOCAL_BROKER=1`
 * (per parent feedback_crash_early_on_default_broker_url.md — 3F-1 family
 * bug recurred 4× in 2026-05).
 */

import { readFile } from 'node:fs/promises';
import type { CommsClient, CommsFactory, Subscription } from '../sdk/types.js';

export interface AssertSecureOptions {
  /** Override env-driven check (test injection). */
  readonly allowLocalhost?: boolean;
}

/**
 * Crash early on default/localhost broker URLs unless explicitly allowed.
 * Exported so callers (login, chat, say, etc.) can validate URLs before
 * attempting a connection.
 */
export function assertSecureBrokerUrl(url: string, opts: AssertSecureOptions = {}): void {
  const isLocalhost = /^nats:\/\/(127\.0\.0\.1|localhost)(:|\/|$)/i.test(url);
  if (!isLocalhost) return;
  const allow =
    opts.allowLocalhost ?? process.env['UNBLOCK_ALLOW_LOCAL_BROKER'] === '1';
  if (!allow) {
    throw new Error(
      'Refusing to connect to local broker. Did you forget `unblock login <invite>`? ' +
        'Set UNBLOCK_ALLOW_LOCAL_BROKER=1 to override.',
    );
  }
}

/**
 * Construct a NATS-backed CommsFactory. Imports `nats` lazily so the
 * dependency is only required when this factory is actually instantiated.
 */
export function createNatsFactory(): CommsFactory {
  return {
    async connect(options): Promise<CommsClient> {
      assertSecureBrokerUrl(options.url);
      // Dynamic import keeps `nats` out of the eager require graph (tests
      // never reach here, and the package becomes installation-optional).
      // We validate the exported shape at runtime rather than casting blindly
      // (per AGENTS.md rule 4 and feedback_honest_typescript_fixes).
      const nats = await loadNatsModule();

      const connectOpts: Record<string, unknown> = {
        servers: options.url,
        timeout: 5000,
        name: options.name ?? `unblock-cli-${process.pid}`,
      };

      if (options.credsPath !== undefined) {
        const buf = await readFile(options.credsPath);
        const credsBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        connectOpts['authenticator'] = nats.credsAuthenticator(credsBytes);
      }

      const conn = await nats.connect(connectOpts);
      return wrapConnection(conn);
    },
  };
}

// ─── internal: dynamic-import loader with runtime shape check ────────────────

interface NatsModule {
  connect: (opts: Record<string, unknown>) => Promise<NatsConnection>;
  credsAuthenticator: (creds: Uint8Array) => unknown;
}

async function loadNatsModule(): Promise<NatsModule> {
  const mod: unknown = await import('nats');
  if (
    typeof mod === 'object' &&
    mod !== null &&
    typeof (mod as { connect?: unknown }).connect === 'function' &&
    typeof (mod as { credsAuthenticator?: unknown }).credsAuthenticator === 'function'
  ) {
    return mod as NatsModule;
  }
  throw new Error('nats package present but missing connect / credsAuthenticator exports');
}

// ─── internal: adapt the `nats` package to our CommsClient interface ─────────

interface NatsConnection {
  publish(subject: string, payload: Uint8Array): void;
  subscribe(subject: string): NatsSubscription;
  flush(): Promise<void>;
  close(): Promise<void>;
  drain(): Promise<void>;
}

interface NatsSubscription {
  unsubscribe(): void;
  [Symbol.asyncIterator](): AsyncIterator<{ subject: string; data: Uint8Array }>;
}

function wrapConnection(conn: NatsConnection): CommsClient {
  return {
    publish(subject, payload) {
      conn.publish(subject, payload);
    },
    subscribe(subject): Subscription {
      const inner = conn.subscribe(subject);
      return {
        [Symbol.asyncIterator]: () => inner[Symbol.asyncIterator](),
        unsubscribe: () => {
          inner.unsubscribe();
        },
      };
    },
    flush: () => conn.flush(),
    close: async () => {
      try {
        await conn.drain();
      } catch {
        await conn.close();
      }
    },
  };
}
