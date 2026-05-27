/**
 * SDK boundary — TODO interfaces.
 *
 * The CLI is supposed to depend on `unblock_sdk` for substrate verbs (remember,
 * query, etc.) and on `unblock_comms` for the NATS transport. As of polyrepo
 * Stage 2 neither is implemented yet — both repos exist as scaffolds. This
 * file is the narrow contract this CLI assumes about those SDKs. When
 * `unblock_sdk` v1 ships, swap these interfaces for `import type { ... } from
 * "unblock_sdk"` and delete this file.
 *
 * Why interfaces and not the published SDK today:
 *   - `unblock_sdk` exports a single `Unblock` class with stub methods that
 *     throw "not implemented" — wiring it would not help testing.
 *   - The CLI must be testable today with mocked dependencies (per
 *     AGENTS.md §6, 25-test minimum).
 *
 * The CLI uses dependency injection at every command boundary: each command
 * accepts an `{ comms, substrate }` deps object so tests can substitute
 * fakes. Production wiring resolves these at process startup in
 * `src/main.ts` from the persona store.
 */

import type { PersonaIdentity } from '../auth/persona-store.js';

// ─── Comms — NATS-level surface used by chat/say/dm/ask/reply ────────────────

/**
 * Plain-JSON ops envelope. Wire format matches v02-mig's `_chat_envelope`
 * and scripts/identity/persona_nats.py byte-for-byte (UTF-8 JSON over NATS).
 *
 * Source: ADR-115 §"Team chat (say/ask/dm/chat)".
 */
export interface ChatEnvelope {
  /** "say" | "dm" | "ask" | "reply" | other future kinds */
  readonly kind: string;
  /** persona handle (resolved by resolveName) */
  readonly source: string;
  /** Unix ms when the envelope was built */
  readonly ts: number;
  readonly [key: string]: unknown;
}

/** Subscription handle returned by `subscribe`. */
export interface Subscription {
  readonly [Symbol.asyncIterator]: () => AsyncIterator<{ readonly subject: string; readonly data: Uint8Array }>;
  unsubscribe(): void;
}

/**
 * Comms client — what the CLI needs from NATS. Production impl wraps the
 * `nats` package; tests pass a fake.
 *
 * TODO (Stage 3): replace with `import { CommsClient } from "unblock_sdk"`
 * once `unblock_sdk` exposes a NATS-shaped surface.
 */
export interface CommsClient {
  publish(subject: string, payload: Uint8Array): void;
  subscribe(subject: string): Subscription;
  /** Flush pending publishes. Best-effort. */
  flush(): Promise<void>;
  close(): Promise<void>;
}

/** Factory that opens a connection. Implementations are responsible for auth. */
export interface CommsFactory {
  connect(options: {
    readonly url: string;
    readonly credsPath?: string;
    readonly name?: string;
  }): Promise<CommsClient>;
}

// ─── Substrate — HTTP-level surface used by remember/query/login ─────────────

/** Minimal `remember` shape. Mirrors `unblock_protocol`'s RememberRequest. */
export interface RememberInput {
  readonly content: string;
  readonly tags?: readonly string[];
  readonly parentBlockId?: string;
  /**
   * Provenance + caller-side context. Free-form record persisted to
   * `blocks.metadata JSONB`. Used by the ingest pipeline to attach
   * chunk-level attribution (source_uri, chunk_index, role, session_id,
   * frontmatter_*) so the org-brain can answer "show me what I learned
   * from Tuesday's Claude session". Top-level MUST be an object.
   * See unblock_protocol ADR-0005 / v3.1.1.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface RememberResult {
  readonly blockId: string;
  readonly storedAt: string;
}

export interface QueryHit {
  readonly blockId: string;
  readonly score: number;
  readonly snippet: string;
}

// ─── Verb #3 — Share ─────────────────────────────────────────────────────────

export interface ShareInput {
  readonly blockId: string;
  readonly recipient: string;
  readonly permissions?: readonly string[];
  /** Epoch seconds. */
  readonly expiresAt?: number;
}

export interface ShareResult {
  readonly shareId: string;
  readonly blockId: string;
}

// ─── Verb #4 — List (marketplace) ────────────────────────────────────────────

export interface ListInput {
  readonly blockId: string;
  readonly priceUnblock: number;
  readonly tier?: number;
  readonly royaltyShareWith?: ReadonlyArray<readonly [string, number]>;
  readonly delistExisting?: boolean;
  readonly summary?: string;
}

export interface ListResult {
  readonly listingId: string;
}

// ─── Verb #5 — Purchase ───────────────────────────────────────────────────────

