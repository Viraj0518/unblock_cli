/**
 * HTTP substrate client — minimal POST/GET shim against the auth-issuer
 * and the substrate API.
 *
 * Two separate base URLs because the deployed surface splits them:
 *   - `authUrl` hosts `/v1/identity/enroll` (auth-issuer at auth.kaeva.app
 *     today; will become its own polyrepo's deployed EF).
 *   - `substrateUrl` hosts every substrate verb (remember, query, share,
 *     list, purchase, verify, attest, subscribe, update, extract, forget).
 *     Live target: the Supabase `unblock-api` edge function at
 *     `https://wzqkolqxtmqdptwchrkl.supabase.co/functions/v1/unblock-api`.
 *
 * Iter-3 (2026-05-27) the CLI's substrate calls were 404-ing because they
 * pointed at `authUrl` (which only knows `/v1/identity/enroll`) and used
 * the auth-issuer's `Bearer` header. The substrate EF advertises:
 *   GET  /v1/health
 *   GET  /v1/orgs/me
 *   POST /v1/remember            body: {content}                 -> {block_id, bubble_id, created_at}
 *   POST /v1/query               body: {text, top_k?, ...}       -> {hits: [{block_id, content, score, ...}], answer, abstained, ...}
 * and requires `X-API-Key: unb_<32hex>` (NOT `Authorization: Bearer …`).
 *
 * Endpoints used today:
 *   POST <authUrl>/v1/identity/enroll
 *     headers: X-Invite-Code: <code>
 *     body:    { human_did, ed25519_pubkey_hex, agent_name }
 *     →        { user_jwt, creds_file_content, broker_url, workspace_id,
 *                org_id, role, human_did, expires_at }
 *
 *   POST <substrateUrl>/v1/remember         → { block_id, bubble_id, created_at }  (created_at maps to RememberResult.storedAt)
 *   POST <substrateUrl>/v1/query            → { hits: [{block_id, content, score, ...}], answer, abstained, ... }
 *   …plus the Stage-2 wave-2 verbs (share/list/purchase/etc.) which the EF
 *   has yet to publish; they keep their original 4xx-pass-through behaviour.
 *
 * 2026-05-27 enrollment contract fix: previously the CLI sent the invite
 * code as a JSON body field (`invite_code`) and parsed the response as
 * `{nats_creds, nats_url, name}`. The deployed auth-issuer at
 * auth.kaeva.app (sourced from unblock-v02-mig/services/auth-issuer/src/
 * handlers/identity-enroll.ts, authored 2026-05-18) expects the code as
 * an `X-Invite-Code` header, body `{human_did, ed25519_pubkey_hex,
 * agent_name}`, and returns `{user_jwt, creds_file_content, broker_url, ...,
 * role, human_did}`.
 * The CLI was authored 5 days after the server with stale wire docs and
 * never actually round-tripped against the live surface. See PR description
 * for the full diagnosis. Test pin: tests/sdk/http-substrate.test.ts.
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
/**
 * Live substrate EF. When this changes (multi-tenant per-org deployments,
 * for example), it should move to `resolveConfig` — but a single hardcoded
 * default beats the previous "fall through to authUrl and 404" behaviour
 * which silently broke every substrate verb shipped in the CLI.
 */
export const DEFAULT_SUBSTRATE_URL =
  'https://wzqkolqxtmqdptwchrkl.supabase.co/functions/v1/unblock-api';

