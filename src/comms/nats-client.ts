/**
 * NATS comms factory — wraps the `nats` package behind our CommsClient
 * interface. Production code constructs this via `createNatsFactory()`;
 * tests inject a fake CommsFactory directly.
 *
 * `nats` is a STATIC top-level import (not a dynamic `import('nats')`).
 * History: every v0.1.1 release binary crashed on say/chat/dm/listen/monitor
 * with "Cannot find package 'nats'" / "A dynamic import callback was not
 * specified." @yao-pkg/pkg cannot trace a bare-specifier dynamic import into
 * the snapshot, and a `pkg.assets`/`pkg.scripts` config alone does NOT fix it
 * (verified 2026-05-29: the binary still threw "A dynamic import callback was
 * not specified."). A static import puts `nats` in the static module graph
 * that pkg DOES trace, and `nats` is now a hard `dependency` (not
 * optionalDependencies) so it is always present at build + install time.
 *
 * Tests never construct the real factory's connect() against a live broker —
 * they inject a fake CommsFactory, or exercise the JetStream adapter via
 * `createNatsJetStreamForTest` with a fake connection — so a static import of
 * an always-installed dep costs them nothing.
 *
 * Refuses to connect to localhost without `UNBLOCK_ALLOW_LOCAL_BROKER=1`
 * (per parent feedback_crash_early_on_default_broker_url.md — 3F-1 family
 * bug recurred 4× in 2026-05).
 */

import { readFile } from 'node:fs/promises';
import { connect as natsConnect, credsAuthenticator } from 'nats';
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
 * Split a broker URL spec into a server list. The CLI accepts a single URL
 * (`tls://nats.kaeva.app:51937`) or a comma-separated fallback list
 * (`tls://a:51937,tls://b:51937`) so a shipped binary can ride out a single
 * port/host change without a re-release. Order is preserved — the NATS client
 * tries them left-to-right and keeps the survivor for reconnects.
 *
 * Exported for unit testing the parse + secure-URL fan-out.
 */
export function parseBrokerServers(urlSpec: string): string[] {
  const servers = urlSpec
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (servers.length === 0) {
    throw new Error('broker URL is empty — set UNBLOCK_NATS_URL or run `unblock login`');
  }
  return servers;
}

/**
 * Reconnect backoff with jitter, in ms. Keeps a herd of reconnecting CLIs
 * from hammering the broker in lockstep after a broker bounce.
 */
function reconnectTimeWaitJitter(): number {
  const baseMs = 2000;
  const jitterMs = Math.floor(Math.random() * 1000);
  return baseMs + jitterMs;
}

/**
 * Construct a NATS-backed CommsFactory. Imports `nats` lazily so tests can
 * run without reaching this path (production binaries bundle `nats` via the
 * `pkg.assets`/`pkg.scripts` config in package.json — see PR for the
 * "Cannot find package 'nats'" release-binary fix).
 */
export function createNatsFactory(): CommsFactory {
  return {
    async connect(options): Promise<CommsClient> {
      // Accept a comma-separated fallback list. Validate EVERY candidate
      // (not just the first) so a localhost fallback can't sneak in.
      const servers = parseBrokerServers(options.url);
      for (const s of servers) assertSecureBrokerUrl(s);

      const connectOpts: Record<string, unknown> = {
        servers,
        timeout: 5000,
        name: options.name ?? `unblock-cli-${process.pid}`,
        // Multi-endpoint resilience: once connected, keep retrying forever
        // with jittered backoff so a broker bounce mid-session reconnects
        // transparently across the fallback server list.
        reconnect: true,
        maxReconnectAttempts: -1,
        reconnectTimeWait: reconnectTimeWaitJitter(),
        // Only long-lived consumers (listen/monitor/chat) block the FIRST
        // connect forever. One-shot verbs leave this false so an unreachable
        // broker rejects the initial connect → BrokerUnreachableError (one
        // clean line) instead of hanging indefinitely. Reconnect (above)
        // still applies once a first connection succeeds.
        waitOnFirstConnect: options.waitOnFirstConnect === true,
      };

      if (options.credsPath !== undefined) {
        const buf = await readFile(options.credsPath);
        const credsBytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
        connectOpts['authenticator'] = credsAuthenticator(credsBytes);
      }

      try {
        // `natsConnect` returns the `nats` package's own NatsConnection. We
        // narrow it to our minimal structural interface via a runtime shape
        // check (no blind cast — per AGENTS.md rule 4 / honest-TS tenet).
        const conn = asNatsConnection(await natsConnect(connectOpts));
        return wrapConnection(conn);
      } catch (err) {
        // One clear line instead of a raw NATS stack. Point the operator at
        // the diagnostic verb rather than dumping connect internals.
        const detail = err instanceof Error ? err.message : String(err);
        throw new BrokerUnreachableError(servers, detail);
      }
    },
  };
}

