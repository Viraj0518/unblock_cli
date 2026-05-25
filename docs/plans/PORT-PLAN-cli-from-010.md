# PORT-PLAN — `unblock_cli` from UNBLOCK_0.1.0

Status: **DRAFT** · Author: Viraj-Alpha · 2026-05-24 · Branch: `port/v1-cli-wave-1-profile-tracer`

> SA pushback (earlier session) recommended **option B = split scope**: keep this polyrepo
> comms-first ("`unblock` bin = thin SDK wrapper + TTY REPL", per CLAUDE.md §"What this
> polyrepo is"), and create a sibling polyrepo `unblock_capture_cli` for the kitchen-sink
> commands (capture daemon, IDE setup, conversation import, device, collab, dev scaffolder,
> generated API). Viraj endorsed B. This plan operationalizes that split.

## Diagram

```
+---------------------------+        +---------------------------------+
| unblock_cli  (THIS REPO)  |        | unblock_capture_cli  (NEW SIB)  |
|                           |        |                                 |
| comms : chat say dm ask   |        | capture : install uninstall ... |
| auth  : login logout      |        | setup   : 1-line install        |
|         whoami            |        | import  : provider walk-in      |
| subst.: remember query    |        | device  : register list revoke  |
|         ingest eval       |        | collab  : propose claim ...     |
| dual-runtime ok (no       |        | dev     : new-verb scaffolder   |
|  node:* without gating)   |        | api     : generated <ef> <op>   |
| @noble crypto / no chalk  |        | quota   : show                  |
|                           |        | NODE-ONLY ok · heavy deps ok    |
| PORT TARGETS (this plan)  |        | (Windows scheduled tasks,       |
| + profile  (W1, tracer)   |        |  SQLite, ~/.claude/settings,    |
| + key      (W2)           |        |  IDE config writers, etc.)      |
| + health/status/watch/    |        |                                 |
|   flush   (W3)            |        | OUT OF SCOPE for this PR.       |
| + message send/inbox/ack  |        | Tracked as separate plan in     |
|   (W4)                    |        | the new repo when scaffolded.   |
+---------------------------+        +---------------------------------+
            |                                        |
            +-------> unblock_sdk (TS+Py) <----------+
                       (every verb dispatches)
            +-------> @unblock/protocol (shared types)
            +-------> unblock_macaroons (W2 prereq, not yet a polyrepo)
            +-------> unblock_protocol/contracts/openapi/aggregate.json
                      (prereq for any `api <ef> <op>` cmd)
```

---

## 1. Source inventory — 13 0.1.0 commands, 33 subcommands, 5,902 LOC

Source root: `C:\Users\12066\unblock-v02-mig\packages\unblock-cli\src\commands\`

| Command       | LOC   | Subcommands                                                                                                        | Domain           |
| ------------- | ----- | ------------------------------------------------------------------------------------------------------------------ | ---------------- |
| capture.ts    | 484   | install · uninstall · status · run                                                                                 | device-daemon    |
| chat.ts       | 1,004 | (1 verb — fancy REPL atop v1-chat.ts; already covered by our `chat`)                                               | comms            |
| collab.ts     | 466   | propose · claim · release · complete · block · unblock · vote                                                      | collab (mutate)  |
| dev.ts        | 94    | new-verb (delegates to scaffolder/run.ts)                                                                          | dev-tooling      |
| device.ts     | 325   | register · list · revoke · whoami                                                                                  | identity         |
| health.ts     | 177   | (1 verb)                                                                                                           | health           |
| import.ts     | 378   | (1 verb · walks providers · prompts UI)                                                                            | bulk-ingest      |
| key.ts        | 130   | set · show · rotate                                                                                                | auth             |
| message.ts    | 237   | send · inbox · ack                                                                                                 | comms (substrate) |
| org.ts        | 579   | org-init · org-invite                                                                                              | admin bootstrap  |
| profile.ts    | 487   | add · list · use · rm                                                                                              | multi-tenancy    |
| quota.ts      | 148   | show                                                                                                               | observability    |
| setup.ts      | 581   | (1 verb · multi-IDE wire · backup/rollback)                                                                        | install          |
| v1-chat.ts    | 104   | (sub-engine for chat.ts — already covered by our `chat`)                                                           | comms            |
| view.ts       | 336   | list · get · list-blocks · list-votes                                                                              | collab (read)    |
| wedge.ts      | 372   | (capture-source enable/list · claude/codex/cursor scaffolders · hooks scaffold)                                    | capture-config   |
| **TOTAL**     | **5,902** | **33 subcommands across 13 top-level command groups**                                                          |                  |

Plus generated `api <ef> <op>` (auto-generated from `contracts/openapi/aggregate.json`,
not in the LOC count) and a `verbs list` introspector.

**Heavy-dep footprint** (NODE-ONLY): `better-sqlite3` (native binding), `@iarna/toml`,
`jsonc-parser`, `ora`, `prompts`, `chalk`, `@unblock/macaroons` (workspace dep, not yet
polyrepo-ified). `node:child_process`, `node:fs`, `node:os`, `node:path` are pervasive.

---

## 2. Target contract — quoting the guardrails

### CLAUDE.md §"What this polyrepo is"

> The `unblock` bin. Exposes verbs to humans and AI personas: `chat`, `say`, `dm`,
> `ask`, `remember`, `query`, `login`, `whoami`. **Thin wrapper over `unblock_sdk`
> plus a TTY REPL.**

### CLAUDE.md §"Runtime targets"

> **Node 22 (only).** The bin runs as a process with TTY access; edge is not a
> runtime target.

### AGENTS.md §3 (boundary contract, enforced by `scripts/check-boundaries.mjs`)

| Rule | Why |
| ---- | --- |
| No imports from any path containing `_shared/` | Cross-package leakage — siblings vendor what they need under `src/`. |
| No imports from `@unblock/<other-pkg>` deep paths | This package is standalone; sibling packages are vendored, not referenced. Only exception: `@unblock/protocol` (shared types/schemas). |
| No `process.env.X ?? <default>` in source | Config is a **required constructor arg**, not a silent env fallback. Tests are exempt. |
| No implicit `Buffer` / `process` globals | Use `import { Buffer } from "node:buffer"` so the module runs under Supabase Edge / Deno. |
| No `as never` / `as unknown as X` / `@ts-ignore` | Honest TS — match the actual shape (per `feedback_honest_typescript_fixes`). |

### AGENTS.md §7 (cross-runtime parity)

> Runtime targets: **dual** (node + edge). Every test under `tests/**/*.test.ts`
> must run under both vitest projects. ... Crypto: use `@noble/curves` / `@noble/hashes`.
> ... Fetch: inject a `fetcher` arg defaulting to `globalThis.fetch`; never import
> `node-fetch`.

### AGENTS.md §2 (reuse > rebuild)

> Use `commander` or `citty` for arg parsing, `prompts` for REPL UX, `kleur` for
> color (**NO chalk** — too heavy).

### Contract conflicts to resolve in this plan

1. **CLAUDE.md says node-only; AGENTS.md §7 says dual-runtime.**
   - The current src tree (no `node:fs`/`node:child_process`/`better-sqlite3`) shows
     the operating reality is dual-runtime-shaped (modulo `node:url`, `node:process`
     in `main.ts`, which are gated to the bin entry). This plan **follows AGENTS.md
     §7 dual-runtime** for every new module (profile / key / health / message), because
     (a) the boundary script enforces it, and (b) the SDK is dual-runtime, so the CLI
     stays dual-runtime by parsimony. The `main.ts` bin wrapper stays node-gated as it
     already is. **CLAUDE.md §"Runtime targets" will be amended in a follow-up commit**
     to read "dual: node bin + edge library."
2. **package.json depends on `chalk` (banned by AGENTS.md §2).** Replace with `kleur`
     in W1 (cheap; chalk has zero use sites in current src, only in 0.1.0 source we
     are porting). Tracked as a soft prerequisite in §6.
3. **0.1.0 commands free-use `chalk`, `ora`, `prompts`, `node:fs`, `node:child_process`,
   `chmod 0o600`.** Each ported command MUST replace these per AGENTS.md §7 — see the
   per-wave "boundary adjustments" notes below.

---

## 3. Scope-split decision (option B)

### `unblock_cli` (THIS repo) = comms + thin SDK wrapper

**KEEP (already ported, 11 commands · main branch at 87d59e3):**
chat · say · dm · ask · login · logout · whoami · remember · query · ingest · eval

**ADD (this plan · 4 waves · ~14 new subcommands):**

| Wave | Command   | Subcommands                       | LOC est. | Tests est. |
| ---- | --------- | --------------------------------- | -------- | ---------- |
| W1   | profile   | add · list · use · rm             | ~200     | ~10        |
| W2   | key       | set · show · rotate               | ~120     | ~8         |
| W3   | health/status/watch/flush | (1+1+1+1)         | ~250     | ~12        |
| W4   | message   | send · inbox · ack                | ~180     | ~10        |
| **Total post-port: 25 commands · ~750 LOC added · ~40 tests added**                |

Result: `unblock_cli` covers comms (firehose + DM + ask + chat REPL), auth (login/logout/
whoami + key + profile), substrate (remember/query/ingest/eval), inter-agent message
(send/inbox/ack), and operator health (health/status/watch/flush). Total surface ~25
subcommands · all dual-runtime · no chalk · no native binaries · stays "thin wrapper +
TTY REPL" per CLAUDE.md scope.

### `unblock_capture_cli` (NEW sibling polyrepo — NOT created in this PR)

**Proposed `bin`: `unblock-capture`** (or `unblock-dogfood`, deferred to repo-creation
time).

**Lands the kitchen-sink (node-only OK · heavy deps OK):**

| Group   | Subcommands                                                                  |
| ------- | ---------------------------------------------------------------------------- |
| capture | install · uninstall · status · run                                           |
| setup   | (1 verb · multi-IDE wire)                                                    |
| import  | (1 verb · provider walk-in)                                                  |
| device  | register · list · revoke · whoami                                            |
| collab  | propose · claim · release · complete · block · unblock · vote                |
| view    | list · get · list-blocks · list-votes                                        |
| dev     | new-verb (scaffolder)                                                        |
| verbs   | list (introspector)                                                          |
| api     | `<ef> <op>` (generated from aggregate.json)                                  |
| quota   | show                                                                         |
| wedge   | (capture-source enable/list · IDE-hook scaffolders)                          |
| org     | org-init · org-invite (admin one-shot — sibling lives here, NOT comms-CLI)   |

Reason: every command in this column either (a) requires `node:child_process` for
PowerShell / scheduled-task XML / IDE config edits, (b) requires native bindings
(`better-sqlite3` for import progress), (c) is operator/admin one-shot tooling that
day-to-day comms users don't need, or (d) depends on `aggregate.json` baked from
`unblock_protocol` (not shipped yet).

### Why this split holds up against the org-brain thesis

The org-brain (parent CLAUDE.md) is constituted by:

- members (humans + agents · login/logout/whoami/profile/key — `unblock_cli`)
- neurons firing (chat/say/dm/ask/message — `unblock_cli`)
- the cortex (remember/query/ingest/eval — `unblock_cli`)
- the periphery (capture daemon, import, IDE setup, dev scaffolder, collab,
  quota — `unblock_capture_cli`)

Every member's terminal needs `unblock_cli`. Only operators / dogfood installers /
agent developers need `unblock_capture_cli`. Splitting cuts the comms-CLI install
footprint by ~5,200 LOC and the dep weight from {chalk + ora + prompts + better-sqlite3
+ @iarna/toml + jsonc-parser} down to {commander + prompts (for REPL only) + nats
(optional)}. That preserves the brain's ergonomics: someone joining a workspace
gets the comms surface in 200ms cold-start, not 8s.

---

## 4. Conflict matrix — where each 0.1.0 command lands

| 0.1.0 cmd          | Subs            | Lands in          | Why                                                                       |
| ------------------ | --------------- | ----------------- | ------------------------------------------------------------------------- |
| chat               | 1               | unblock_cli       | already ported (TTY REPL is core scope)                                   |
| v1-chat            | (engine)        | unblock_cli       | already ported (the chat impl)                                            |
| profile            | add list use rm | **unblock_cli**   | multi-tenancy = per-persona; needed by chat/login/whoami                  |
| key                | set show rotate | **unblock_cli**   | auth = core scope; SDK needs the key on every HTTP call                   |
| health             | 1               | **unblock_cli**   | comms-substrate ping; replaces probe — fits "thin wrapper"                |
| message            | send inbox ack  | **unblock_cli**   | already-wired SDK calls; just adds command surface                        |
| capture            | install uninstall status run | unblock_capture_cli | node:child_process for PowerShell scheduled-task XML  |
| setup              | 1               | unblock_capture_cli | multi-IDE config writer; writes ~/.claude/settings.json etc.            |
| import             | 1               | unblock_capture_cli | walks SQLite DBs from Claude/Codex/Cursor; native binding              |
| device             | register list revoke whoami | unblock_capture_cli | per-device credential lifecycle, not per-persona      |
| collab             | propose claim release complete block unblock vote | unblock_capture_cli | mutating substrate; not on hot path for chat users |
| view               | list get list-blocks list-votes | unblock_capture_cli | read-side of collab; pairs with collab in same repo  |
| dev                | new-verb        | unblock_capture_cli | scaffolder for verb development; not end-user surface                  |
| verbs              | list            | unblock_capture_cli | introspector over generated aggregate.json                              |
| api                | `<ef> <op>`     | unblock_capture_cli | generated client; needs aggregate.json in dist (unblock_protocol dep)   |
| quota              | show            | unblock_capture_cli | operator/admin surface; not member-daily-driver                         |
| wedge              | enable list (+ scaffolders) | unblock_capture_cli | capture-source config + IDE-hook scaffolding         |
| org                | org-init org-invite | unblock_capture_cli | admin one-shot bootstrap; uses BOOTSTRAP_SECRET                     |

`whoami` is dual: `unblock whoami` (persona, already in `unblock_cli`) and
`unblock device whoami` (device, lives in `unblock_capture_cli`). Both legitimate;
different objects.

---

## 5. Wave decomposition (for `unblock_cli` ONLY)

### W1 — `profile` (tracer · **THIS PR**)

- **Branch:** `port/v1-cli-wave-1-profile-tracer`
- **Scope:** `profile add <name>` · `profile list` · `profile use <name>` · `profile rm <name>`
- **Source:** `unblock-v02-mig/packages/unblock-cli/src/commands/profile.ts` (487 LOC)
- **Ported size:** ~200 LOC (most of the 487 is API-key minting, secure-file dance,
  `chalk` formatting, and the registry CAS — kept · simplified · de-chalk'd)
- **Deps used:** only `node:fs/promises` (already in repo via `persona-store.ts`),
  `node:path`, `node:os`, `node:crypto.randomUUID`. **No** chalk, ora, prompts, better-sqlite3.
- **Surface adds:** four subcommands under `unblock profile`. `src/index.ts` adds no
  new public exports (CLI is bin-shaped, surface is empty).
- **SDK touch:** none. Profile is purely local registry; SDK config resolution
  reads from it at session-time in W3 (not in this PR).
- **Boundary adjustments:**
  - Replace `chalk.red/green/yellow/bold/dim` with `kleur` (lighter; AGENTS.md §2)
    or, simpler still, plain ANSI escape constants in `src/output/ansi.ts` (0 deps).
    **Decision:** drop color entirely from profile output. The CLI's existing output
    is plain text (see `src/commands/whoami.ts`, `login.ts`). Stay consistent.
  - Replace `chalk.dim(...)` with plain `process.stdout.write(...)`.
  - Replace `import { isValidApiKey, generatePlaceholderKey } from "../util/probe.js"`
    with a local validator (3 lines). API-key probe lives in W2/W3 (`key` cmd).
  - Replace `import { writePrivateKeyFile } from "../util/secure-file.js"` with a
    direct `fs.writeFile(p, body, { mode: 0o600 })` (Windows chmod is a no-op anyway,
    matches what `persona-store.writeIdentity` already does).
  - Hoist `unblockHome()` from `src/auth/persona-store.ts` (already exported, honors
    `UNBLOCK_HOME` env override for test isolation).

### W2 — `key set/show/rotate`

- **Branch:** `port/v1-cli-wave-2-key`
- **Source:** `unblock-v02-mig/packages/unblock-cli/src/commands/key.ts` (130 LOC)
- **Ported size:** ~120 LOC
- **Prereq:** decide whether `unblock_macaroons` polyrepo ships before this wave.
  - If YES: `unblock key rotate` calls `unblock_macaroons.mintFromBootstrap(...)`
    rather than printing a placeholder warning.
  - If NO: ship parity-with-0.1.0 (placeholder + curl hint). Flag in PR description.
- **Boundary adjustments:** same de-chalk pattern as W1; `node:fs.copyFile` for the
  `.bak` archive is allowed (already used in `persona-store.wipePersonaStore`).
- **SDK touch:** `unblock_sdk` already reads `~/.unblock/api_key` (legacy) and
  `~/.unblock/comms-v3.env` (modern). No change.

### W3 — `health` · `status` · `watch` · `flush`

- **Branch:** `port/v1-cli-wave-3-substrate-ops`
- **Sources:**
  - `health.ts` (177 LOC, 0.1.0)
  - `status` + `watch` + `flush` are **new** to this polyrepo; 0.1.0 doesn't have
    them as standalone — they're folded into `chat` (firehose tail) and `capture
    status`. We split them out as first-class verbs because the comms CLI needs
    them and they don't fit the capture-CLI.
- **Ported size:** ~250 LOC across four files.
- **Prereq:** the SDK exposes (or we add) `sdk.health()`, `sdk.status()`,
  `sdk.watch()`, `sdk.flush()`. If absent, this wave starts with an SDK PR.
- **Boundary adjustments:** drop `ora` (spinner). Print a single status line, flush
  on completion. Drop chalk. Use injected fetcher per AGENTS.md §7.

### W4 — `message send/inbox/ack`

- **Branch:** `port/v1-cli-wave-4-message`
- **Source:** `unblock-v02-mig/packages/unblock-cli/src/commands/message.ts` (237 LOC)
- **Ported size:** ~180 LOC
- **Prereq:** SDK exposes `sdk.message.send/inbox/ack`. Check before starting.
  - Note: this wave duplicates the *substrate* `/message/inbox/ack` REST surface
    onto the CLI. NATS comms (`say`/`dm`/`ask`) is the **hot path**; substrate
    `message` is the **archival path** (per `~/.claude-comms` archival memory).
    Ship for completeness; document the divergence.
- **Boundary adjustments:** drop `chalk`. Drop the `api/auth.ts`+`api/session.ts`+
  `api/device.ts` triad — replace with the SDK's `createHttpSubstrateFactory()`
  pattern already in use.

---

## 6. Prerequisite dependencies (cross-polyrepo)

| Prereq                                                | Blocks   | Status                  |
| ----------------------------------------------------- | -------- | ----------------------- |
| `unblock_macaroons` polyrepo (currently workspace-only) | W2 (rotate path) | NOT SCAFFOLDED YET — flag at W2 start. W2 can ship parity with placeholder if not ready. |
| `unblock_protocol` ships `aggregate.json` in dist     | (out-of-scope; affects `api` cmd in `unblock_capture_cli`) | scaffolded · aggregate.json status unknown |
| `unblock_capture_cli` polyrepo created                | (parallel — no blocker for THIS plan) | NOT CREATED YET. Recommended: scaffold next, port capture/setup/import as first 3 waves there. |
| `unblock_sdk` exposes health/status/watch/flush/message verbs | W3, W4 | needs audit before W3 dispatch |
| `chalk` dep removed from package.json                 | (cosmetic — no rule blocks until W1 adds the first import) | open. W1 simply doesn't import it. |
| AGENTS.md §7 vs CLAUDE.md "node only" reconciliation  | every wave | **resolve at end of W1**: amend CLAUDE.md to "dual runtime" since boundary script enforces it. |

---

## 7. Tracer-bullet code (Wave 1)

Lands in this PR. See:

- `src/profile/registry.ts` — types, atomic write, CAS, lock, paths
- `src/profile/commands.ts` — `cmdProfileAdd / cmdProfileList / cmdProfileUse / cmdProfileRm`
- `src/main.ts` — register four subcommands under `unblock profile <sub>`
- `tests/profile/registry.test.ts` — round-trip / CAS / lock / mode-600 tests
- `tests/profile/commands.test.ts` — happy + error paths for each subcommand

**Acceptance gate (this branch):**

```bash
pnpm install && pnpm build && pnpm test && pnpm lint && node scripts/check-boundaries.mjs
```

All four green. Test-count delta: **baseline 72 → target ≥82** (10 added).

**Commits:** signed `Viraj-Alpha <virajsharma@kaeva.app>` per AGENTS.md §5.

---

## Sign-off

Author: Viraj-Alpha · 2026-05-24 · `port/v1-cli-wave-1-profile-tracer`
