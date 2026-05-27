import { describe, expect, it } from 'vitest';
import { runAttest } from '../../src/commands/attest.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';

describe('runAttest', () => {
  it('attests a block with score and text and returns attestation_id', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.attestResponse = { attestationId: 'att_001' };

    const result = await runAttest(
      { substrateFactory: factory },
      { blockId: 'blk_001', score: 0.95, attestationText: 'High quality' },
    );

    expect(result.attestationId).toBe('att_001');
    expect(state.attestCalls).toHaveLength(1);
    expect(state.attestCalls[0]).toMatchObject({
      blockId: 'blk_001',
      score: 0.95,
      attestationText: 'High quality',
    });
  });

  it('propagates substrate errors', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.attestError = new Error('score out of range');

    await expect(
      runAttest({ substrateFactory: factory }, { blockId: 'blk_x', score: 2 }),
    ).rejects.toThrow('score out of range');
  });
});
