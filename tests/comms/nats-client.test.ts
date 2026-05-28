import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSecureBrokerUrl, safeStop } from '../../src/comms/nats-client.js';

const ENV_KEY = 'UNBLOCK_ALLOW_LOCAL_BROKER';
let prev: string | undefined;

beforeEach(() => {
  prev = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
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
