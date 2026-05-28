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
import type {
  CommsClient,
  CommsFactory,
  JetStream,
  JetStreamConsumeOptions,
  JetStreamFrame,
  Subscription,
} from '../sdk/types.js';

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
  jetstreamManager(): Promise<NatsJsm>;
  jetstream(): NatsJsClient;
}

interface NatsSubscription {
  unsubscribe(): void;
  [Symbol.asyncIterator](): AsyncIterator<{ subject: string; data: Uint8Array; reply?: string }>;
}

interface NatsJsMsg {
  readonly subject: string;
  readonly data: Uint8Array;
  ack(): void;
}
interface NatsConsumerMessages extends AsyncIterable<NatsJsMsg> {
  stop(): Promise<void>;
}
interface NatsConsumer {
  consume(): Promise<NatsConsumerMessages>;
}
interface NatsConsumerApi {
  add(stream: string, cfg: Record<string, unknown>): Promise<unknown>;
}
interface NatsJsm {
  readonly consumers: NatsConsumerApi;
}
interface NatsConsumersFacade {
  get(stream: string, name: string): Promise<NatsConsumer>;
}
interface NatsJsClient {
  readonly consumers: NatsConsumersFacade;
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
    jetstream: wrapJetStream(conn),
  };
}

function wrapJetStream(conn: NatsConnection): JetStream {
  return {
    consume(opts: JetStreamConsumeOptions): AsyncIterable<JetStreamFrame> {
      return jsConsumeIterable(conn, opts);
    },
  };
}

function jsConsumeIterable(
  conn: NatsConnection,
  opts: JetStreamConsumeOptions,
): AsyncIterable<JetStreamFrame> {
  return {
    [Symbol.asyncIterator]: (): AsyncIterator<JetStreamFrame> => {
      let inner: AsyncIterator<NatsJsMsg> | undefined;
      let messages: NatsConsumerMessages | undefined;
      let setupErr: Error | undefined;
      let setupOnce: Promise<void> | undefined;
      const setup = async (): Promise<void> => {
        try {
          const cfg = buildConsumerConfig(opts);
          const jsm = await conn.jetstreamManager();
          const isEphemeral = opts.durableName === undefined;
          const consumerName: string =
            opts.durableName ?? `unblock-listen-${randomToken()}`;
          await jsm.consumers.add(opts.stream, {
            ...cfg,
            name: consumerName,
            ...(isEphemeral ? {} : { durable_name: consumerName }),
            ...(isEphemeral ? { inactive_threshold: 60_000_000_000 } : {}),
          });
          const consumer = await conn.jetstream().consumers.get(opts.stream, consumerName);
          messages = await consumer.consume();
          inner = messages[Symbol.asyncIterator]();
          if (opts.signal !== undefined) {
            const abort = (): void => {
              // `messages` may be undefined if the abort fires before setup()
              // ran far enough to assign it (race during JetStream consume
              // bring-up). Even when set, some `@nats-io/jetstream` paths
              // return void from `stop()` instead of a Promise. Both cases
              // must be tolerated — `?.` alone is not enough because
              // `undefined.catch(...)` (the optional-chain short-circuit
              // result) is a TypeError. See live repro 2026-05-28 02:50 UTC.
              safeStop(messages);
            };
            if (opts.signal.aborted) abort();
            else opts.signal.addEventListener('abort', abort, { once: true });
          }
        } catch (err) {
          setupErr = err instanceof Error ? err : new Error(String(err));
        }
      };
      return {
        next: async (): Promise<IteratorResult<JetStreamFrame>> => {
          if (setupOnce === undefined) setupOnce = setup();
          await setupOnce;
          if (setupErr !== undefined) throw setupErr;
          if (inner === undefined) return { value: undefined, done: true };
          const r = await inner.next();
          if (r.done === true) return { value: undefined, done: true };
          const m = r.value;
          return {
            value: {
              subject: m.subject,
              data: m.data,
              ack: () => {
                m.ack();
              },
            },
            done: false,
          };
        },
        return: async (): Promise<IteratorResult<JetStreamFrame>> => {
          // Same guard as the abort path above — `stop()` may return void
          // or `messages` may be undefined if iterator.return() is called
          // before setup completed.
          await safeStop(messages);
          return { value: undefined, done: true };
        },
      };
    },
  };
}

function buildConsumerConfig(opts: JetStreamConsumeOptions): Record<string, unknown> {
  const base: Record<string, unknown> = {
    filter_subject: opts.filterSubject,
    ack_policy: 'explicit',
  };
  switch (opts.deliverPolicy.kind) {
    case 'all':
      base['deliver_policy'] = 'all';
      break;
    case 'new':
      base['deliver_policy'] = 'new';
      break;
    case 'by_start_time':
      base['deliver_policy'] = 'by_start_time';
      base['opt_start_time'] = opts.deliverPolicy.startTime;
      break;
  }
  return base;
}

function randomToken(): string {
  return Math.random().toString(36).slice(2, 10);
}

/**
 * Best-effort stop for a JetStream `ConsumerMessages` handle.
 *
 * Three failure modes we MUST tolerate without throwing:
 *   1. `messages` is undefined — setup() races vs the abort signal; the
 *      iterator promise may not have resolved before the operator's
 *      `--timeout` fires (live repro 2026-05-28 02:50 UTC).
 *   2. `stop()` returns void — some `@nats-io/jetstream` code paths in
 *      v3+ are synchronous; `.catch(...)` on void throws TypeError.
 *   3. `stop()` returns a rejected promise — broker disconnected mid-
 *      teardown; we don't care, the abort path is already terminal.
 *
 * Returns a Promise so callers can `await` it from `iterator.return()`,
 * but a fire-and-forget call (e.g. inside an `abort` listener) is fine
 * because all three error modes are swallowed internally.
 *
 * Exported for unit testing — production callers stay inside this module.
 * Typed loosely (`unknown`) so tests can pass synthetic stop()-shaped
 * objects without importing internal NATS types.
 */
export function safeStop(messages: { stop: () => unknown } | undefined): Promise<void> {
  if (messages === undefined) return Promise.resolve();
  let result: unknown;
  try {
    result = messages.stop();
  } catch {
    return Promise.resolve();
  }
  if (
    result !== undefined &&
    result !== null &&
    typeof (result as { then?: unknown }).then === 'function'
  ) {
    return (result as Promise<unknown>).then(
      () => undefined,
      () => undefined,
    );
  }
  return Promise.resolve();
}
