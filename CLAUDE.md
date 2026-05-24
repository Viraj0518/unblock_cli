# CLAUDE.md — unblock_cli

Auto-loaded by Claude Code when working in this repo. Read before every edit.

## The vision (what this is FOR)

**UNBLOCK is the organizational brain.** Organizations today don't have brains — every brain is individual, so context evaporates at the boundary of people's heads. Managers repeat themselves; knowledge dies when employees leave; executives broadcast strategy 50 times before it lands; new members onboard from zero; every AI agent dropped into an org needs full context re-explanation. UNBLOCK gives the *organization itself* memory, learning, continuity, and economic agency.

Members (humans + agents) are *neurons* contributing to and reading from the org's brain. When a member leaves, their thoughts stay in the brain; only their personal scope leaves. New members inherit the full cognitive state on day one.

**Every decision in this polyrepo should be evaluated against:** *does this preserve or strengthen the org-brain?* Not just "does it ship" or "does it scale." If a choice optimizes for individual scope at the cost of collective coherence, it's the wrong choice.

This polyrepo is one organ in that brain (see the next section for which organ). The architectural mechanics — 1 enterprise = 1 Supabase project, 4-tier Org→Group→Team→Member hierarchy, EIP-1271 + macaroons, outcome-trace DAG, brain-operations taxonomy, token-only marketplace — are all *consequences* of the org-brain thesis, not arbitrary choices.

Full thesis: `~/.claude/projects/C--Users-12066/memory/project_unblock_vision_organizational_brain_20260524.md`. TAM = every org that exists. Metric of success = no one ever has to re-explain context to a new member of the org.

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

The full canon from *The Pragmatic Programmer* (Hunt & Thomas, 20th-anniversary ed., 2019), each bound to a concrete consequence in this repo. Read top-to-bottom once; refer back when uncertain. ⭐ marks the principles whose violation has already cost the original UNBLOCK build (see "Lessons burned in").

### Ch 1 · A Pragmatic Philosophy

1. **Care About Your Craft.** If you don't, the code shows it. Quality is a requirement, not a virtue.
2. **Think! About Your Work.** Don't autopilot. Every PR, ask why before how.
3. **You Have Agency.** If a process is broken, fix the process. Don't shrug at sub-optimal defaults.
4. **Provide Options, Don't Make Lame Excuses.** When blocked, surface options + tradeoffs, not just "blocked."
5. ⭐ **Don't Live with Broken Windows.** Fix failing tests, dangling TODOs, flaky CI, typecheck warnings the day you see them. Original repo had 9 chronically-failing workflows — that's the disease state.
6. **Be a Catalyst for Change.** Don't wait for perfect. Ship the small thing that makes the next thing easier (stone soup).
7. **Remember the Big Picture.** The 6 seams in `docs/VISION.md` ARE the big picture. Every commit serves them or it shouldn't merge.
8. **Make Quality a Requirements Issue.** Negotiate good-enough explicitly. Phase 1's "remember+query roundtrip via wrangler dev" IS the quality bar.
9. **Invest Regularly in Your Knowledge Portfolio.** Read this book. Read the canonical OSS in your stack. Don't reinvent what already works.

### Ch 2 · A Pragmatic Approach

10. **Critically Analyze What You Read and Hear.** Including this CLAUDE.md. If a rule no longer fits, file an ADR amending it.
11. **English is Just Another Programming Language.** Code is communication. Comments + commit messages + ADRs are a UX surface for future-you.
12. **It's Both What You Say and the Way You Say It.** Tone in PR comments, commit messages, code review matters. Be brutally honest, never personally cutting.
13. **Build Documentation In, Don't Bolt It On.** README per module from commit 1 (mandated). ADR for every architectural commit. Code-adjacent docs in code dirs.
14. **Good Design Is Easier to Change Than Bad Design.** ETC — Easier To Change. If a small requirement change requires touching 12 files, the design is bad.
15. ⭐ **DRY — Don't Repeat Yourself.** One source of truth per concept. Coverage audit found three for the canonical contract (`upc/canonical/*.schema.json` vs Zod in `schemas.ts` vs OpenAPI). Fix structurally — generate two from one — not with parity tests policing drift.
16. **Make It Easy to Reuse.** Reuse > rebuild is rule #1 of this repo (see "Reuse > rebuild" above). Already operational.
17. ⭐ **Eliminate Effects Between Unrelated Things.** Orthogonality. Today's consolidations live at `services/catalog-api/src/middleware/` (etag · rate-limit · sentry · logging · versioning) and `services/catalog-api/src/auth/middleware.ts` (with a sibling duplicate at `services/relay/src/auth/middleware.ts` — known smell, refactor to `services/_shared/` is on the deck). Don't duplicate any of these in a new service; reuse the existing modules.
18. **There Are No Final Decisions.** ADRs are amendable. Document what you'd reverse and under what condition.
19. **Forgo Following Fads.** Pick stable boring tech. Hono + Zod + Workers + D1 = boring. Don't substitute the framework du jour.
20. ⭐ **Use Tracer Bullets to Find the Target.** Smallest end-to-end thing first, with real wires. Phase 1 = "remember+query roundtrip with real D1 + real Vectorize," not "every verb stubbed."
21. ⭐ **Prototype to Learn.** Throwaway code in scratch dirs only. Production code that started as "let's see if this works" is how the original repo earned 19 catalog-api files nominated for deprecation.
22. **Program Close to the Problem Domain.** UPC verbs (remember/query/share/list/purchase/verify/attest/subscribe/update/extract/forget/message) ARE the domain. Don't leak HTTP/DB plumbing into them.
23. **Estimate to Avoid Surprises.** Component plan has XS/S/M/L/XL effort per item; commit-level estimates per phase.
24. **Iterate the Schedule with the Code.** BUILD-PLAN said 5 weeks; component plan says 7. Update as you learn — don't pretend the original estimate.

