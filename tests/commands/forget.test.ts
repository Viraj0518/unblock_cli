import { describe, expect, it } from 'vitest';
import { runForget } from '../../src/commands/forget.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';

describe('runForget', () => {
  it('soft-deletes a block and returns deletion metadata', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.forgetResponse = {
      blockId: 'blk_001',
      deletedAt: 1716825600,
      mode: 'soft',
      cascadeCount: 0,
      hardDeleteEligibleAt: 1719417600,
    };

    const result = await runForget(
      { substrateFactory: factory },
      { blockId: 'blk_001', mode: 'soft', reason: 'outdated' },
    );

    expect(result.blockId).toBe('blk_001');
    expect(result.mode).toBe('soft');
    expect(result.cascadeCount).toBe(0);
    expect(state.forgetCalls).toHaveLength(1);
    expect(state.forgetCalls[0]).toMatchObject({
      blockId: 'blk_001',
      mode: 'soft',
      reason: 'outdated',
    });
  });

  it('propagates substrate errors', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.forgetError = new Error('block not found');

    await expect(
      runForget({ substrateFactory: factory }, { blockId: 'blk_missing' }),
    ).rejects.toThrow('block not found');
  });
});
