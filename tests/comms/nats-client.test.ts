import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertSecureBrokerUrl } from '../../src/comms/nats-client.js';

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
    expect(() => assertSecureBrokerUrl('tls://nats.kaeva.app:30640')).not.toThrow();
  });

  it('honors explicit override option over env', () => {
    expect(() =>
      assertSecureBrokerUrl('nats://127.0.0.1:4222', { allowLocalhost: true }),
    ).not.toThrow();
  });
});
