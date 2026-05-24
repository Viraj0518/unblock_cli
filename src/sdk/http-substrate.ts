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
  EnrollResult,
  QueryHit,
  RememberInput,
  RememberResult,
  SubstrateClient,
  SubstrateFactory,
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
