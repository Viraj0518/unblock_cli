import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';
import { decodeCreds, decodeJwtClaims, extractJwtFromCreds } from '../../src/auth/jwt.js';

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ed25519' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

describe('jwt', () => {
  it('decodes claims from a 3-part NATS-shaped JWT', () => {
    const jwt = makeJwt({ name: 'Viraj-Alpha', exp: 9999999999, sub: 'u_test' });
    const claims = decodeJwtClaims(jwt);
    expect(claims).not.toBeNull();
    expect(claims?.name).toBe('Viraj-Alpha');
    expect(claims?.exp).toBe(9999999999);
  });

  it('returns null for malformed JWTs', () => {
    expect(decodeJwtClaims('not.a.jwt.but.has.five.parts')).toBeNull();
    expect(decodeJwtClaims('only-one-part')).toBeNull();
    expect(decodeJwtClaims('two.parts')).toBeNull();
  });

  it('extracts JWT body from a real-shaped NATS .creds file (5-dash markers)', () => {
    // Canonical shape emitted by `nsc` / `nats-server` today (verified against
    // a freshly-minted ~/.unblock-personas/<name>/comms-v3.creds 2026-05-28).
    const jwt = makeJwt({ name: 'Test' });
    const creds = [
      '-----BEGIN NATS USER JWT-----',
      jwt,
      '-----END NATS USER JWT-----',
      '',
      '-----BEGIN USER NKEY SEED-----',
      'SUASEEDFAKE',
      '-----END USER NKEY SEED-----',
    ].join('\n');
    expect(extractJwtFromCreds(creds)).toBe(jwt);
  });

  it('extracts JWT body when older 6-dash markers are used', () => {
    // Older NATS writers emitted 6-dash markers. The extractor stays tolerant.
    const jwt = makeJwt({ name: 'Test' });
    const creds = [
      '------BEGIN NATS USER JWT------',
      jwt,
      '------END NATS USER JWT------',
      '',
      '------BEGIN USER NKEY SEED------',
      'SUASEEDFAKE',
      '------END USER NKEY SEED------',
    ].join('\n');
    expect(extractJwtFromCreds(creds)).toBe(jwt);
  });

  it('regression: extractor must not require asymmetric BEGIN/END dash counts (#147)', () => {
    // The pre-fix code looked for 5-dash BEGIN + 6-dash END — a shape no
    // writer actually emits. Real creds use 5/5 (modern) or 6/6 (legacy);
    // both must work, the asymmetric 5/6 shape should as well (defensive).
    const jwt = makeJwt({ name: 'Test' });
    const creds5_5 = `-----BEGIN NATS USER JWT-----\n${jwt}\n-----END NATS USER JWT-----`;
    expect(extractJwtFromCreds(creds5_5)).toBe(jwt);
  });

  it('decodeCreds returns null when no JWT block present', () => {
    expect(decodeCreds('no markers here')).toBeNull();
  });
});
