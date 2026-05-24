/**
 * NATS .creds file → decoded User JWT.
 *
 * A NATS .creds file is two armored blocks:
 *
 *   -----BEGIN NATS USER JWT-----
 *   <base64url-encoded JWT>
 *   ------END NATS USER JWT------
 *   ...
 *   -----BEGIN USER NKEY SEED-----
 *   <NATS nkey seed>
 *   ------END USER NKEY SEED------
 *
 * We only need the JWT to surface persona name, broker URL, and expiry to
 * `whoami`. The nkey seed is consumed by the NATS client when it
 * authenticates — never by this CLI directly.
 *
 * JWTs in NATS land are 3-part base64url-encoded payloads
 * (header.payload.signature) where the payload is JSON.
 */

import { Buffer } from 'node:buffer';

export interface UserJwtClaims {
  /** Issued-at — seconds since epoch. */
  readonly iat?: number;
  /** Expires-at — seconds since epoch. 0 / missing = no expiry. */
  readonly exp?: number;
  /** Subject — usually the user's nkey public key. */
  readonly sub?: string;
  /** Issuer — the account that signed this user JWT. */
  readonly iss?: string;
  /** Display name (NATS-specific). */
  readonly name?: string;
  /** NATS user permissions (publish/subscribe allow/deny). */
  readonly nats?: {
    readonly pub?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
    readonly sub?: { readonly allow?: readonly string[]; readonly deny?: readonly string[] };
    readonly subs?: number;
    readonly data?: number;
    readonly payload?: number;
  };
  readonly [key: string]: unknown;
}

/** Extract the JWT body from a .creds file. Returns null if no JWT block found. */
export function extractJwtFromCreds(creds: string): string | null {
  const startMarker = '-----BEGIN NATS USER JWT-----';
  const endMarker = '------END NATS USER JWT------';
  const start = creds.indexOf(startMarker);
  if (start < 0) return null;
  const end = creds.indexOf(endMarker, start + startMarker.length);
  if (end < 0) return null;
  return creds
    .slice(start + startMarker.length, end)
    .trim()
    .replace(/\s+/g, '');
}

/** Decode a 3-part NATS JWT payload (no signature verification). */
export function decodeJwtClaims(jwt: string): UserJwtClaims | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  const payloadB64 = parts[1];
  if (payloadB64 === undefined) return null;
  try {
    const decoded = Buffer.from(base64UrlToBase64(payloadB64), 'base64').toString('utf-8');
    const parsed: unknown = JSON.parse(decoded);
    if (typeof parsed === 'object' && parsed !== null) {
      return parsed as UserJwtClaims;
    }
  } catch {
    /* swallow */
  }
  return null;
}

/** Convenience: read .creds content → claims, or null on any error. */
export function decodeCreds(creds: string): UserJwtClaims | null {
  const jwt = extractJwtFromCreds(creds);
  if (jwt === null) return null;
  return decodeJwtClaims(jwt);
}

function base64UrlToBase64(s: string): string {
  return s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
}
