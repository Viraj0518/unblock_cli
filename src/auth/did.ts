/**
 * did:key minting — Ed25519 keypair → did:key:z6Mk... encoding.
 *
 * Uses `globalThis.crypto.subtle` (WebCrypto) for the keypair so the module
 * runs anywhere a Web-shaped crypto exists (Node 22, edge, Deno). Same
 * algorithm as scripts/identity/persona_nats.py — both produce did:key:z6Mk*
 * identifiers for the same Ed25519 public key.
 *
 * Encoding (per W3C did:key spec, multibase + multicodec):
 *   prefix:   0xed 0x01     (multicodec for Ed25519 public key)
 *   body:     32-byte Ed25519 public key
 *   multibase: base58btc with 'z' prefix
 *   final:    "did:key:z" + base58btc(prefix || body)
 */

import { Buffer } from 'node:buffer';

const ED25519_MULTICODEC_PREFIX = new Uint8Array([0xed, 0x01]);

/** Mint a fresh Ed25519 keypair and return its did:key + hex pubkey. */
export async function mintDidKey(): Promise<{
  readonly did: string;
  readonly publicKeyHex: string;
  readonly privateKeyJwk: JsonWebKey;
}> {
  const keyPair = (await globalThis.crypto.subtle.generateKey(
    { name: 'Ed25519' },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const rawPub = new Uint8Array(await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey));
  const did = encodeDidKey(rawPub);
  const publicKeyHex = bytesToHex(rawPub);
  const privateKeyJwk = await globalThis.crypto.subtle.exportKey('jwk', keyPair.privateKey);
  return { did, publicKeyHex, privateKeyJwk };
}

/** Build the did:key string for an existing Ed25519 raw public key. */
export function encodeDidKey(publicKey: Uint8Array): string {
  if (publicKey.length !== 32) {
    throw new Error(`Ed25519 public key must be 32 bytes (got ${publicKey.length})`);
  }
  const prefixed = new Uint8Array(ED25519_MULTICODEC_PREFIX.length + publicKey.length);
  prefixed.set(ED25519_MULTICODEC_PREFIX, 0);
  prefixed.set(publicKey, ED25519_MULTICODEC_PREFIX.length);
  return `did:key:z${base58btcEncode(prefixed)}`;
}

/** Short DID prefix for human display (e.g. "did:key:z6Mk...oMU61" → "z6Mk…oMU61"). */
export function shortenDid(did: string): string {
  if (!did.startsWith('did:key:')) return did;
  const body = did.slice('did:key:'.length);
  if (body.length <= 12) return body;
  return `${body.slice(0, 6)}…${body.slice(-5)}`;
}

// ─── base58btc encoder (Bitcoin alphabet, no deps) ───────────────────────────

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58btcEncode(bytes: Uint8Array): string {
  if (bytes.length === 0) return '';

  // Count leading zero bytes — each becomes a '1' in the output.
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) {
    zeros++;
  }

  // Convert big-endian bytes to base-58 digits.
  // size = ceil(bytes.length * log(256) / log(58)) + a small buffer
  const size = Math.floor(((bytes.length - zeros) * 138) / 100) + 1;
  const digits = new Uint8Array(size);
  let digitsLen = 0;

  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i] ?? 0;
    let j = 0;
    for (let k = digits.length - 1; (carry !== 0 || j < digitsLen) && k >= 0; k--, j++) {
      carry += 256 * (digits[k] ?? 0);
      digits[k] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    digitsLen = j;
  }

  // Skip leading zero digits in the base58 buffer.
  let start = digits.length - digitsLen;
  while (start < digits.length && digits[start] === 0) {
    start++;
  }

  // Build the output string: zero bytes → '1' prefix, then base58 digits.
  let out = '1'.repeat(zeros);
  for (let i = start; i < digits.length; i++) {
    const d = digits[i];
    if (d !== undefined) {
      const ch = BASE58_ALPHABET[d];
      if (ch !== undefined) out += ch;
    }
  }
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}
