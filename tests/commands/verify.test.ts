import { describe, expect, it } from 'vitest';
import { runVerify } from '../../src/commands/verify.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';

describe('runVerify', () => {
  it('verifies by block_id and returns signature_valid + attestations', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.verifyResponse = {
      blockId: 'blk_001',
      signatureValid: true,
      attestations: [{ attesterId: 'did:key:z6MkBob', statement: 'accurate' }],
    };

    const result = await runVerify(
      { substrateFactory: factory },
      { blockId: 'blk_001' },
    );

    expect(result.signatureValid).toBe(true);
    expect(result.attestations).toHaveLength(1);
    expect(result.attestations[0]?.attesterId).toBe('did:key:z6MkBob');
    expect(state.verifyCalls).toHaveLength(1);
    expect(state.verifyCalls[0]).toMatchObject({ blockId: 'blk_001' });
  });

  it('propagates substrate errors', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.verifyError = new Error('block not found');

    await expect(
      runVerify({ substrateFactory: factory }, { blockId: 'blk_missing' }),
    ).rejects.toThrow('block not found');
  });
});
