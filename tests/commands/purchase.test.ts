import { describe, expect, it } from 'vitest';
import { runPurchase } from '../../src/commands/purchase.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';

describe('runPurchase', () => {
  it('purchases by listing_id and returns receipt', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.purchaseResponse = { blockId: 'blk_001', receiptId: 'rcpt_abc' };

    const result = await runPurchase(
      { substrateFactory: factory },
      { listingId: 'lst_001', maxPrice: 10.0, paymentMethod: 'relay' },
    );

    expect(result.blockId).toBe('blk_001');
    expect(result.receiptId).toBe('rcpt_abc');
    expect(state.purchaseCalls).toHaveLength(1);
    expect(state.purchaseCalls[0]).toMatchObject({
      listingId: 'lst_001',
      maxPrice: 10.0,
      paymentMethod: 'relay',
    });
  });

  it('propagates substrate errors', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.purchaseError = new Error('insufficient funds');

    await expect(
      runPurchase({ substrateFactory: factory }, { blockId: 'blk_x' }),
    ).rejects.toThrow('insufficient funds');
  });
});
