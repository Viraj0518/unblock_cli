/**
 * Test double — fake SubstrateFactory with scripted responses.
 */

import type {
  EnrollResult,
  QueryHit,
  RememberInput,
  RememberResult,
  SubstrateClient,
  SubstrateFactory,
} from '../../src/sdk/types.js';

export interface MockSubstrateState {
  readonly enrollCalls: Array<{ authUrl: string; inviteCode: string; did: string; agentName: string }>;
  readonly rememberCalls: RememberInput[];
  readonly queryCalls: Array<{ q: string; topK?: number }>;
  enrollResponse?: EnrollResult;
  rememberResponse?: RememberResult;
  queryResponse?: readonly QueryHit[];
  enrollError?: Error;
}

export function createMockSubstrateFactory(state?: MockSubstrateState): {
  readonly factory: SubstrateFactory;
  readonly state: MockSubstrateState;
} {
  const s: MockSubstrateState = state ?? {
    enrollCalls: [],
    rememberCalls: [],
    queryCalls: [],
  };
  const factory: SubstrateFactory = {
    create({ authUrl }): SubstrateClient {
      return {
        async enroll({ inviteCode, identity }): Promise<EnrollResult> {
          s.enrollCalls.push({
            authUrl,
            inviteCode,
            did: identity.did,
            agentName: identity.agentName,
          });
          if (s.enrollError !== undefined) throw s.enrollError;
          if (s.enrollResponse === undefined) {
            throw new Error('mock-substrate: no enrollResponse configured');
          }
          return s.enrollResponse;
        },
        async remember(input): Promise<RememberResult> {
          s.rememberCalls.push(input);
          if (s.rememberResponse === undefined) {
            throw new Error('mock-substrate: no rememberResponse configured');
          }
          return s.rememberResponse;
        },
        async query(q, opts): Promise<readonly QueryHit[]> {
          s.queryCalls.push(opts?.topK !== undefined ? { q, topK: opts.topK } : { q });
          return s.queryResponse ?? [];
        },
      };
    },
  };
  return { factory, state: s };
}