/**
 * Thrown when the NATS client cannot reach any candidate broker. Carries the
 * tried server list + the underlying cause for `--debug`, but its `message`
 * is a single operator-facing line (no stack soup at the CLI surface).
 */
export class BrokerUnreachableError extends Error {
  constructor(
    readonly servers: readonly string[],
    readonly detail: string,
  ) {
    super(
      `broker unreachable at ${servers.join(', ')} — run unblock health --component broker`,
    );
    this.name = 'BrokerUnreachableError';
  }
}

// ─── internal: runtime narrow the `nats` connection to our interface ─────────

/**
 * Narrow the `nats` package's NatsConnection (a superset with many methods we
 * don't use) to our minimal structural `NatsConnection`. We verify the exact
 * methods we call exist at runtime, then narrow — no blind `as unknown as`
 * cast (per AGENTS.md rule 4 / feedback_honest_typescript_fixes). If the
 * `nats` API ever drops one of these, this throws a clear error here instead
 * of a `TypeError: x is not a function` deep in the consume loop.
 */
function asNatsConnection(conn: unknown): NatsConnection {
  if (typeof conn !== 'object' || conn === null) {
    throw new Error(`nats.connect returned a non-object (${typeof conn})`);
  }
  const c = conn as Record<string, unknown>;
  for (const m of ['publish', 'subscribe', 'flush', 'close', 'drain', 'jetstreamManager', 'jetstream']) {
    if (typeof c[m] !== 'function') {
      throw new Error(`nats connection missing expected method "${m}"`);
    }
  }
  return conn as NatsConnection;
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
interface NatsConsumerInfo {
  readonly config?: Record<string, unknown>;
}
interface NatsConsumerApi {
  add(stream: string, cfg: Record<string, unknown>): Promise<unknown>;
  info(stream: string, name: string): Promise<NatsConsumerInfo>;
  delete(stream: string, name: string): Promise<unknown>;
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

/**
 * Test hook for the production NATS JetStream adapter. Kept out of
 * `src/index.ts`; exported only so nats-client tests can exercise the real
 * consumer setup path without importing the optional `nats` package.
 */
export function createNatsJetStreamForTest(conn: unknown): JetStream {
  return wrapJetStream(conn as NatsConnection);
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
          const consumerCfg = {
            ...cfg,
            name: consumerName,
            ...(isEphemeral ? {} : { durable_name: consumerName }),
            ...(isEphemeral ? { inactive_threshold: 60_000_000_000 } : {}),
          };
          await ensureConsumer(jsm.consumers, {
            stream: opts.stream,
            name: consumerName,
            cfg: consumerCfg,
            resetDurable: readResetDurable(opts),
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

async function ensureConsumer(
  consumers: NatsConsumerApi,
  opts: {
    readonly stream: string;
    readonly name: string;
    readonly cfg: Record<string, unknown>;
    readonly resetDurable: boolean;
  },
): Promise<void> {
  if (opts.resetDurable) {
    try {
      await consumers.delete(opts.stream, opts.name);
    } catch (err) {
      if (!isConsumerNotFoundError(err)) throw err;
    }
    await consumers.add(opts.stream, opts.cfg);
    return;
  }

  let existing: NatsConsumerInfo | undefined;
  try {
    existing = await consumers.info(opts.stream, opts.name);
  } catch (err) {
    if (!isConsumerNotFoundError(err)) throw err;
  }

  if (existing === undefined) {
    await consumers.add(opts.stream, opts.cfg);
    return;
  }

  if (!consumerConfigMatches(existing.config, opts.cfg)) {
    throw new Error(
      `JetStream durable consumer "${opts.name}" already exists on stream "${opts.stream}" ` +
        'with different config. Re-run with --reset-durable to delete and recreate it, ' +
        'or choose a different --durable name.',
    );
  }
}

function readResetDurable(opts: JetStreamConsumeOptions): boolean {
  const rec = opts as JetStreamConsumeOptions & { readonly resetDurable?: boolean };
  return rec.resetDurable === true && opts.durableName !== undefined;
}

function consumerConfigMatches(
  existing: Record<string, unknown> | undefined,
  expected: Record<string, unknown>,
): boolean {
  if (existing === undefined) return false;
  if (existing['filter_subject'] !== expected['filter_subject']) return false;
  if (existing['deliver_policy'] !== expected['deliver_policy']) return false;
  return true;
}

function isConsumerNotFoundError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const rec = err as Record<string, unknown>;
  if (rec['status'] === 404 || rec['code'] === 404 || rec['code'] === '404') return true;
  const apiError = rec['api_error'];
  if (typeof apiError === 'object' && apiError !== null) {
    const api = apiError as Record<string, unknown>;
    if (api['err_code'] === 10014 || api['code'] === 404) return true;
  }
  const msg = rec['message'];
  return typeof msg === 'string' && /\bnot found\b|consumer.*does not exist/i.test(msg);
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
