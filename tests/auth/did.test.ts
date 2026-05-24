import { describe, expect, it } from 'vitest';
import { encodeDidKey, mintDidKey, shortenDid } from '../../src/auth/did.js';

describe('did:key minting', () => {
  it('mints a unique did:key per call', async () => {
    const a = await mintDidKey();
    const b = await mintDidKey();
    expect(a.did).not.toBe(b.did);
    expect(a.did.startsWith('did:key:z')).toBe(true);
    expect(b.did.startsWith('did:key:z')).toBe(true);
  });

  it('public key is 32 raw bytes (64 hex chars)', async () => {
    const m = await mintDidKey();
    expect(m.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
  });

  it('encodeDidKey rejects wrong key length', () => {
    expect(() => encodeDidKey(new Uint8Array(31))).toThrow(/32 bytes/);
    expect(() => encodeDidKey(new Uint8Array(33))).toThrow(/32 bytes/);
  });

  it('encodeDidKey produces stable output for a known key', () => {
    // 32 bytes of 0x00 → multicodec prefix 0xed 0x01 + 32 zeros = 34 bytes,
    // base58btc encoded with 'z' prefix.
    const zeros = new Uint8Array(32);
    const did = encodeDidKey(zeros);
    // Should start with did:key:z and produce a deterministic body.
    expect(did.startsWith('did:key:z')).toBe(true);
    expect(encodeDidKey(zeros)).toBe(did);
  });

  it('shortenDid produces a readable shortform', () => {
    const did = 'did:key:z6MkfakeFakeFakeFakeFakeFakeFakeFakeFakeFake';
    const short = shortenDid(did);
    expect(short).toContain('…');
    expect(short.length).toBeLessThan(did.length);
  });

  it('shortenDid passes through non-did:key strings unchanged', () => {
    expect(shortenDid('not-a-did')).toBe('not-a-did');
  });
});
