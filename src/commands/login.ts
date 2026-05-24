/**
 * `unblock login <invite-code>` — v0.3 enrollment.
 *
 * Flow:
 *   1. Mint a fresh did:key Ed25519 identity (writes ~/.unblock/identity.json).
 *   2. POST <authUrl>/v1/identity/enroll with { invite_code, did, agent_name }.
 *   3. Receive { nats_creds, nats_url, workspace_id, org_id, name, expires_at? }.
 *   4. Write ~/.unblock/comms-v3.creds (chmod 600) + ~/.unblock/comms-v3.env.
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
}

export async function runLogin(deps: LoginDeps, opts: LoginOptions): Promise<LoginResult> {
  const cfg = await resolveConfig(opts);

  // Step 1: identity. Reuse if present (DID is persistent per
  // parent CLAUDE.md §"Identity convention").
  let identity = await readIdentity();
  let mintedNewIdentity = false;
  if (identity === null) {
    const minted = await mintDidKey();
    identity = {
      did: minted.did,
      agentName: opts.agentName?.trim() !== undefined && opts.agentName.trim() !== ''
        ? opts.agentName.trim()
        : shortenDid(minted.did),
      ed25519PublicKeyHex: minted.publicKeyHex,
      createdAt: (deps.nowIso ?? defaultNowIso)(),
    };
    await writeIdentity(identity);
    mintedNewIdentity = true;
  } else if (opts.agentName !== undefined && opts.agentName.trim() !== '') {
    // Caller wants to update the display handle without re-minting the DID.
    const renamed: PersonaIdentity = { ...identity, agentName: opts.agentName.trim() };
    await writeIdentity(renamed);
    identity = renamed;
  }

  // Step 2: POST /v1/identity/enroll
  const substrate = deps.substrateFactory.create({ authUrl: cfg.authUrl });
  const enrolled = await substrate.enroll({ inviteCode: opts.inviteCode, identity });

  // Step 3: persist creds + env
  const credsPath = await writeCommsCreds(enrolled.natsCreds);
  await writeCommsEnv({
    natsUrl: enrolled.natsUrl,
    credsPath,
    workspaceId: enrolled.workspaceId,
    orgId: enrolled.orgId,
    chatName: enrolled.name,
    ...(enrolled.expiresAt !== undefined ? { expiresAt: enrolled.expiresAt } : {}),
  });

  return {
    did: identity.did,
    orgId: enrolled.orgId,
    workspaceId: enrolled.workspaceId,
    chatName: enrolled.name,
    broker: enrolled.natsUrl,
    ...(enrolled.expiresAt !== undefined ? { expiresAt: enrolled.expiresAt } : {}),
    mintedNewIdentity,
  };
}

function defaultNowIso(): string {
  return new Date().toISOString();
}
