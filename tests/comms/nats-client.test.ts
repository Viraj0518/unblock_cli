import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertSecureBrokerUrl,
  BrokerUnreachableError,
  createNatsJetStreamForTest,
  parseBrokerServers,
  safeStop,
} from '../../src/comms/nats-client.js';
import type { JetStream, JetStreamConsumeOptions } from '../../src/sdk/types.js';

const ENV_KEY = 'UNBLOCK_ALLOW_LOCAL_BROKER';
let prev: string | undefined;

beforeEach(() => {
  prev = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

type ConsumeOptionsWithReset = JetStreamConsumeOptions & {
  readonly resetDurable?: boolean;
};

interface FakeConsumerState {
  readonly configsByName: Map<string, Record<string, unknown>>;
  readonly addCalls: Array<{ readonly stream: string; readonly cfg: Record<string, unknown> }>;
  readonly infoCalls: Array<{ readonly stream: string; readonly name: string }>;
  readonly deleteCalls: Array<{ readonly stream: string; readonly name: string }>;
  readonly getCalls: Array<{ readonly stream: string; readonly name: string }>;
}

function makeFakeNatsJetStream(): {
  readonly js: JetStream;
  readonly state: FakeConsumerState;
} {
  const state: FakeConsumerState = {
    configsByName: new Map(),
    addCalls: [],
    infoCalls: [],
    deleteCalls: [],
    getCalls: [],
  };

  const notFound = (): Error => Object.assign(new Error('consumer not found'), { status: 404 });

  const conn = {
    publish: () => undefined,
    subscribe: () => ({
      unsubscribe: () => undefined,
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ value: undefined, done: true } as const),
      }),
    }),
    flush: async () => undefined,
    close: async () => undefined,
    drain: async () => undefined,
    jetstreamManager: async () => ({
      consumers: {
        add: async (stream: string, cfg: Record<string, unknown>) => {
          state.addCalls.push({ stream, cfg });
          const name = typeof cfg['name'] === 'string' ? cfg['name'] : '';
          state.configsByName.set(name, cfg);
        },
        info: async (stream: string, name: string) => {
          state.infoCalls.push({ stream, name });
          const cfg = state.configsByName.get(name);
          if (cfg === undefined) throw notFound();
          return { config: cfg };
        },
        delete: async (stream: string, name: string) => {
          state.deleteCalls.push({ stream, name });
          if (!state.configsByName.delete(name)) throw notFound();
        },
      },
    }),
    jetstream: () => ({
      consumers: {
        get: async (stream: string, name: string) => {
          state.getCalls.push({ stream, name });
          return {
            consume: async () => ({
              stop: async () => undefined,
              [Symbol.asyncIterator]: () => ({
                next: async () => ({ value: undefined, done: true } as const),
              }),
            }),
          };
        },
      },
    }),
  };

  return { js: createNatsJetStreamForTest(conn), state };
}

async function runOneConsume(
  js: JetStream,
  opts: ConsumeOptionsWithReset,
): Promise<void> {
  const iter = js.consume(opts)[Symbol.asyncIterator]();
  await iter.next();
}