export function createHttpSubstrateFactory(
  fetcher: typeof globalThis.fetch = globalThis.fetch,
): SubstrateFactory {
  return {
    create({ authUrl, substrateUrl, token, apiKey }): SubstrateClient {
      const authBase = authUrl.replace(/\/+$/, '');
      const substrateBase = (substrateUrl ?? authUrl).replace(/\/+$/, '');

      const authHeaders = async (): Promise<Record<string, string>> => {
        const h: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json',
        };
        if (token !== undefined) {
          h['authorization'] = `Bearer ${await token()}`;
        }
        return h;
      };

      const substrateHeaders = async (): Promise<Record<string, string>> => {
        const h: Record<string, string> = {
          'content-type': 'application/json',
          accept: 'application/json',
        };
        // Substrate EF wants `X-API-Key: unb_<hex>` — see auth-required
        // middleware in services/edge-functions/unblock-api/src/.
        if (apiKey !== undefined) {
          h['x-api-key'] = await apiKey();
        } else if (token !== undefined) {
          // Fallback: some legacy callers pass a token; let the substrate
          // 401 us rather than silently strip credentials.
          h['authorization'] = `Bearer ${await token()}`;
        }
        return h;
      };

      return {
        async enroll(input): Promise<EnrollResult> {
          // Server contract (unblock-v02-mig/services/auth-issuer/src/handlers/
          // identity-enroll.ts): the invite code is a credential and travels
          // in the X-Invite-Code header, NOT a body field. The body carries
          // only the new member's identity material, including the requested
          // display handle for canonical chat_name derivation.
          const headers = await authHeaders();
          headers['x-invite-code'] = input.inviteCode;
          const res = await fetcher(`${authBase}/v1/identity/enroll`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              human_did: input.identity.did,
              ed25519_pubkey_hex: input.identity.ed25519PublicKeyHex.toLowerCase(),
              agent_name: input.identity.agentName,
            }),
          });
          if (!res.ok) {
            throw new EnrollError(res.status, await readText(res));
          }
          const body: unknown = await res.json();
          return parseEnrollResponse(body, input.identity.agentName);
        },

        async remember(input): Promise<RememberResult> {
          const res = await fetcher(`${substrateBase}/v1/remember`, {
            method: 'POST',
            headers: await substrateHeaders(),
            body: JSON.stringify(rememberBody(input)),
          });
          if (!res.ok) {
            throw new SubstrateError(res.status, await readText(res));
          }
          const body: unknown = await res.json();
          return parseRememberResponse(body);
        },

        async query(q, opts): Promise<readonly QueryHit[]> {
          // Substrate EF: POST /v1/query body={text, top_k?}, NOT GET with
          // query-string. Iter-3 bug was sending GET with `?q=` which the
          // EF's router treated as an unmatched route -> 404.
          const body: Record<string, unknown> = { text: q };
          if (opts?.topK !== undefined) body['top_k'] = opts.topK;
          const res = await fetcher(`${substrateBase}/v1/query`, {
            method: 'POST',
            headers: await substrateHeaders(),
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            throw new SubstrateError(res.status, await readText(res));
          }
          const payload: unknown = await res.json();
          return parseQueryHits(payload);
        },

        async share(input): Promise<ShareResult> {
          const body: Record<string, unknown> = {
            block_id: input.blockId,
            recipient: input.recipient,
          };
          if (input.permissions !== undefined) body['permissions'] = input.permissions;
          if (input.expiresAt !== undefined) body['expires_at'] = input.expiresAt;
          const res = await fetcher(`${substrateBase}/v1/share`, {
            method: 'POST',
            headers: await substrateHeaders(),
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
          const res = await fetcher(`${substrateBase}/v1/list`, {
            method: 'POST',
            headers: await substrateHeaders(),
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
          const res = await fetcher(`${substrateBase}/v1/purchase`, {
            method: 'POST',
            headers: await substrateHeaders(),
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
          const res = await fetcher(`${substrateBase}/v1/verify`, {
            method: 'POST',
            headers: await substrateHeaders(),
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
          const res = await fetcher(`${substrateBase}/v1/attest`, {
            method: 'POST',
            headers: await substrateHeaders(),
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
          const res = await fetcher(`${substrateBase}/v1/subscribe`, {
            method: 'POST',
            headers: await substrateHeaders(),
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
          const res = await fetcher(`${substrateBase}/v1/update`, {
            method: 'POST',
            headers: await substrateHeaders(),
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
          const res = await fetcher(`${substrateBase}/v1/extract`, {
            method: 'POST',
            headers: await substrateHeaders(),
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
          const res = await fetcher(`${substrateBase}/v1/forget`, {
            method: 'POST',
            headers: await substrateHeaders(),
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

/**
 * Parse a `/v1/identity/enroll` response. The deployed auth-issuer returns:
 *
 *   { user_jwt, creds_file_content, broker_url, workspace_id, org_id,
 *     role, human_did, expires_at }
 *
 * Older / mocked servers (and the pre-2026-05-27 CLI's own test fixtures)
 * shipped a different shape: `{nats_creds, nats_url, name}`. We accept
 * BOTH so existing mocks continue to work but the live server is the
 * source of truth.
 *
 * Display handle (`name` on the CLI's `EnrollResult`) is chosen in this
 * order:
 *   1. legacy server `name` field, if present
 *   2. live server `human_did` (DID is the canonical chat handle per
 *      parent CLAUDE.md §"Identity convention")
 *   3. the local persona's `agentName` passed in by the CLI caller
 *
 * `fallbackName` is the local persona's display handle; used only when
 * the server omits both `name` and `human_did` (shouldn't happen on the
 * live deployment but keeps the parser total).
 */
function parseEnrollResponse(body: unknown, fallbackName: string): EnrollResult {
  if (typeof body !== 'object' || body === null) {
    throw new Error(`enroll: response is not an object (${typeof body})`);
  }
  const b = body as Record<string, unknown>;

  // Creds + broker URL: live server uses `creds_file_content` + `broker_url`;
  // older mocks used `nats_creds` + `nats_url`. Prefer live shape.
  const natsCreds =
    typeof b['creds_file_content'] === 'string'
      ? (b['creds_file_content'] as string)
      : typeof b['nats_creds'] === 'string'
        ? (b['nats_creds'] as string)
        : undefined;
  if (natsCreds === undefined) {
    throw new Error(
      'enroll: response missing creds_file_content/nats_creds (got keys: ' +
        Object.keys(b).join(',') +
        ')',
    );
  }
  const natsUrl =
    typeof b['broker_url'] === 'string'
      ? (b['broker_url'] as string)
      : typeof b['nats_url'] === 'string'
        ? (b['nats_url'] as string)
        : undefined;
  if (natsUrl === undefined) {
    throw new Error(
      'enroll: response missing broker_url/nats_url (got keys: ' +
        Object.keys(b).join(',') +
        ')',
    );
  }

  const workspaceId = strField(b, 'workspace_id');
  const orgId = strField(b, 'org_id');

  const name =
    typeof b['name'] === 'string' && b['name'] !== ''
      ? (b['name'] as string)
      : typeof b['human_did'] === 'string' && b['human_did'] !== ''
        ? (b['human_did'] as string)
        : fallbackName;

  const expiresAt = typeof b['expires_at'] === 'string' ? b['expires_at'] : undefined;

  // 2026-05-27 P1 substrate-unreachable fix: the auth-issuer now mints a
  // substrate API key in the same enrollment round-trip. The CLI persists
  // it to comms-v3.env so subsequent substrate verbs auto-load it without
  // requiring a separate `profile add --api-key` step. Optional because
  // older auth-issuer deployments (and the legacy mock shape) omit it.
  // Validate the shape so a non-string / wrong-prefix server bug surfaces
  // here, not as a 401 on the first substrate call.
  const rawApiKey = b['api_key'];
  const apiKey =
    typeof rawApiKey === 'string' && rawApiKey.startsWith('unb_')
      ? rawApiKey
      : undefined;
  const rawApiKeyId = b['api_key_id'];
  const apiKeyId = typeof rawApiKeyId === 'string' ? rawApiKeyId : undefined;

  // Build the result conditionally so we don't violate
  // exactOptionalPropertyTypes (which rejects literal `undefined`
  // for an optional `T` field).
  const out: { -readonly [K in keyof EnrollResult]: EnrollResult[K] } = {
    natsCreds,
    natsUrl,
    workspaceId,
    orgId,
    name,
  };
  if (expiresAt !== undefined) out.expiresAt = expiresAt;
  if (apiKey !== undefined) out.apiKey = apiKey;
  if (apiKeyId !== undefined) out.apiKeyId = apiKeyId;
  return out;
}

function parseRememberResponse(body: unknown): RememberResult {
  if (typeof body !== 'object' || body === null) {
    throw new Error('remember: response is not an object');
  }
  const b = body as Record<string, unknown>;
  // The live substrate EF returns `created_at`; older / mocked servers
  // may emit `stored_at`. Accept either so the CLI works against both.
  const ts = typeof b['stored_at'] === 'string'
    ? (b['stored_at'] as string)
    : typeof b['created_at'] === 'string'
      ? (b['created_at'] as string)
      : undefined;
  if (ts === undefined) {
    throw new Error(
      'remember: response missing stored_at/created_at (got keys: ' +
        Object.keys(b).join(',') +
        ')',
    );
  }
  return {
    blockId: strField(b, 'block_id'),
    storedAt: ts,
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
    // The substrate EF returns `content` (full block content). Older
    // servers / mocks return `snippet`. Prefer snippet if present, else
    // truncate content to a reasonable display width so the one-line
    // output formatter in main.ts doesn't print a 4KB block to stdout.
    const snippet = typeof h['snippet'] === 'string'
      ? (h['snippet'] as string)
      : typeof h['content'] === 'string'
        ? truncateSnippet(h['content'] as string)
        : '';
    return {
      blockId: strField(h, 'block_id'),
      score: typeof h['score'] === 'number' ? h['score'] : 0,
      snippet,
    };
  });
}

function truncateSnippet(s: string, maxLen = 240): string {
  const oneLine = s.replace(/\s+/g, ' ').trim();
  return oneLine.length > maxLen ? `${oneLine.slice(0, maxLen - 1)}…` : oneLine;
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
