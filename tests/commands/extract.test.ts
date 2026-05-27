import { describe, expect, it } from 'vitest';
import { runExtract } from '../../src/commands/extract.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';

describe('runExtract', () => {
  it('extracts facts from a block_id and returns the facts array', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.extractResponse = { facts: [{ name: 'Alice', role: 'engineer' }] };

    const result = await runExtract(
      { substrateFactory: factory },
      { blockId: 'blk_001' },
    );

    expect(result.facts).toHaveLength(1);
    expect(result.facts[0]).toMatchObject({ name: 'Alice', role: 'engineer' });
    expect(state.extractCalls).toHaveLength(1);
    expect(state.extractCalls[0]).toMatchObject({ blockId: 'blk_001' });
  });

  it('propagates substrate errors', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.extractError = new Error('block_id or query required');

    await expect(
      runExtract({ substrateFactory: factory }, {}),
    ).rejects.toThrow('block_id or query required');
  });
});
