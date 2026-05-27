import { describe, expect, it } from 'vitest';
import { runUpdate } from '../../src/commands/update.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';

describe('runUpdate', () => {
  it('creates a new block version and returns block_id + content_hash', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.updateResponse = { blockId: 'blk_002', contentHash: 'sha256:abc123' };

    const result = await runUpdate(
      { substrateFactory: factory },
      { blockId: 'blk_001', content: 'updated text', revisionReason: 'typo fix', tags: ['note'] },
    );

    expect(result.blockId).toBe('blk_002');
    expect(result.contentHash).toBe('sha256:abc123');
    expect(state.updateCalls).toHaveLength(1);
    expect(state.updateCalls[0]).toMatchObject({
      blockId: 'blk_001',
      content: 'updated text',
      revisionReason: 'typo fix',
      tags: ['note'],
    });
  });

  it('propagates substrate errors', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.updateError = new Error('block not found');

    await expect(
      runUpdate({ substrateFactory: factory }, { blockId: 'blk_missing', content: 'x' }),
    ).rejects.toThrow('block not found');
  });
});
