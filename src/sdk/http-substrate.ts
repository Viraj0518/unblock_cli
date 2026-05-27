/**
 * HTTP substrate client — minimal POST/GET shim against the auth-issuer
 * and catalog-api. Bridge until `unblock_sdk` ships a real client.
 *
 * Why hand-roll this instead of stubbing:
 *   - `login` needs to actually round-trip an invite code; without it
 *     `whoami`/`chat`/`say` have nothing to read.
 *   - The endpoint shapes are stable per ADR-116 (Wave 3F-2).
 *
 * Endpoints used:
 *   POST <authUrl>/v1/identity/enroll  → { nats_creds, nats_url, workspace_id, org_id, name, expires_at? }
 *   POST <authUrl>/v1/remember          → { block_id, stored_at }  (TODO: ship in Stage 3)
 *   POST <authUrl>/v1/query             → readonly QueryHit[]      (TODO: ship in Stage 3)
 */

import type {
  AttestResult,
  EnrollResult,
  ExtractResult,
  ForgetResult,
  ListResult,
  PurchaseResult,
  QueryHit,
  RememberInput,
  RememberResult,
  ShareResult,
  SubstrateClient,
  SubstrateFactory,
  SubscribeResult,
  UpdateResult,
  VerifyResult,
} from './types.js';
import type { PersonaIdentity } from '../auth/persona-store.js';

export const DEFAULT_AUTH_URL = 'https://auth.kaeva.app';

