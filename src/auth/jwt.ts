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

/**
 * Extract the JWT body from a .creds file. Returns null if no JWT block found.
 *
 * Tolerant of 5+ dashes on either side of the BEGIN/END marker. NATS writers
 * across versions emit either 5 dashes (current `nsc` / `nats-server`) or 6
 * dashes (older clients + some test fixtures), and the literal-string matcher
 * previously here only accepted exactly 5+5 BEGIN with exactly 6+6 END — i.e.
 * it matched neither the canonical 5/5 shape nor the canonical 6/6 shape, only
 * an asymmetric hybrid that no writer produces. `subjects` was the first call
 * site to actually exercise this function in production; all earlier verbs
 * pass the `.creds` path to the NATS SDK which has its own (correct) parser.
 */
export function extractJwtFromCreds(creds: string): string | null {
  const startRe = /^-{5,}BEGIN NATS USER JWT-{5,}\s*$/m;
  const endRe = /^-{5,}END NATS USER JWT-{5,}\s*$/m;
  const startMatch = startRe.exec(creds);
  if (startMatch === null) return null;
  const bodyStart = startMatch.index + startMatch[0].length;
  const rest = creds.slice(bodyStart);
  const endMatch = endRe.exec(rest);
  if (endMatch === null) return null;
  return rest.slice(0, endMatch.index).trim().replace(/\s+/g, '');
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
