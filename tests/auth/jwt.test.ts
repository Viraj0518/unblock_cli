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

  it('extracts JWT body from a NATS .creds file', () => {
    const jwt = makeJwt({ name: 'Test' });
    const creds = [
      '-----BEGIN NATS USER JWT-----',
      jwt,
      '------END NATS USER JWT------',
      '',
      '-----BEGIN USER NKEY SEED-----',
      'SUASEEDFAKE',
      '------END USER NKEY SEED------',
    ].join('\n');
    expect(extractJwtFromCreds(creds)).toBe(jwt);
  });

  it('decodeCreds returns null when no JWT block present', () => {
    expect(decodeCreds('no markers here')).toBeNull();
  });
});