describe('NATS JetStream durable consumer setup', () => {
  const baseOpts = {
    stream: 'UNBLOCK_CHAT',
    filterSubject: 'unblock.chat.ws.ws-default.to.viraj-alpha',
    deliverPolicy: { kind: 'all' },
    durableName: 'cursor-1',
  } as const satisfies ConsumeOptionsWithReset;

  it('reuses an existing durable with the same subject filter and deliver policy', async () => {
    const { js, state } = makeFakeNatsJetStream();

    await runOneConsume(js, baseOpts);
    await runOneConsume(js, baseOpts);

    expect(state.infoCalls.length).toBe(2);
    expect(state.addCalls.length).toBe(1);
    expect(state.getCalls.length).toBe(2);
    expect(state.getCalls[1]).toEqual({
      stream: 'UNBLOCK_CHAT',
      name: 'cursor-1',
    });
  });

  it('reuses a by_start_time durable even when the requested start time moves', async () => {
    const { js, state } = makeFakeNatsJetStream();

    await runOneConsume(js, {
      ...baseOpts,
      deliverPolicy: { kind: 'by_start_time', startTime: '2026-05-28T04:00:00.000Z' },
    });
    await runOneConsume(js, {
      ...baseOpts,
      deliverPolicy: { kind: 'by_start_time', startTime: '2026-05-28T04:05:00.000Z' },
    });

    expect(state.addCalls.length).toBe(1);
    expect(state.getCalls.length).toBe(2);
  });

  it('hard-errors when an existing durable has different config and mentions --reset-durable', async () => {
    const { js, state } = makeFakeNatsJetStream();

    await runOneConsume(js, baseOpts);

    await expect(
      runOneConsume(js, {
        ...baseOpts,
        filterSubject: 'unblock.channel.ops.>',
      }),
    ).rejects.toThrow(/--reset-durable/);

    expect(state.addCalls.length).toBe(1);
    expect(state.getCalls.length).toBe(1);
  });

  it('--reset-durable deletes an existing consumer and recreates it cleanly', async () => {
    const { js, state } = makeFakeNatsJetStream();

    await runOneConsume(js, baseOpts);
    await runOneConsume(js, {
      ...baseOpts,
      filterSubject: 'unblock.channel.ops.>',
      resetDurable: true,
    });

    expect(state.deleteCalls).toEqual([{ stream: 'UNBLOCK_CHAT', name: 'cursor-1' }]);
    expect(state.addCalls.length).toBe(2);
    expect(state.addCalls[1]!.cfg['filter_subject']).toBe('unblock.channel.ops.>');
    expect(state.getCalls.length).toBe(2);
  });

  it('--reset-durable with no existing consumer still creates cleanly', async () => {
    const { js, state } = makeFakeNatsJetStream();

    await runOneConsume(js, {
      ...baseOpts,
      resetDurable: true,
    });

    expect(state.deleteCalls).toEqual([{ stream: 'UNBLOCK_CHAT', name: 'cursor-1' }]);
    expect(state.addCalls.length).toBe(1);
    expect(state.getCalls.length).toBe(1);
  });
});
afterEach(() => {
  if (prev === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = prev;
});

describe('assertSecureBrokerUrl', () => {
  it('throws on default localhost broker', () => {
    expect(() => assertSecureBrokerUrl('nats://127.0.0.1:4222')).toThrow(/local broker/);
    expect(() => assertSecureBrokerUrl('nats://localhost:4222')).toThrow(/local broker/);
  });

  it('allows localhost when UNBLOCK_ALLOW_LOCAL_BROKER=1', () => {
    process.env[ENV_KEY] = '1';
    expect(() => assertSecureBrokerUrl('nats://127.0.0.1:4222')).not.toThrow();
  });

  it('passes for TLS URLs', () => {
    expect(() => assertSecureBrokerUrl('tls://nats.kaeva.app:39899')).not.toThrow();
  });

  it('honors explicit override option over env', () => {
    expect(() =>
      assertSecureBrokerUrl('nats://127.0.0.1:4222', { allowLocalhost: true }),
    ).not.toThrow();
  });
});

// ─── Multi-endpoint resilience (W1 cloud-readiness) ──────────────────────────
//
// The connect path accepts a comma-separated fallback list so a shipped
// binary can ride out a single broker port/host move without a re-release.
// Every candidate must be validated through assertSecureBrokerUrl (a
// localhost fallback in the middle of the list must NOT sneak past the
// secure-URL guard), and total connect failure must surface one clean
// operator line, not a raw NATS stack.
describe('parseBrokerServers', () => {
  it('returns a single-element list for one URL', () => {
    expect(parseBrokerServers('tls://nats.kaeva.app:51937')).toEqual([
      'tls://nats.kaeva.app:51937',
    ]);
  });

  it('splits a comma-separated fallback list and preserves order', () => {
    expect(
      parseBrokerServers('tls://a.kaeva.app:51937, tls://b.kaeva.app:51937'),
    ).toEqual(['tls://a.kaeva.app:51937', 'tls://b.kaeva.app:51937']);
  });

  it('drops empty segments from a trailing/double comma', () => {
    expect(parseBrokerServers('tls://a:51937,,')).toEqual(['tls://a:51937']);
  });

  it('throws on an all-empty spec rather than returning []', () => {
    expect(() => parseBrokerServers('  , ,')).toThrow(/broker URL is empty/);
  });

  it('every parsed server can be re-validated — a localhost fallback is caught', () => {
    const servers = parseBrokerServers('tls://a.kaeva.app:51937,nats://127.0.0.1:4222');
    const offenders = servers.filter((s) => {
      try {
        assertSecureBrokerUrl(s);
        return false;
      } catch {
        return true;
      }
    });
    expect(offenders).toEqual(['nats://127.0.0.1:4222']);
  });
});

describe('BrokerUnreachableError', () => {
  it('renders one operator-facing line pointing at the health verb', () => {
    const err = new BrokerUnreachableError(
      ['tls://a:51937', 'tls://b:51937'],
      'getaddrinfo ENOTFOUND',
    );
    expect(err.message).toBe(
      'broker unreachable at tls://a:51937, tls://b:51937 — run unblock health --component broker',
    );
    expect(err.name).toBe('BrokerUnreachableError');
    expect(err.detail).toBe('getaddrinfo ENOTFOUND');
    expect(err.servers).toEqual(['tls://a:51937', 'tls://b:51937']);
    // Must not leak a raw stack onto the operator-facing message line.
    expect(err.message).not.toContain('\n');
  });
});

// ─── Bug 1 (P1, 2026-05-28): JetStream abort handler must not crash ──────────
//
// Live repro: `unblock listen --since 30m --timeout 15` crashed on timeout
// cleanup with:
//   TypeError: Cannot read properties of undefined (reading 'catch')
//     at AbortSignal.abort (dist/comms/nats-client.js:126:45)
//
// Root cause: `messages?.stop().catch(...)`. The optional-chain short-
// circuits `stop()` when `messages` is undefined (setup-race during JS
// bring-up) → returns `undefined` → `.catch(...)` throws. Even when
// `messages` IS set, some `@nats-io/jetstream` paths return void from
// stop() instead of a Promise, hitting the same TypeError.
//
// The fix is `safeStop()`, which:
//   1. tolerates undefined messages (returns resolved promise immediately)
//   2. tolerates void return from stop() (resolved promise)
//   3. swallows rejected promises from stop() (broker disconnect mid-teardown)
describe('safeStop — JetStream abort guard', () => {
  it('returns resolved promise when messages is undefined (setup-race repro)', async () => {
    await expect(safeStop(undefined)).resolves.toBeUndefined();
  });

  it('returns resolved promise when stop() returns void (sync stop() shape)', async () => {
    const fake = {
      stop: (): void => undefined,
    };
    // Must not throw and must resolve to undefined.
    await expect(safeStop(fake)).resolves.toBeUndefined();
  });

  it('swallows rejected promises from stop() (broker disconnect)', async () => {
    const fake = {
      stop: (): Promise<void> => Promise.reject(new Error('broker disconnected')),
    };
    await expect(safeStop(fake)).resolves.toBeUndefined();
  });

  it('swallows synchronous throws from stop() (defensive)', async () => {
    const fake = {
      stop: (): never => {
        throw new Error('broken stop()');
      },
    };
    await expect(safeStop(fake)).resolves.toBeUndefined();
  });

  it('awaits resolved promise from stop() (normal happy path)', async () => {
    let ran = false;
    const fake = {
      stop: async (): Promise<void> => {
        await new Promise((r) => setTimeout(r, 5));
        ran = true;
      },
    };
    await safeStop(fake);
    expect(ran).toBe(true);
  });

  it('returns resolved promise when stop() returns null (defensive)', async () => {
    const fake = {
      stop: (): unknown => null,
    };
    await expect(safeStop(fake)).resolves.toBeUndefined();
  });
});