export function createHttpSubstrateFactory(
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): SubstrateFactory {
  return {
    create({ authUrl, token }): SubstrateClient {
      const base = authUrl.replace(/\/+$/, '');
      const headersFor = async (): Promise<Record<string, string>> => {
        const h: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json',
        };
        if (token !== undefined) {
          h['authorization'] = `Bearer ${await token()}`;
        }
        return h;
      };

      return {
        async enroll(input): Promise<EnrollResult> {
          const res = await fetcher(`${base}/v1/identity/enroll`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify({
              invite_code: input.inviteCode,
              did: input.identity.did,
              agent_name: input.identity.agentName,
              ed25519_public_key_hex: input.identity.ed25519PublicKeyHex,
            }),
          });
          if (!res.ok) {
            throw new EnrollError(res.status, await readText(res));
          }
          const body: unknown = await res.json();
          return parseEnrollResponse(body);
        },

        async remember(input): Promise<RememberResult> {
          const res = await fetcher(`${base}/v1/remember`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(rememberBody(input)),
          });
          if (!res.ok) {
            throw new SubstrateError(res.status, await readText(res));
          }
          const body: unknown = await res.json();
          return parseRememberResponse(body);
        },

        async query(q, opts): Promise<readonly QueryHit[]> {
          const params = new URLSearchParams({ q });
          if (opts?.topK !== undefined) params.set('top_k', String(opts.topK));
          const res = await fetcher(`${base}/v1/query?${params.toString()}`, {
            method: 'GET',
            headers: await headersFor(),
          });
          if (!res.ok) {
            throw new SubstrateError(res.status, await readText(res));
          }
          const body: unknown = await res.json();
          return parseQueryHits(body);
        },

        async share(input): Promise<ShareResult> {
          const body: Record<string, unknown> = {
            block_id: input.blockId,
            recipient: input.recipient,
          };
          if (input.permissions !== undefined) body['permissions'] = input.permissions;
          if (input.expiresAt !== undefined) body['expires_at'] = input.expiresAt;
          const res = await fetcher(`${base}/v1/share`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new SubstrateError(res.status, await readText(res));
          const raw: unknown = await res.json();
          return parseShareResponse(raw);
        },

        async listMarketplace(input): Promise<ListResult> {
          const body: Record<string, unknown> = {
            block_id: input.blockId,
            price_unblock: input.priceUnblock,
          };
          if (input.tier !== undefined) body['tier'] = input.tier;
          if (input.royaltyShareWith !== undefined) body['royalty_share_with'] = input.royaltyShareWith;
          if (input.delistExisting !== undefined) body['delist_existing'] = input.delistExisting;
          if (input.summary !== undefined) body['summary'] = input.summary;
          const res = await fetcher(`${base}/v1/list`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new SubstrateError(res.status, await readText(res));
          const raw: unknown = await res.json();
          return parseListResponse(raw);
        },

        async purchase(input): Promise<PurchaseResult> {
          const body: Record<string, unknown> = {};
          if (input.blockId !== undefined) body['block_id'] = input.blockId;
          if (input.listingId !== undefined) body['listing_id'] = input.listingId;
          if (input.maxPrice !== undefined) body['max_price'] = input.maxPrice;
          if (input.paymentMethod !== undefined) body['payment_method'] = input.paymentMethod;
          if (input.walletName !== undefined) body['wallet_name'] = input.walletName;
          const res = await fetcher(`${base}/v1/purchase`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new SubstrateError(res.status, await readText(res));
          const raw: unknown = await res.json();
          return parsePurchaseResponse(raw);
        },

        async verify(input): Promise<VerifyResult> {
          const body: Record<string, unknown> = {
            block_id: input.blockId ?? null,
            content_hash: input.contentHash ?? null,
            signature: input.signature ?? null,
          };
          const res = await fetcher(`${base}/v1/verify`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new SubstrateError(res.status, await readText(res));
          const raw: unknown = await res.json();
          return parseVerifyResponse(raw);
        },

        async attest(input): Promise<AttestResult> {
          const body: Record<string, unknown> = {
            block_id: input.blockId,
            score: input.score,
          };
          if (input.attestationText !== undefined) body['attestation_text'] = input.attestationText;
          if (input.signature !== undefined) body['signature'] = input.signature;
          if (input.metadata !== undefined) body['metadata'] = input.metadata;
          const res = await fetcher(`${base}/v1/attest`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new SubstrateError(res.status, await readText(res));
          const raw: unknown = await res.json();
          return parseAttestResponse(raw);
        },

        async subscribe(input): Promise<SubscribeResult> {
          const body: Record<string, unknown> = {
            url: input.url,
            events: input.events,
            secret: input.secret,
          };
          if (input.filter !== undefined) body['filter'] = input.filter;
          if (input.active !== undefined) body['active'] = input.active;
          const res = await fetcher(`${base}/v1/subscribe`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new SubstrateError(res.status, await readText(res));
          const raw: unknown = await res.json();
          return parseSubscribeResponse(raw);
        },

        async update(input): Promise<UpdateResult> {
          const body: Record<string, unknown> = {
            block_id: input.blockId,
            content: input.content,
          };
          if (input.rejectedAlternatives !== undefined) body['rejected_alternatives'] = input.rejectedAlternatives;
          if (input.revisionReason !== undefined) body['revision_reason'] = input.revisionReason;
          if (input.tags !== undefined) body['tags'] = input.tags;
          if (input.metadata !== undefined) body['metadata'] = input.metadata;
          if (input.clientMsgId !== undefined) body['client_msg_id'] = input.clientMsgId;
          const res = await fetcher(`${base}/v1/update`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new SubstrateError(res.status, await readText(res));
          const raw: unknown = await res.json();
          return parseUpdateResponse(raw);
        },

        async extract(input): Promise<ExtractResult> {
          const body: Record<string, unknown> = {};
          if (input.blockId !== undefined) body['block_id'] = input.blockId;
          if (input.query !== undefined) body['query'] = input.query;
          if (input.schema !== undefined) body['schema'] = input.schema;
          const res = await fetcher(`${base}/v1/extract`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new SubstrateError(res.status, await readText(res));
          const raw: unknown = await res.json();
          return parseExtractResponse(raw);
        },

        async forget(input): Promise<ForgetResult> {
          const body: Record<string, unknown> = { block_id: input.blockId };
          if (input.mode !== undefined) body['mode'] = input.mode;
          if (input.reason !== undefined) body['reason'] = input.reason;
          if (input.gdprRequest !== undefined) body['gdpr_request'] = input.gdprRequest;
          const res = await fetcher(`${base}/v1/forget`, {
            method: 'POST',
            headers: await headersFor(),
            body: JSON.stringify(body),
          });
          if (!res.ok) throw new SubstrateError(res.status, await readText(res));
          const raw: unknown = await res.json();
          return parseForgetResponse(raw);
        },
      };
    },
  };
}

// ─── errors ──────────────────────────────────────────────────────────────────

export class SubstrateError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`substrate error ${status}: ${body}`);
    this.name = 'SubstrateError';
  }
}

export class EnrollError extends SubstrateError {
  constructor(status: number, body: string) {
    super(status, body);
    this.name = 'EnrollError';
  }
}

// ─── parsers ─────────────────────────────────────────────────────────────────

function parseEnrollResponse(body: unknown): EnrollResult {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`enroll: response is not an object (${typeof body})`);
  }
  const b = body as Record<string, unknown>;
  const natsCreds = strField(b, 'nats_creds');
  const natsUrl = strField(b, 'nats_url');
  const workspaceId = strField(b, 'workspace_id');
  const orgId = strField(b, 'org_id');
  const name = strField(b, 'name');
  const expiresAt = typeof b['expires_at'] === 'string' ? b['expires_at'] : undefined;
  return expiresAt !== undefined
    ? { natsCreds, natsUrl, workspaceId, orgId, name, expiresAt }
    : { natsCreds, natsUrl, workspaceId, orgId, name };
}

