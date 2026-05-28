/**
 * Test doubles — fake CommsFactory / CommsClient with in-memory pub/sub.
 * Tests assert on `publishedFrames` and inject subs via `deliverTo`.
 */

import type {
  CommsClient,
  CommsFactory,
  JetStream,
  JetStreamConsumeOptions,
  JetStreamFrame,
  Subscription,
} from '../../src/sdk/types.js';

export interface PublishedFrame {
  readonly subject: string;
  readonly data: Uint8Array;
  /** Optional reply-to subject (NATS request-reply). Tests inject this to
   * exercise the auto-ack code-path on the listener. */
  readonly reply?: string;
}

export interface MockCommsState {
  readonly publishedFrames: PublishedFrame[];
  readonly closed: { value: boolean };
  readonly subscribers: Map<string, Set<(frame: PublishedFrame) => void>>;
  /**
   * JetStream consume invocations — tests assert on the options the listener
   * passed (deliverPolicy, durableName, filterSubject) plus inject frames.
   */
  readonly jsConsumeCalls: JetStreamConsumeOptions[];
  /**
   * Frames to deliver to JetStream consumers, keyed by filterSubject. Tests
   * pre-populate this before calling runListen; the consume loop drains it
   * then waits for abort.
   */
  readonly jsFramesBySubject: Map<string, JetStreamFrame[]>;
}

export function createMockCommsFactory(state?: MockCommsState): {
  readonly factory: CommsFactory;
  readonly state: MockCommsState;
} {
  const s: MockCommsState = state ?? {
    publishedFrames: [],
    closed: { value: false },
    subscribers: new Map(),
    jsConsumeCalls: [],
    jsFramesBySubject: new Map(),
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
            next: async (): Promise<IteratorResult<{
              subject: string;
              data: Uint8Array;
              reply?: string;
            }>> => {
              if (queue.length > 0) {
                const v = queue.shift();
                if (v !== undefined) {
                  return {
                    value: {
                      subject: v.subject,
                      data: v.data,
                      ...(v.reply !== undefined ? { reply: v.reply } : {}),
                    },
                    done: false,
                  };
                }
              }
              if (closed) return { value: undefined, done: true };
              return new Promise((resolve) => {
                waiters.push((f) => {
                  if (f === null) resolve({ value: undefined, done: true });
                  else
                    resolve({
                      value: {
                        subject: f.subject,
                        data: f.data,
                        ...(f.reply !== undefined ? { reply: f.reply } : {}),
                      },
                      done: false,
                    });
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
      jetstream: buildMockJetStream(s),
    }),
  };
  return { factory, state: s };
}

/** Helper: decode a published frame as a parsed JSON envelope. */
export function decodeFrame(f: PublishedFrame): Record<string, unknown> {
  return JSON.parse(new TextDecoder().decode(f.data)) as Record<string, unknown>;
}

/**
 * Build a mock JetStream that records every consume() call onto
 * `state.jsConsumeCalls` and yields any frames pre-seeded into
 * `state.jsFramesBySubject` for the matching filterSubject, then blocks
 * until `opts.signal` aborts. Each yielded frame's ack() is tracked by
 * incrementing a counter on the frame object itself for test assertions.
 */
function buildMockJetStream(state: MockCommsState): JetStream {
  return {
    consume(opts: JetStreamConsumeOptions): AsyncIterable<JetStreamFrame> {
      state.jsConsumeCalls.push(opts);
      const frames = state.jsFramesBySubject.get(opts.filterSubject) ?? [];
      return {
        [Symbol.asyncIterator]: () => {
          let i = 0;
          let aborted = opts.signal?.aborted === true;
          const abortPromise = new Promise<void>((resolve) => {
            if (opts.signal === undefined) return;
            if (opts.signal.aborted) {
              aborted = true;
              resolve();
              return;
            }
            opts.signal.addEventListener(
              'abort',
              () => {
                aborted = true;
                resolve();
              },
              { once: true },
            );
          });
          return {
            next: async (): Promise<IteratorResult<JetStreamFrame>> => {
              if (i < frames.length) {
                const f = frames[i++];
                if (f === undefined) return { value: undefined, done: true };
                return { value: f, done: false };
              }
              await abortPromise;
              void aborted;
              return { value: undefined, done: true };
            },
          };
        },
      };
    },
  };
}

/**
 * Build a JetStreamFrame from a JSON payload. Tracks ack() calls onto the
 * returned record so tests can assert "consumer acked N messages".
 */
export function makeJsFrame(
  subject: string,
  payload: unknown,
): { readonly frame: JetStreamFrame; readonly state: { acked: number } } {
  const data = new TextEncoder().encode(
    typeof payload === 'string' ? payload : JSON.stringify(payload),
  );
  const ackState = { acked: 0 };
  return {
    frame: {
      subject,
      data,
      ack: () => {
        ackState.acked++;
      },
    },
    state: ackState,
  };
}