### Ch 3 · The Basic Tools

25. **Keep Knowledge in Plain Text.** Markdown for docs. JSON Schema for contracts. SQL for migrations. Plain text outlives binary formats and proprietary editors.
26. **Use the Power of Command Shells.** Bash, PowerShell as needed. Don't click GUIs that should be `wrangler` commands.
27. **Achieve Editor Fluency.** VS Code with Vim mode (or whatever). Know your shortcuts cold; the keyboard beats the mouse.
28. **Always Use Version Control.** Git from commit 1. Pre-commit hooks land in commit 5 per D10. Never edit live infra without a commit.
29. **Fix the Problem, Not the Blame.** When a test fails, fix the code or the test. Don't ask whose fault it is.
30. **Don't Panic.** Production incident? Read logs first. Reproduce. Don't push hot fixes blind.
31. **Failing Test Before Fixing Code.** Reproduce the bug as a test. Commit the test red. Then fix. PR diff shows both.
32. **Read the Damn Error Message.** Half of "stuck for an hour" is skipping line 1 of a stack trace.
33. **"select" Isn't Broken.** When something's wrong, the bug is in YOUR code 99% of the time. Not the framework, not the OS, not the network.
34. ⭐ **Don't Assume It — Prove It.** Especially concurrency. The D6 race at `remember.ts:191-223` is a "999/1000 works" bug — prove correctness on concurrent paths.
35. **Learn a Text Manipulation Language.** ripgrep, sed, awk, jq. Or Python one-liners. Don't manual-grep through long files.

### Ch 4 · Pragmatic Paranoia

36. **You Can't Write Perfect Software.** Aim for "good enough that the next phase doesn't need to revisit." Defensive programming at boundaries; trust internals.
37. **Design with Contracts.** Preconditions (Zod at the request boundary), postconditions (asserted in tests), invariants (enforced inline). The OpenAPI document is the service meta-contract.
38. ⭐ **Crash Early.** Surface 5xx with `code` + `request_id` when state is unexpected. `remember.ts:239-251` is the right shape — insert succeeded but couldn't be read back → 500, not silent fallback.
39. **Use Assertions to Prevent the Impossible.** If "this can't happen" — assert it. When it does happen, you'll know within seconds, not days.
40. **Finish What You Start.** Resource hygiene: open → use → close. Acquire in the same scope you release. CF Workers eat leaked DB connections for breakfast.
41. **Act Locally.** Variables, state, transactions — narrow scope wins. Globals are the death of orthogonality.
42. **Take Small Steps — Always.** PRs >300 lines should split. Multi-paragraph commit messages should be multiple commits. Rollback granularity = step size.
43. **Avoid Fortune-Telling.** Don't write code for hypothetical Phase 5 needs in Phase 1. YAGNI. The 3 phase-5 501-stubs in OpenAPI are a small instance of this — flagged for removal.

### Ch 5 · Bend, or Break

