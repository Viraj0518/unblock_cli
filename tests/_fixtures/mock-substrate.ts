/**
 * Test double — fake SubstrateFactory with scripted responses.
 */

import type {
  AttestInput,
  AttestResult,
  EnrollResult,
  ExtractInput,
  ExtractResult,
  ForgetInput,
  ForgetResult,
  ListInput,
  ListResult,
  PurchaseInput,
  PurchaseResult,
  QueryHit,
  RememberInput,
  RememberResult,
  ShareInput,
  ShareResult,
  SubstrateClient,
  SubstrateFactory,
  SubscribeInput,
  SubscribeResult,
  UpdateInput,
  UpdateResult,
  VerifyInput,
  VerifyResult,
} from '../../src/sdk/types.js';

export interface MockSubstrateState {
  readonly enrollCalls: Array<{ authUrl: string; inviteCode: string; did: string; agentName: string }>;
  readonly rememberCalls: RememberInput[];
  readonly queryCalls: Array<{ q: string; topK?: number }>;
  readonly shareCalls: ShareInput[];
  readonly listCalls: ListInput[];
  readonly purchaseCalls: PurchaseInput[];
  readonly verifyCalls: VerifyInput[];
  readonly attestCalls: AttestInput[];
  readonly subscribeCalls: SubscribeInput[];
  readonly updateCalls: UpdateInput[];
  readonly extractCalls: ExtractInput[];
  readonly forgetCalls: ForgetInput[];
  enrollResponse?: EnrollResult;
  rememberResponse?: RememberResult;
  queryResponse?: readonly QueryHit[];
  shareResponse?: ShareResult;
  listResponse?: ListResult;
  purchaseResponse?: PurchaseResult;
  verifyResponse?: VerifyResult;
  attestResponse?: AttestResult;
  subscribeResponse?: SubscribeResult;
  updateResponse?: UpdateResult;
  extractResponse?: ExtractResult;
  forgetResponse?: ForgetResult;
  enrollError?: Error;
  shareError?: Error;
  listError?: Error;
  purchaseError?: Error;
  verifyError?: Error;
  attestError?: Error;
  subscribeError?: Error;
  updateError?: Error;
  extractError?: Error;
  forgetError?: Error;
}

export function createMockSubstrateFactory(state?: MockSubstrateState): {
  readonly factory: SubstrateFactory;
  readonly state: MockSubstrateState;
} {
  const s: MockSubstrateState = state ?? {
    enrollCalls: [],
    rememberCalls: [],
    queryCalls: [],
    shareCalls: [],
    listCalls: [],
    purchaseCalls: [],
    verifyCalls: [],
    attestCalls: [],
    subscribeCalls: [],
    updateCalls: [],
    extractCalls: [],
    forgetCalls: [],
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
        async share(input): Promise<ShareResult> {
          s.shareCalls.push(input);
          if (s.shareError !== undefined) throw s.shareError;
          if (s.shareResponse === undefined) throw new Error('mock-substrate: no shareResponse configured');
          return s.shareResponse;
        },
        async listMarketplace(input): Promise<ListResult> {
          s.listCalls.push(input);
          if (s.listError !== undefined) throw s.listError;
          if (s.listResponse === undefined) throw new Error('mock-substrate: no listResponse configured');
          return s.listResponse;
        },
        async purchase(input): Promise<PurchaseResult> {
          s.purchaseCalls.push(input);
          if (s.purchaseError !== undefined) throw s.purchaseError;
          if (s.purchaseResponse === undefined) throw new Error('mock-substrate: no purchaseResponse configured');
          return s.purchaseResponse;
        },
        async verify(input): Promise<VerifyResult> {
          s.verifyCalls.push(input);
          if (s.verifyError !== undefined) throw s.verifyError;
          if (s.verifyResponse === undefined) throw new Error('mock-substrate: no verifyResponse configured');
          return s.verifyResponse;
        },
        async attest(input): Promise<AttestResult> {
          s.attestCalls.push(input);
          if (s.attestError !== undefined) throw s.attestError;
          if (s.attestResponse === undefined) throw new Error('mock-substrate: no attestResponse configured');
          return s.attestResponse;
        },
        async subscribe(input): Promise<SubscribeResult> {
          s.subscribeCalls.push(input);
          if (s.subscribeError !== undefined) throw s.subscribeError;
          if (s.subscribeResponse === undefined) throw new Error('mock-substrate: no subscribeResponse configured');
          return s.subscribeResponse;
        },
        async update(input): Promise<UpdateResult> {
          s.updateCalls.push(input);
          if (s.updateError !== undefined) throw s.updateError;
          if (s.updateResponse === undefined) throw new Error('mock-substrate: no updateResponse configured');
          return s.updateResponse;
        },
        async extract(input): Promise<ExtractResult> {
          s.extractCalls.push(input);
          if (s.extractError !== undefined) throw s.extractError;
          if (s.extractResponse === undefined) throw new Error('mock-substrate: no extractResponse configured');
          return s.extractResponse;
        },
        async forget(input): Promise<ForgetResult> {
          s.forgetCalls.push(input);
          if (s.forgetError !== undefined) throw s.forgetError;
          if (s.forgetResponse === undefined) throw new Error('mock-substrate: no forgetResponse configured');
          return s.forgetResponse;
        },
      };
    },
  };
  return { factory, state: s };
}
