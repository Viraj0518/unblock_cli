# CLAUDE.md — unblock_cli

Auto-loaded by Claude Code when working in this repo. Read before every edit.

## What this polyrepo is

The `unblock` bin. Exposes verbs to humans and AI personas: `chat`, `say`, `dm`, `ask`, `remember`, `query`, `login`, `whoami`. Thin wrapper over `unblock_sdk` plus a TTY REPL.

## Parent context

Part of UNBLOCK_REBASE polyrepo composition (15 total). Master operating rules at `C:/Users/12066/CLAUDE.md`. Full multi-AI maintainer contract at [AGENTS.md](./AGENTS.md). Polyrepo decomposition memory: `project_unblock_polyrepo_decomposition_20260524.md`.

## The one rule

> Refactor any one unit without breaking the others.

Enforced by `scripts/check-boundaries.mjs` (TODO: port from `unblock_auth` if not present):
- No `_shared/` imports
- No `@unblock/<other-pkg>/src/**` deep imports
- No `process.env.X ?? <default>` in src/
- No implicit `Buffer` / `process` globals — use `import { Buffer } from "node:buffer"` etc. (Supabase Edge / Deno compat — see `feedback_deno_friendly_imports_polyrepos_20260524.md`)

## Pragmatic Programming (enforced at acceptance gate)

| Tip | Rule | Blocks |
|---|---|---|
| 11 DRY | Shared types live in `@unblock/protocol`; never duplicate | Two polyrepos defining same schema |
| 13 Orthogonality | Boundary contract above | Cross-polyrepo leakage |
| 14 Reversibility | Migrations ship with rollback; feature flags > branches | Irreversible commits |
| 15 Tracer Bullets | E2E vertical slices first | Fat horizontal slices |
| 20 Plain Text | ADRs/schemas in markdown/Zod/SQL | Binary configs |
| 23 Source Control | Conventional Commits, sign as Viraj-Alpha | Anonymous commits |
| 25 Don't Panic | Pause + report at preflight when brief contradicts code | Powering through ambiguity |
| 30 Sign Your Work | Commit author `Viraj-Alpha <virajsharma@kaeva.app>` | Fake authorship |
| 31 Design by Contract | Zod schemas at module boundaries | Untyped surfaces |
| 32 Crash Early | `assertSecure*()` patterns; NO silent fallbacks | Silent corruption |
| 37 Refactor Early | Fix broken windows on sight | Parallel implementations |
| 62 Test Ruthlessly | Dual-runtime tests, behavioral invariants | Coverage-as-metric |
| — No Broken Windows | No `as never`, no `// @ts-ignore`, no `console.log`, no `// TODO` without tracked issue | Visible decay |

## Reuse > rebuild (mandatory ordering)

1. `C:/Users/12066/unblock-v02-mig/` (source-of-truth ADRs + many ports)
2. `Viraj0518/UNBLOCK_0.1.0` (newest production; clone if not local)
3. `C:/Users/12066/unblock-new/` on `main` (older UNBLOCK; UI + on-chain)
4. Sibling polyrepos at `C:/Users/12066/unblock_*/`
5. OSS

Extending existing code = 20% of greenfield effort. Hard rule.

## Source maps for this polyrepo

- UNBLOCK_0.1.0: `packages/unblock-cli/`
- v02-mig: CLI work under `packages/` and any `bin/` scripts
- Older UNBLOCK: `scripts/identity/persona_nats.py` is the Python fallback (mirrors this CLI's wire format)

## Dependencies on other polyrepos

- `unblock_sdk` — every CLI verb dispatches via the SDK
- `unblock_protocol` — error messages reuse the canonical error enum

Consumed by: Humans at a terminal. AI personas (Claude Code, Codex) running `unblock chat / say / dm / ask` per the parent `CLAUDE.md`.

## Runtime targets

Node 22 (only). The bin runs as a process with TTY access; edge is not a runtime target.

## Acceptance gate (per commit)

```bash
pnpm build && pnpm test && pnpm lint && node scripts/check-boundaries.mjs
```

All four green. No `--no-verify`. No skipping hooks.

## Special notes

The shebang `#!/usr/bin/env node` is required on the bin entry. The landmines file documents what happens when it's missing (Windows fails silently).

## Inter-agent comms

UNBLOCK NATS at `tls://nats.kaeva.app:30640`. See parent `C:/Users/12066/CLAUDE.md` for `unblock chat / say / dm / ask`. Sign commits as `Viraj-Alpha <virajsharma@kaeva.app>`.

## References

- Polyrepo decomposition: `C:/Users/12066/.claude/projects/C--Users-12066/memory/project_unblock_polyrepo_decomposition_20260524.md`
- Tenancy (1 enterprise = 1 Supabase project, 4-tier hierarchy): `project_unblock_rebase_tenancy_20260524.md`
- Deno-friendly imports: `feedback_deno_friendly_imports_polyrepos_20260524.md`
- Polyrepo landmines (7 traps): `feedback_polyrepo_landmines.md`
- Locked enterprise design: `C:/Users/12066/unblock-v02-mig/docs/handoff/AUTH-COMMS-V1-ENTERPRISE-DESIGN-20260522.md`
- Per-repo AGENTS.md: 8-section deeper contract
