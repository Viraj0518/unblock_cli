import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runRemember } from '../../src/commands/remember.js';
import { runQuery } from '../../src/commands/query.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
});
afterEach(async () => {
  await tmp.dispose();
});

describe('runRemember', () => {
  it('passes content + tags + parent to the substrate client', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.rememberResponse = { blockId: 'blk_abc', storedAt: '2026-05-24T00:00:00Z' };
    const result = await runRemember(
      { substrateFactory: factory },
      { content: 'hello', tags: ['note'], parentBlockId: 'blk_parent' },
    );
    expect(result.blockId).toBe('blk_abc');
    expect(state.rememberCalls).toHaveLength(1);
    expect(state.rememberCalls[0]).toEqual({
      content: 'hello',
      tags: ['note'],
      parentBlockId: 'blk_parent',
    });
  });

  it('omits optional fields when not provided', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.rememberResponse = { blockId: 'blk_y', storedAt: 't' };
    await runRemember({ substrateFactory: factory }, { content: 'bare' });
    expect(state.rememberCalls[0]).toEqual({ content: 'bare' });
  });
});

describe('runQuery', () => {
  it('forwards query + topK and returns hits', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.queryResponse = [
      { blockId: 'blk_1', score: 0.92, snippet: 'first' },
      { blockId: 'blk_2', score: 0.81, snippet: 'second' },
    ];
    const hits = await runQuery(
      { substrateFactory: factory },
      { query: 'who shipped X', topK: 5 },
    );
    expect(hits).toHaveLength(2);
    expect(hits[0]?.blockId).toBe('blk_1');
    expect(state.queryCalls[0]).toEqual({ q: 'who shipped X', topK: 5 });
  });
});