44. **Decoupled Code Is Easier to Change.** Loose coupling via interfaces, events, queues. Tight coupling via shared mutable state.
45. **Tell, Don't Ask.** Don't fetch state from an object to decide; tell the object to decide. Reduces leakage.
46. **Don't Chain Method Calls.** `a.b().c().d().e` couples you to all of a, b, c, d. One step deep is the rule of thumb (Law of Demeter).
47. **Avoid Global Data.** Module-level mutable state IS global. Pass it explicitly. CF env-bindings are the right shape — explicit, scoped, typed.
48. **If It's Important Enough To Be Global, Wrap It in an API.** Logger, config, feature flags — behind interfaces, never as raw globals.
49. **Programming Is About Code, But Programs Are About Data.** UNBLOCK IS data-substrate. Schemas are the source of value. Code is plumbing.
50. **Don't Hoard State; Pass It Around.** Pure functions where you can; explicit context where you can't. No surprise globals.
51. **Don't Pay Inheritance Tax.** Composition > inheritance. Mixins / interfaces / traits over deep class hierarchies.
52. **Prefer Interfaces to Express Polymorphism.** TS interfaces + structural typing. Avoid abstract classes unless required.
53. **Delegate to Services: Has-A Trumps Is-A.** A `RememberHandler` HAS a `BlockUploader`, not IS one.
54. **Use Mixins to Share Functionality.** Cross-cutting concerns (logging, retries, validation) as Hono middlewares, not class hierarchies.
55. **Parameterize Your App Using External Configuration.** `wrangler.toml [vars]`. Sentry DSN via `wrangler secret`. Never hardcode env values.

### Ch 6 · Concurrency

56. **Analyze Workflow to Improve Concurrency.** Map activities first, find independence, parallelize what's actually independent.
57. ⭐ **Shared State Is Incorrect State.** D6 race is exactly this. SELECT-then-INSERT under concurrent calls = wrong by construction.
58. **Random Failures Are Often Concurrency Issues.** Flaky tests are usually concurrency, not "the test is flaky." Don't add retries — find the race.
59. **Use Actors For Concurrency Without Shared State.** Workers DO actors via Durable Objects. Per-tenant DO = natural actor (rate-limit DO is the canonical example).
60. **Use Blackboards to Coordinate Workflow.** USEL substrate IS the blackboard. Events posted, consumers read; no direct calls.
61. **Listen to Your Inner Lizard.** Trust the gut "this feels wrong." It usually is. Investigate before pushing.

### Ch 7 · While You Are Coding

62. ⭐ **Don't Program by Coincidence.** Understand WHY code works, not just THAT it works. Coincidence-passing tests rot.
63. **Estimate the Order of Your Algorithms.** O(n²) on D1 = death. Indexes match query patterns; check before scaling. The missing `embedding_id` index in mig 001 is one such target.
64. **Test Your Estimates.** Bench harness exists for this. Don't ship perf claims you haven't measured.
65. ⭐ **Refactor Early, Refactor Often.** Smell sighted = refactor in the same PR you're already in. Carry "we'll clean up later" → deprecation list grows.
66. **Testing Is Not About Finding Bugs.** Tests are a design tool. They prove you understood the contract before you wrote the impl.
67. ⭐ **A Test Is the First User of Your Code.** Write the failing test first. Phase 1's success-path remember test and idempotency test are missing precisely because they weren't written first.
68. **Build End-to-End, Not Top-Down or Bottom-Up.** Tracer bullet through every layer; thicken the slices later.
69. **Design to Test.** If it's hard to test, the design is wrong. Refactor the code, not the test.
70. **Test Your Software, or Your Users Will.** Cheaper to find bugs in CI than from production incidents.
71. **Use Property-Based Tests to Validate Your Assumptions.** "For all valid inputs, output satisfies X." `fast-check` (TS) / `hypothesis` (Py). Worth adding for canonical schemas.
72. **Keep It Simple and Minimize Attack Surfaces.** 27 endpoints + 9 verbs IS the entire surface. Don't add a 28th without an ADR.
73. **Apply Security Patches Quickly.** Dependabot enabled. Prompt merge of security advisories. No "we'll patch in next sprint."

### Ch 8 · Before the Project

