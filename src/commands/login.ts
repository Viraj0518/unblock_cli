/**
 * `unblock login <invite-code>` — v0.3 enrollment.
 *
 * Flow:
 *   1. Mint a fresh did:key Ed25519 identity (writes ~/.unblock/identity.json).
 *   2. POST <authUrl>/v1/identity/enroll
 *        headers: X-Invite-Code: <code>
 *        body:    { human_did, ed25519_pubkey_hex, agent_name }
 *   3. Receive { user_jwt, creds_file_content, broker_url, workspace_id,
 *               org_id, role, human_did, expires_at, api_key, api_key_id }.
 *   4. Write ~/.unblock/comms-v3.creds (chmod 600) + ~/.unblock/comms-v3.env
 *      (the env file now also carries UNBLOCK_API_KEY when the server
 *      mints one — P1 substrate-unreachable fix · 2026-05-27).
 *
 * Idempotent on identity: if a persona identity already exists locally we
 * reuse it (re-enroll with the same DID — server may reject or upsert).
 *
 * Refs: parent CLAUDE.md §"One-time bootstrap per persona", ADR-116 Wave 3F-2.
 */

import {
  mintDidKey,
  shortenDid,
} from '../auth/did.js';
import {
  readIdentity,
  writeCommsCreds,
  writeCommsEnv,
  writeIdentity,
  type PersonaIdentity,
} from '../auth/persona-store.js';
import { normalizeChatName } from '../comms/wire.js';
import type { SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

export interface LoginDeps {
  readonly substrateFactory: SubstrateFactory;
  /** Default to ISO now; injectable for test determinism. */
  readonly nowIso?: () => string;
}

export interface LoginOptions extends ConfigOverrides {
  readonly inviteCode: string;
  /** Override the agent name. Defaults to the DID's short form. */
  readonly agentName?: string;
}

export interface LoginResult {
  readonly did: string;
  readonly orgId: string;
  readonly workspaceId: string;
  readonly chatName: string;
  readonly broker: string;
  readonly expiresAt?: string;
  /** True if a new identity was minted (vs reused). */
  readonly mintedNewIdentity: boolean;
  /**
   * True if the auth-issuer minted a substrate API key in this enrollment
   * round-trip (P1 substrate-unreachable fix · 2026-05-27). When true, the
   * key has been written to `comms-v3.env` and substrate verbs will
   * auto-authenticate. When false, the deployed auth-issuer predates the
   * fix and the user still needs `unblock profile add --api-key …`.
   */
  readonly apiKeyMinted: boolean;
  /** Audit-only ID of the api_keys row (`akey_enroll_<16hex>`), when present. */
  readonly apiKeyId?: string;
}

export async function runLogin(deps: LoginDeps, opts: LoginOptions): Promise<LoginResult> {
  const cfg = await resolveConfig(opts);
  const requestedAgentName =
    opts.agentName !== undefined && opts.agentName.trim() !== ''
      ? opts.agentName.trim()
      : null;

  // Step 1: identity. Reuse if present (DID is persistent per
  // parent CLAUDE.md §"Identity convention").
  let identity = await readIdentity();
  let mintedNewIdentity = false;
  // Track the previously-stored handle so we can detect a true rename
  // (issue #14): when --agent-name differs from what's on disk, the user
  // wants the new handle to take effect on the wire, not just in
  // identity.json.
  const priorAgentName: string | null = identity?.agentName ?? null;
  if (identity === null) {
    const minted = await mintDidKey();
    identity = {
      did: minted.did,
      agentName: requestedAgentName ?? shortenDid(minted.did),
      ed25519PublicKeyHex: minted.publicKeyHex,
      createdAt: (deps.nowIso ?? defaultNowIso)(),
    };
    await writeIdentity(identity);
    mintedNewIdentity = true;
  } else if (requestedAgentName !== null) {
    // Caller wants to update the display handle without re-minting the DID.
    const renamed: PersonaIdentity = { ...identity, agentName: requestedAgentName };
    await writeIdentity(renamed);
    identity = renamed;
  }

  // Step 2: POST /v1/identity/enroll
  const substrate = deps.substrateFactory.create({ authUrl: cfg.authUrl });
  const enrolled = await substrate.enroll({ inviteCode: opts.inviteCode, identity });

  // Step 3: pick the chat_name we'll actually publish.
  //
  // Issues #14/#140: when the user passes `--agent-name X`, X is the canonical
  // chat_name for both re-login renames and fresh enrolls. The server should
  // agree once it receives `agent_name`, but keep the client-side guard because
  // older/bad enroll responses can still return a stale DID-short handle.
  //
  // Single client-side fix point: lowercase X via the same `normalizeChatName`
  // helper the wire layer uses for DM subjects, then override the value we
  // write to `comms-v3.env`. This matches the `canonicalChatName()` logic in
  // the auth-issuer (services/auth-issuer, PR #328) so the same string lands
  // on both sides of the wire without a new round-trip or endpoint.
  //
  // Edge cases:
  //   * --agent-name not passed -> no override (standard reconnect flow keeps
  //     the server-supplied value).
  //   * --agent-name passed but normalizes to the server value -> no-op.
  //   * --agent-name passed for fresh enroll or true rename -> override.
  const desiredChatName = normalizeChatName(identity.agentName);
  let chatName = enrolled.name;
  const shouldHonorRequestedAgentName =
    requestedAgentName !== null &&
    (mintedNewIdentity || (priorAgentName !== null && requestedAgentName !== priorAgentName));
  if (shouldHonorRequestedAgentName && desiredChatName !== enrolled.name) {
    const reason = mintedNewIdentity
      ? `(client-side override; fresh enroll used --agent-name "${identity.agentName}")`
      : `(client-side override; --agent-name changed from "${priorAgentName}" to "${identity.agentName}")`;
    process.stderr.write(`chat_name updated: ${enrolled.name} -> ${desiredChatName} ${reason}\n`);
    chatName = desiredChatName;
  }

  // Step 4: persist creds + env.
  //
  // The substrate API key (P1 fix · 2026-05-27) flows through here on
  // every enroll: server mints `unb_<hex>` and we persist it next to
  // the NATS creds (same comms-v3.env file, mode 600). Subsequent
  // substrate verbs auto-load it via `resolveConfig`. When the server
  // omits the field (older deployments) the writeCommsEnv call skips
  // the UNBLOCK_API_KEY line — no breakage, just no auto-auth.
  const credsPath = await writeCommsCreds(enrolled.natsCreds);
  await writeCommsEnv({
    natsUrl: enrolled.natsUrl,
    credsPath,
    workspaceId: enrolled.workspaceId,
    orgId: enrolled.orgId,
    chatName,
    ...(enrolled.expiresAt !== undefined ? { expiresAt: enrolled.expiresAt } : {}),
    ...(enrolled.apiKey !== undefined ? { apiKey: enrolled.apiKey } : {}),
  });

  return {
    did: identity.did,
    orgId: enrolled.orgId,
    workspaceId: enrolled.workspaceId,
    chatName,
    broker: enrolled.natsUrl,
    ...(enrolled.expiresAt !== undefined ? { expiresAt: enrolled.expiresAt } : {}),
    apiKeyMinted: enrolled.apiKey !== undefined,
    ...(enrolled.apiKeyId !== undefined ? { apiKeyId: enrolled.apiKeyId } : {}),
    mintedNewIdentity,
  };
}

function defaultNowIso(): string {
  return new Date().toISOString();
}
