# AGENTS.md — multi-AI maintainer contract

This repository is maintained by humans **and** AI agents (Claude Code, Codex,
Cursor, and other LLM agents). This file is the contract every AI agent reads
before touching the codebase. If you are a human, read it anyway — the rules
are the same for everyone.

---

## 1. The one rule

> **Refactor any one unit without breaking the others.**

`scripts/check-boundaries.mjs` enforces this mechanically over `src/`:

| Rule | Why |
| ---- | --- |
| No imports from any path containing `_shared/` | Avoid cross-package leakage — vendor what you need under `src/`. |
| No deep imports from `@unblock/<other-pkg>/...` | This package is standalone. Root `@unblock/protocol` (shared types) is the only exception. |
| No `process.env.X ?? <default>` in source | Config is a **required argument**, not a silent env fallback. Tests are exempt. |
| No `as never` / `as unknown as X` / `@ts-ignore` | Honest types only — match the actual shape. |
| No bare `Buffer.*` without `import { Buffer } from "node:buffer"` | So the module runs under edge/Deno runtimes. |

If your change tries to do any of those, stop and find another way — usually
that means vendoring the upstream implementation under `src/<module>/`.

## 2. Reuse > rebuild

Before writing **any** new code:

1. Check the rest of this repo — `src/index.ts` indexes the public symbols;
   `git grep` is faster than rewriting.
2. Check OSS for a maintained library that fits.
3. Write fresh only if neither fits.

Extending existing code takes a fraction of the effort of rebuilding.

## 3. Boundary contract

The rules from §1 are enforced at four layers:

| Layer | What it catches |
| ----- | --------------- |
| **TypeScript** (`tsconfig.json`) | Import-path mistakes that change emitted JS |
| **ESLint** (`eslint.config.js`) | Style, unused vars, lint-time imports |
| **Runtime exports** (`package.json`) | Consumers cannot reach past published entry points |
| **Boundary script** (`scripts/check-boundaries.mjs`) | The rules above; runs on `prepublishOnly` |

If you change the boundary script, you change the contract. Don't, without a
clear rationale in the PR.

## 4. Commit format

[Conventional Commits](https://www.conventionalcommits.org/).

- **Breaking changes** add a `BREAKING CHANGE:` footer with the migration path.
- Author yourself with a real identity (name + email). Sign AI-authored
  commits with a `Co-Authored-By:` trailer.

## 5. Tests gate everything

The full gate, in order, all green before any commit:

```bash
pnpm build                              # tsc --build must succeed
pnpm test                               # all tests green
pnpm lint                               # eslint clean
node scripts/check-boundaries.mjs       # boundary rules clean
```

No exceptions. If a test fails after your change, the test is right and your
code is wrong unless you can demonstrate otherwise in the PR description.
Tests cover arg parsing, the REPL state machine, and exit codes (especially
`unblock ask` blocking with `--default=abort`).

## 6. Cross-runtime parity

Source that imports a `node:*` built-in can break the edge/browser surface.
Avoid it without justification:

- **Crypto** — use the `@noble/*` libraries, not `node:crypto`.
- **Random** — use `globalThis.crypto.getRandomValues`.
- **Fetch** — inject a `fetcher` arg defaulting to `globalThis.fetch`.

If a `node:*` import is unavoidable for an internal helper, gate it behind a
runtime check and provide a fallback in the same module.

## 7. Concurrency handling

Multiple agents working on the same repo will eventually hit a
`.git/index.lock` collision. Key invariants:

1. **Never `git push --force`** over another agent's work — if you see a
   non-fast-forward, stash, fetch, replay your own hunks.
2. **Never use `--no-verify`** to bypass a failing hook. Fix the underlying
   issue.
3. **Check `git log` after `git commit`** — confirm your HEAD advanced.
4. Use `git worktree add` rather than `git checkout` when running in parallel
   on a different branch.

---

## Footnote — why this file exists

A mix of human + AI maintainers is unusual; most OSS repos optimize for one or
the other. `AGENTS.md` formalizes the AI-specific rules so an agent can
self-onboard from a single file. If something is unclear, file an issue.