function parseRememberResponse(body: unknown): RememberResult {
  if (typeof body !== 'object' || body === null) {
    throw new Error('remember: response is not an object');
  }
  const b = body as Record<string, unknown>;
  return {
    blockId: strField(b, 'block_id'),
    storedAt: strField(b, 'stored_at'),
  };
}

function parseQueryHits(body: unknown): readonly QueryHit[] {
  const arr = Array.isArray(body) ? body : (body as { hits?: unknown })?.hits;
  if (!Array.isArray(arr)) {
    throw new Error('query: response has no hits[] array');
  }
  return arr.map((raw, i): QueryHit => {
    if (typeof raw !== 'object' || raw === null) {
      throw new Error(`query: hit #${i} is not an object`);
    }
    const h = raw as Record<string, unknown>;
    return {
      blockId: strField(h, 'block_id'),
      score: typeof h['score'] === 'number' ? h['score'] : 0,
      snippet: typeof h['snippet'] === 'string' ? h['snippet'] : '',
    };
  });
}

function strField(obj: Record<string, unknown>, key: string): string {
  const v = obj[key];
  if (typeof v !== 'string') {
    throw new Error(`expected string at "${key}", got ${typeof v}`);
  }
  return v;
}

function parseShareResponse(raw: unknown): ShareResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('share: response is not an object');
  const b = raw as Record<string, unknown>;
  return { shareId: strField(b, 'share_id'), blockId: strField(b, 'block_id') };
}

function parseListResponse(raw: unknown): ListResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('list: response is not an object');
  const b = raw as Record<string, unknown>;
  return { listingId: strField(b, 'listing_id') };
}

function parsePurchaseResponse(raw: unknown): PurchaseResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('purchase: response is not an object');
  const b = raw as Record<string, unknown>;
  return { blockId: strField(b, 'block_id'), receiptId: strField(b, 'receipt_id') };
}

function parseVerifyResponse(raw: unknown): VerifyResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('verify: response is not an object');
  const b = raw as Record<string, unknown>;
  const blockId = strField(b, 'block_id');
  const signatureValid = typeof b['signature_valid'] === 'boolean' ? b['signature_valid'] : false;
  const attestations = Array.isArray(b['attestations'])
    ? (b['attestations'] as Array<Record<string, unknown>>).map((a) => ({
        attesterId: strField(a, 'attester_id'),
        statement: strField(a, 'statement'),
      }))
    : [];
  return { blockId, signatureValid, attestations };
}

function parseAttestResponse(raw: unknown): AttestResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('attest: response is not an object');
  const b = raw as Record<string, unknown>;
  return { attestationId: strField(b, 'attestation_id') };
}

function parseSubscribeResponse(raw: unknown): SubscribeResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('subscribe: response is not an object');
  const b = raw as Record<string, unknown>;
  return { subscriptionId: strField(b, 'subscription_id') };
}

function parseUpdateResponse(raw: unknown): UpdateResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('update: response is not an object');
  const b = raw as Record<string, unknown>;
  return { blockId: strField(b, 'block_id'), contentHash: strField(b, 'content_hash') };
}

function parseExtractResponse(raw: unknown): ExtractResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('extract: response is not an object');
  const b = raw as Record<string, unknown>;
  const facts = Array.isArray(b['facts'])
    ? (b['facts'] as Array<Record<string, unknown>>)
    : [];
  return { facts };
}

function parseForgetResponse(raw: unknown): ForgetResult {
  if (typeof raw !== 'object' || raw === null) throw new Error('forget: response is not an object');
  const b = raw as Record<string, unknown>;
  return {
    blockId: strField(b, 'block_id'),
    deletedAt: typeof b['deleted_at'] === 'number' ? b['deleted_at'] : 0,
    mode: b['mode'] === 'hard' ? 'hard' : 'soft',
    cascadeCount: typeof b['cascade_count'] === 'number' ? b['cascade_count'] : 0,
    hardDeleteEligibleAt:
      typeof b['hard_delete_eligible_at'] === 'number' ? b['hard_delete_eligible_at'] : null,
  };
}

function rememberBody(input: RememberInput): Record<string, unknown> {
  const out: Record<string, unknown> = { content: input.content };
  if (input.tags !== undefined) out['tags'] = input.tags;
  if (input.parentBlockId !== undefined) out['parent_block_id'] = input.parentBlockId;
  return out;
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

// Re-export so callers don't need to import from persona-store.
export type { PersonaIdentity };
