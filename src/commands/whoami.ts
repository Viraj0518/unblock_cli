/**
 * `unblock whoami` — print persona identity + comms config.
 *
 * Surfaces:
 *   - did:key:z6Mk... (short form)
 *   - persona handle
 *   - broker URL
 *   - workspace_id, org_id
 *   - JWT expiry (if available from the .creds file)
 *
 * Exit codes:
 *   0   logged in (identity + comms-v3.env both present)
 *   1   not logged in (or files corrupt)
 */

import { readCommsEnv, readCommsCreds, readIdentity } from '../auth/persona-store.js';
import { shortenDid } from '../auth/did.js';
import { decodeCreds } from '../auth/jwt.js';

export interface WhoamiResult {
  readonly loggedIn: boolean;
  readonly did?: string;
  readonly didShort?: string;
  readonly agentName?: string;
  readonly chatName?: string;
  readonly broker?: string;
  readonly workspaceId?: string;
  readonly orgId?: string;
  readonly jwtExpiresAt?: string;
  readonly jwtExpiresInSeconds?: number;
  /** Lines suitable for printing to stdout. */
  readonly lines: readonly string[];
}

export async function runWhoami(): Promise<WhoamiResult> {
  const identity = await readIdentity();
  const env = await readCommsEnv();
  const creds = await readCommsCreds();
  const claims = creds !== null ? decodeCreds(creds) : null;

  if (identity === null && env === null) {
    return {
      loggedIn: false,
      lines: [
        'not logged in',
        'run `unblock login <invite-code>` to enroll a persona',
      ],
    };
  }

  const expiresAt = claims?.exp !== undefined
    ? new Date(claims.exp * 1000).toISOString()
    : env?.expiresAt;
  const expiresInSeconds = secondsUntil(expiresAt);

  const lines: string[] = [];
  if (identity !== null) {
    lines.push(`did:        ${identity.did}`);
    lines.push(`handle:     ${identity.agentName}`);
  }
  if (env !== null) {
    lines.push(`chat name:  ${env.chatName}`);
    lines.push(`broker:     ${env.natsUrl}`);
    lines.push(`workspace:  ${env.workspaceId}`);
    lines.push(`org:        ${env.orgId}`);
    if (expiresAt !== undefined) lines.push(`jwt expiry: ${expiresAt}`);
  } else {
    lines.push('comms-v3.env missing — run `unblock login <invite-code>`');
  }

  const result: WhoamiResult = {
    loggedIn: identity !== null && env !== null,
    ...(identity !== null ? { did: identity.did, didShort: shortenDid(identity.did), agentName: identity.agentName } : {}),
    ...(env !== null
      ? { chatName: env.chatName, broker: env.natsUrl, workspaceId: env.workspaceId, orgId: env.orgId }
      : {}),
    ...(expiresAt !== undefined ? { jwtExpiresAt: expiresAt } : {}),
    ...(expiresInSeconds !== undefined ? { jwtExpiresInSeconds: expiresInSeconds } : {}),
    lines,
  };
  return result;
}

function secondsUntil(iso: string | undefined): number | undefined {
  if (iso === undefined) return undefined;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return undefined;
  return Math.max(0, Math.floor((ms - Date.now()) / 1000));
}
