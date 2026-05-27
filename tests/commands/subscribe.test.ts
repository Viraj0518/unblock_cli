import { describe, expect, it } from 'vitest';
import { runSubscribe } from '../../src/commands/subscribe.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';

describe('runSubscribe', () => {
  it('registers a webhook and returns subscription_id', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.subscribeResponse = { subscriptionId: 'sub_001' };

    const result = await runSubscribe(
      { substrateFactory: factory },
      {
        url: 'https://example.com/webhook',
        events: ['block.created', 'block.updated'],
        secret: 'supersecret1234567890',
        active: true,
      },
    );

    expect(result.subscriptionId).toBe('sub_001');
    expect(state.subscribeCalls).toHaveLength(1);
    expect(state.subscribeCalls[0]).toMatchObject({
      url: 'https://example.com/webhook',
      events: ['block.created', 'block.updated'],
      secret: 'supersecret1234567890',
      active: true,
    });
  });

  it('propagates substrate errors', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.subscribeError = new Error('url must be https');

    await expect(
      runSubscribe({ substrateFactory: factory }, {
        url: 'http://insecure.example.com',
        events: ['block.created'],
        secret: 'tooShort',
      }),
    ).rejects.toThrow('url must be https');
  });
});
