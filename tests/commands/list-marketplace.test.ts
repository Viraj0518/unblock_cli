import { describe, expect, it } from 'vitest';
import { runListMarketplace } from '../../src/commands/list-marketplace.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';

describe('runListMarketplace', () => {
  it('passes block_id and price to the substrate client', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.listResponse = { listingId: 'lst_001' };

    const result = await runListMarketplace(
      { substrateFactory: factory },
      { blockId: 'blk_001', priceUnblock: 4.99, tier: 2, summary: 'Great block' },
    );

    expect(result.listingId).toBe('lst_001');
    expect(state.listCalls).toHaveLength(1);
    expect(state.listCalls[0]).toMatchObject({
      blockId: 'blk_001',
      priceUnblock: 4.99,
      tier: 2,
      summary: 'Great block',
    });
  });

  it('propagates substrate errors', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.listError = new Error('payment required');

    await expect(
      runListMarketplace({ substrateFactory: factory }, { blockId: 'blk_x', priceUnblock: 1.0 }),
    ).rejects.toThrow('payment required');
  });
});
