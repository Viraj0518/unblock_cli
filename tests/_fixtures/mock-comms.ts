/**
 * Test doubles — fake CommsFactory / CommsClient with in-memory pub/sub.
 * Tests assert on `publishedFrames` and inject subs via `deliverTo`.
 */

import type { CommsClient, CommsFactory, Subscription } from '../../src/sdk/types.js';

export interface PublishedFrame {
  readonly subject: string;
  readonly data: Uint8Array;
}

export interface MockCommsState {
  readonly publishedFrames: PublishedFrame[];
  readonly closed: { value: boolean };
  readonly subscribers: Map<string, Set<(frame: PublishedFrame) => void>>;
}

export function createMockCommsFactory(state?: MockCommsState): {
  readonly factory: CommsFactory;
  readonly state: MockCommsState;
} {
  const s: MockCommsState = state ?? {
    publishedFrames: [],
    closed: { value: false },
    subscribers: new Map(),
  };

  const factory: CommsFactory = {
    connect: async (): Promise<CommsClient> => ({
      publish(subject, data): void {
        const frame: PublishedFrame = { subject, data };
        s.publishedFrames.push(frame);
        const subs = s.subscribers.get(subject);
        if (subs !== undefined) {
          for (const cb of subs) cb(frame);
        }
      },
      subscribe(subject): Subscription {
        const queue: PublishedFrame[] = [];
        const waiters: Array<(f: PublishedFrame | null) => void> = [];
        let closed = false;

        const cb = (f: PublishedFrame): void => {
          const w = waiters.shift();
          if (w !== undefined) w(f);
          else queue.push(f);
        };
        const set = s.subscribers.get(subject) ?? new Set();
        set.add(cb);
        s.subscribers.set(subject, set);

        const unsubscribe = (): void => {
          closed = true;
          set.delete(cb);
          for (const w of waiters) w(null);
          waiters.length = 0;
        };

        return {
          [Symbol.asyncIterator]: () => ({
            next: async (): Promise<IteratorResult<PublishedFrame>> => {
              if (queue.length > 0) {
                const v = queue.shift();
                if (v !== undefined) return { value: v, done: false };
              }
              if (closed) return { value: undefined, done: true };
              return new Promise((resolve) => {
                waiters.push((f) => {
                  if (f === null) resolve({ value: undefined, done: true });
                  else resolve({ value: f, done: false });
                });
              });
            },
          }),
          unsubscribe,
        };
      },
      flush: async (): Promise<void> => undefined,
      close: async (): Promise<void> => {
        s.closed.value = true;
      },
    }),
  };
  return { factory, state: s };
}

/** Helper: decode a published frame as a parsed JSON envelope. */
export function decodeFrame(f: PublishedFrame): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(f.data)) as Record<string, unknown>;
}
