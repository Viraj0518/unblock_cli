/**
 * Runtime config — resolves persona + comms env into a runnable context.
 *
 * The CLI reads from three sources, in priority order:
 *   1. Process env (`UNBLOCK_NATS_URL`, `UNBLOCK_AUTH_URL`, etc.)
 *   2. `~/.unblock/comms-v3.env` (written by `unblock login`)
 *   3. CLI flag overrides (`--nats-url`, `--auth-url`)
 *
 * Per AGENTS.md §3: no `process.env.X ?? <default>` in source. Defaults
 * live as named constants here, and consumers receive a resolved value, not
 * a fallback chain inline.
 */

import { readCommsEnv, type CommsEnv } from './auth/persona-store.js';
import { DEFAULT_AUTH_URL, DEFAULT_SUBSTRATE_URL } from './sdk/http-substrate.js';

export const DEFAULT_BROKER_URL = 'tls://nats.kaeva.app:39899';

export interface ResolvedConfig {
  /** NATS broker URL. */
  readonly natsUrl: string;
  /** auth-issuer URL (used for `/v1/identity/enroll`). */
  readonly authUrl: string;
  /** Substrate API URL (used for `/v1/remember`, `/v1/query`, …). */
  readonly substrateUrl: string;
  /** API key for substrate auth (`unb_<32hex>`); undefined if no profile set. */
  readonly apiKey: string | undefined;
  /** Path to comms-v3.creds, if a persona is logged in. */
  readonly credsPath: string | undefined;
  /** Workspace ID for chat subject scoping. */
  readonly workspaceId: string;
  /** Display handle for the persona (envelope.source). */
  readonly chatName: string | undefined;
  /** Org ID this persona joined. */
  readonly orgId: string | undefined;
  /** True if `unblock login` has populated comms-v3.env. */
  readonly loggedIn: boolean;
}

export interface ConfigOverrides {
  readonly natsUrl?: string;
  readonly authUrl?: string;
  readonly substrateUrl?: string;
  readonly apiKey?: string;
  readonly name?: string;
  readonly workspaceId?: string;
}

/**
 * Resolve runtime config. Caller passes any CLI-flag overrides; this fn
 * layers them on top of env vars and the persona store.
 *
 * Substrate URL + API key priority:
 *   1. Explicit CLI flag / programmatic override (`--substrate-url`, deps.apiKey)
 *   2. `UNBLOCK_SUBSTRATE_URL` / `UNBLOCK_API_KEY` env
 *   3. Built-in default (DEFAULT_SUBSTRATE_URL); apiKey stays undefined so
 *      substrate calls cleanly 401 with a helpful error rather than hanging.
 *
 * Active-profile lookup is handled by main.ts before it calls into this
 * function — keeping that I/O at the boundary makes resolveConfig pure
 * w.r.t. the filesystem profile registry.
 */
export async function resolveConfig(overrides: ConfigOverrides = {}): Promise<ResolvedConfig> {
  const env: CommsEnv | null = await readCommsEnv();

  const natsUrl =
    pickStr(overrides.natsUrl) ??
    pickStr(process.env['UNBLOCK_NATS_URL']) ??
    env?.natsUrl ??
    DEFAULT_BROKER_URL;

  const authUrl =
    pickStr(overrides.authUrl) ?? pickStr(process.env['UNBLOCK_AUTH_URL']) ?? DEFAULT_AUTH_URL;

  const substrateUrl =
    pickStr(overrides.substrateUrl) ??
    pickStr(process.env['UNBLOCK_SUBSTRATE_URL']) ??
    DEFAULT_SUBSTRATE_URL;

  const apiKey = pickStr(overrides.apiKey) ?? pickStr(process.env['UNBLOCK_API_KEY']);

  const workspaceId =
    pickStr(overrides.workspaceId) ??
    pickStr(process.env['UNBLOCK_WORKSPACE_ID']) ??
    env?.workspaceId ??
    'default';

  const chatName =
    pickStr(overrides.name) ?? pickStr(process.env['UNBLOCK_CHAT_NAME']) ?? env?.chatName;

  return {
    natsUrl,
    authUrl,
    substrateUrl,
    apiKey,
    credsPath: env?.credsPath,
    workspaceId,
    chatName,
    orgId: env?.orgId,
    loggedIn: env !== null,
  };
}

function pickStr(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}