export interface PurchaseInput {
  readonly blockId?: string;
  readonly listingId?: string;
  readonly maxPrice?: number | null;
  readonly paymentMethod?: 'wallet' | 'relay';
  readonly walletName?: string;
}

export interface PurchaseResult {
  readonly blockId: string;
  readonly receiptId: string;
}

// ─── Verb #6 — Verify ─────────────────────────────────────────────────────────

export interface VerifyInput {
  readonly blockId?: string | null;
  readonly contentHash?: string | null;
  readonly signature?: string | null;
}

export interface VerifyResult {
  readonly blockId: string;
  readonly signatureValid: boolean;
  readonly attestations: ReadonlyArray<{ readonly attesterId: string; readonly statement: string }>;
}

// ─── Verb #7 — Attest ─────────────────────────────────────────────────────────

export interface AttestInput {
  readonly blockId: string;
  readonly score: number;
  readonly attestationText?: string;
  readonly signature?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface AttestResult {
  readonly attestationId: string;
}

// ─── Verb #8 — Subscribe ──────────────────────────────────────────────────────

export interface SubscribeInput {
  readonly url: string;
  readonly events: readonly string[];
  readonly secret: string;
  readonly filter?: Readonly<Record<string, unknown>>;
  readonly active?: boolean;
}

export interface SubscribeResult {
  readonly subscriptionId: string;
}

// ─── Verb #9 — Update ─────────────────────────────────────────────────────────

export interface UpdateInput {
  readonly blockId: string;
  readonly content: unknown;
  readonly rejectedAlternatives?: readonly string[];
  readonly revisionReason?: string;
  readonly tags?: readonly string[];
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly clientMsgId?: string;
}

export interface UpdateResult {
  readonly blockId: string;
  readonly contentHash: string;
}

// ─── Verb #10 — Extract ───────────────────────────────────────────────────────

export interface ExtractInput {
  readonly blockId?: string;
  readonly query?: string;
  readonly schema?: Readonly<Record<string, unknown>>;
}

export interface ExtractResult {
  readonly facts: ReadonlyArray<Readonly<Record<string, unknown>>>;
}

// ─── Verb #11 — Forget ────────────────────────────────────────────────────────

export interface ForgetInput {
  readonly blockId: string;
  readonly mode?: 'soft' | 'hard';
  readonly reason?: string;
  readonly gdprRequest?: boolean;
}

export interface ForgetResult {
  readonly blockId: string;
  readonly deletedAt: number;
  readonly mode: 'soft' | 'hard';
  readonly cascadeCount: number;
  readonly hardDeleteEligibleAt: number | null;
}

/**
 * Substrate client — what the CLI needs from the auth-issuer + catalog-api.
 *
 * TODO (Stage 3): replace with `import { Unblock } from "unblock_sdk"` once
 * the SDK implements these.
 */
export interface SubstrateClient {
  remember(input: RememberInput): Promise<RememberResult>;
  query(q: string, opts?: { readonly topK?: number }): Promise<readonly QueryHit[]>;
  share(input: ShareInput): Promise<ShareResult>;
  listMarketplace(input: ListInput): Promise<ListResult>;
  purchase(input: PurchaseInput): Promise<PurchaseResult>;
  verify(input: VerifyInput): Promise<VerifyResult>;
  attest(input: AttestInput): Promise<AttestResult>;
  subscribe(input: SubscribeInput): Promise<SubscribeResult>;
  update(input: UpdateInput): Promise<UpdateResult>;
  extract(input: ExtractInput): Promise<ExtractResult>;
  forget(input: ForgetInput): Promise<ForgetResult>;
  /**
   * Enrollment endpoint — redeem an invite code for a User JWT + NATS creds.
   * Matches v02-mig's POST /v1/identity/enroll.
   */
  enroll(input: {
    readonly inviteCode: string;
    readonly identity: PersonaIdentity;
  }): Promise<EnrollResult>;
}

export interface EnrollResult {
  /** NATS .creds file contents (User JWT + nkey seed, NATS wire format). */
  readonly natsCreds: string;
  /** Broker URL the JWT is bound to. */
  readonly natsUrl: string;
  /** Workspace ID this persona joined. */
  readonly workspaceId: string;
  /** Org ID this persona joined. */
  readonly orgId: string;
  /** Persona's display handle from the JWT. */
  readonly name: string;
  /** ISO timestamp when the JWT expires (optional, server may omit). */
  readonly expiresAt?: string;
}

/** Factory that builds a substrate client bound to an auth-issuer URL. */
export interface SubstrateFactory {
  create(options: { readonly authUrl: string; readonly token?: () => Promise<string> }): SubstrateClient;
}
