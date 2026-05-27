import { describe, expect, it } from 'vitest';
import { runShare } from '../../src/commands/share.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';

describe('runShare', () => {
  it('passes block_id, recipient, and permissions to the substrate client', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.shareResponse = { shareId: 'shr_abc', blockId: 'blk_001' };

    const result = await runShare(
      { substrateFactory: factory },
      { blockId: 'blk_001', recipient: 'did:key:z6MkAlice', permissions: ['read', 'write'] },
    );

    expect(result.shareId).toBe('shr_abc');
    expect(result.blockId).toBe('blk_001');
    expect(state.shareCalls).toHaveLength(1);
    expect(state.shareCalls[0]).toEqual({
      blockId: 'blk_001',
      recipient: 'did:key:z6MkAlice',
      permissions: ['read', 'write'],
    });
  });

  it('propagates substrate errors', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.shareError = new Error('forbidden');

    await expect(
      runShare({ substrateFactory: factory }, { blockId: 'blk_x', recipient: 'bob' }),
    ).rejects.toThrow('forbidden');
  });
});