74. ⭐ **Name Well; Rename When Needed.** Rename the day you see it, not the day it bites a downstream handler. Historical example: `parent_block_id` (D1) vs `parent_block` (schema) — resolved in mig 001 + `schemas.ts:213`; remaining ghost refs cleaned in `dev/seed_rules.py:213` (ENT-14, 2026-05-21). Bad names compound; the cost of waiting is O(every-downstream-handler).
75. **No One Knows Exactly What They Want.** Build, show, iterate. Don't pre-spec what will change.
76. **Programmers Help People Understand What They Want.** Surface the want behind the ask. "Marketplace categories" is the WANT; "10-category enum" is the ASK.
77. **Requirements Are Learned in a Feedback Loop.** Phase 1 ships → users hit it → reqs sharpen for Phase 2. Don't try to fully spec Phase 5 today.
78. **Work with a User to Think Like a User.** Dogfood UNBLOCK on UNBLOCK. Use the MCP server in your own sessions before others do.
79. **Policy Is Metadata.** KYC thresholds, rate limits, category gates → config, not code. Storefront whitelists per ADR-002 are config.
80. **Use a Project Glossary.** `docs/glossary.md` when terms multiply. Already implicit: block / scope / cap-token / listing / attestation defined in OpenAPI schemas.
81. **Don't Think Outside the Box — Find the Box.** What are the actual constraints? "Substrate, not memory feature" is a box-finding decision (VISION.md).

### Ch 9 · Pragmatic Projects

82. **Don't Go into the Code Alone.** Pair programming or PR review. Sensitive paths require CODEOWNERS-approved review (already in operating rules).
83. **Agile Is Not a Noun; Agile Is How You Do Things.** Iterate. Get feedback. Adjust. Don't worship ceremonies.
84. **Maintain Small, Stable Teams.** v0.1 = Viraj + 4 Claude instances + Codex/M2.7. Stable. No rotating contractors.
85. **Schedule It to Make It Happen.** "I'll get to it" = never. Component plan has sprints with target durations.
86. **Organize Fully Functional Teams.** A team that owns design + code + ship + ops, not handoffs.
87. **Do What Works, Not What's Fashionable.** Boring stack (Hono / Zod / vitest / D1 / Workers) ships. Don't substitute the new shiny.
88. **Deliver When Users Need It.** Phase 4 ships when MCP works end-to-end, not when calendar says.
89. **Use Version Control to Drive Builds, Tests, and Releases.** Tags trigger releases (Phase 6 hardening). No manual deploys after staging.
90. **Test Early, Test Often, Test Automatically.** CI runs on every PR. Tests run before merge. Pre-merge gates from D10.
91. **Coding Ain't Done 'Til All the Tests Run.** PR with red CI ≠ done. No exceptions, no "I'll fix in main."
92. **Use Saboteurs to Test Your Testing.** Mutation testing. If you can flip booleans and tests still pass, the tests are weak.
93. **Test State Coverage, Not Code Coverage.** 90% line coverage on the happy path = false comfort. Test state transitions: empty / one / many / boundary / failure / concurrent.
94. ⭐ **Find Bugs Once.** Every bug-fix PR ships with a regression test in the same PR. The TOCTOU race fix lands with a concurrent-write test — not "we'll add coverage in a later sprint."
95. ⭐ **Don't Use Manual Procedures.** Ran a command twice → write it down. Three times → automate. Migrations ship with rollbacks because manual application broke prod in the original repo.
96. **Delight Users, Don't Just Deliver Code.** The aha-moment loop (Codex picks up where Claude left off) IS the delight target. Hit it in Phase 4.
97. ⭐ **Sign Your Work.** Every AI commit carries the `Co-Authored-By:` trailer. Every USEL event carries an Ed25519 sig. Every cap-token carries `issuer` + `signature_algorithm`. Provenance is a product feature, not a footnote.
98. **First, Do No Harm.** Don't ship features that harm users (data loss, surveillance, lock-in). UNBLOCK is anti-walled-garden by thesis.
99. **Don't Enable Scumbags.** Refuse work that helps bad actors. The 3 gated marketplace categories (behavioral / exploits / privileged-info, ADR-002 §D1) exist for this reason.
100. **It's Your Life. Share It. Celebrate It. Build It. AND HAVE FUN!**

Violations = block at acceptance gate. ⭐ tips have already cost previous UNBLOCK builds — extra scrutiny on those.

## Lessons burned in from `Viraj0518/UNBLOCK`

- Vectorize `metadataIndexes` MUST be configured at index-create time. Cannot be added later.
- `schema_version` table from migration 001. Track every migration's apply timestamp.
- Signed events from day 1, not retrofitted.
- Wallets, keys, and other cryptographic material live in KMS or 1Password — never in git, even on testnet, even with a "note: test only" comment.
- TruffleHog `--exclude-paths` uses Go regex (RE2), not glob. `**/foo` is invalid; use literal substring patterns or `\.foo$` anchored regex.
- CI workflow path filters must exclude `**.md` for doc-only changes, OR doc-only PRs trigger Solidity scans, deploys, and other expensive jobs.
- `research/` and other heavy data dirs go to HuggingFace dataset archives from day 1, not committed to the main repo.

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
