# AGENTS.md — multi-AI maintainer contract

This repository is maintained by humans **and** AI agents (Claude Code, Codex,
Cursor, custom MCP setups, future LLM agents). This file is the **contract**
every AI agent reads before touching the codebase.

If you are an AI agent, read all 8 sections below before your first edit.
If you are a human, read this anyway — the rules are the same for everyone;
they're just enforced more strictly on agents because we cannot trust an
agent's "I thought about it" the way we can trust a human reviewer's
intuition.

---

## 1. The one rule

> **Refactor any one unit without breaking the others.**

The boundary contract in `scripts/check-boundaries.mjs` (TODO: port from
`unblock_auth` if not yet present in this repo) enforces this mechanically:

| Rule | Why |
| ---- | --- |
| No imports from any path containing `_shared/` | Cross-package leakage — siblings vendor what they need under `src/`. |
| No imports from `@unblock/<other-pkg>` | This package is standalone; sibling packages are vendored, not referenced. Only exception: `@unblock/protocol` (shared types/schemas). |
| No `process.env.X ?? <default>` in source | Config is a **required constructor arg**, not a silent env fallback. Tests are exempt. |
| No implicit `Buffer` / `process` globals | Use `import { Buffer } from "node:buffer"` so the module runs under Supabase Edge / Deno. |

If your change tries to do any of those things, **stop**, re-read this
section, and find another way — usually that means vendoring the upstream
implementation under `src/<module>/_core/` (or, for Foundry, copying the
needed OZ contract into `lib/` rather than reaching across project boundaries).

TODO (track as separate issue): extend `scripts/check-boundaries.mjs` (or
equivalent slither config) to grep for `\bas never\b`, `// @ts-ignore`,
`console\.log\(`, and `Buffer\.from\(` not preceded by
`import { Buffer } from "node:buffer"`. Mechanical enforcement of the
Pragmatic Programming table in CLAUDE.md.

## 2. Reuse > rebuild

Before writing **any** new code, walk this sequence:

1. **Check the upstream port source** — see CLAUDE.md "Source maps for this polyrepo".
2. **Check OSS** — `commander` or `citty` for arg parsing, `prompts` for REPL UX, `kleur` for color (NO chalk — too heavy).
3. **Check the rest of this repo** — `src/index.ts` is the index of every public symbol; `git grep` is faster than rewriting.
4. **Write fresh only if none of the above fit.**

Extending an existing implementation takes ~20% of the effort of rebuilding.
This is a hard rule, not a suggestion.

## 3. Boundary contract

The rules from §1 are enforced at four layers:

| Layer | What it catches |
| ----- | --------------- |
| **TypeScript** (`tsconfig.json`) | Import path mistakes that change the emitted JS shape |
| **ESLint** (`eslint.config.js`) | Style + unused vars + lint-time imports |
| **Runtime exports** (`package.json` `exports`) | Consumers cannot reach past `dist/index.js` and explicitly published subpaths |
| **Boundary script** (`scripts/check-boundaries.mjs`) | The rules above; runs on `prepublishOnly` |

If you change the boundary script, you change the contract. Don't.

## 4. Subagent brief template

When dispatching a subagent (Codex worker, Claude Code subagent, …) to port a
module, copy this template verbatim and fill in the bracketed slots:

```
You are porting `<SOURCE PACKAGE PATH>` into the standalone `unblock_cli`
repo at `C:\Users\12066\unblock_cli\`.

DEST: src/<MODULE>/ — files: <list>
SURFACE: re-export from src/index.ts as <list>

Boundary adjustments (see AGENTS.md §3):
- Replace any `import … from '<…>/_shared/<…>'` with a vendored copy under src/<module>/_core/.
- Replace any `import … from '@unblock/<other-pkg>'` with the local import from src/ (or shared types from `@unblock/protocol`).
- Replace any `process.env.X ?? <default>` with a required constructor arg on the module's factory function. Document in TSDoc.
- Use OSS replacements per CLAUDE.md "Reuse > rebuild" so the module runs under @edge-runtime/vm.
- Import Buffer explicitly: `import { Buffer } from "node:buffer"`.

ACCEPTANCE:
- `pnpm build && pnpm test && pnpm lint && node scripts/check-boundaries.mjs` all green
- Every ported test runs under BOTH vitest projects (node + edge)
- Public surface from src/index.ts unchanged except for the new exports
- TSDoc on every new public symbol citing the relevant ADR

REPORT: file list, test count delta, surface delta, any deviations from
this brief (with reasoning).
```

The template is load-bearing. If you skip the "boundary adjustments" block,
you will almost certainly land a violation.

## 5. Commit format

[Conventional Commits](https://www.conventionalcommits.org/).

**Architectural changes** add an ADR reference in the body:

```
feat(<scope>): <subject>

Refs ADR-XXX
```

**Breaking changes** add a `BREAKING CHANGE:` footer with the migration path.

**Author yourself with a real identity.** Commit as `Viraj-Alpha
<virajsharma@kaeva.app>` (or your assigned DID-based persona) — do not fall
back to generic `[alpha]`/`[beta]`/`[claude]` legacy names. The DID is
your name across substrate, NATS, and FGA.

## 6. Tests gate everything

The full gate, in order:

```bash
pnpm build                              # tsc --build must succeed
pnpm test                               # ALL tests green under both projects
pnpm lint                               # ESLint must be clean
node scripts/check-boundaries.mjs       # Boundary rules must be clean
```

**All four must be green** before any commit. No exceptions.

Target: Minimum 25 tests covering: arg parsing, REPL state machine, exit codes (especially `unblock ask` blocking with `--default=abort`).

If a test fails after your change, the test is right and your code is wrong
unless you can demonstrate otherwise in the PR description. "I think the
test is flaky" is not a demonstration; reproduce it with a tightened seed
or skip it under a tracked issue with a clear remediation date.

## 7. Cross-runtime parity

Runtime targets: **dual** (node + edge). Every test under `tests/**/*.test.ts` must run under both vitest projects.

If you write source code that imports a `node:*` built-in, you will break the
edge/browser surface. Don't do it without justification:

- **Crypto** — use `@noble/curves` / `@noble/hashes` (already in deps), not `node:crypto`.
- **Hex / base64** — use `@noble/hashes/utils` or `multiformats/bases/base64`, not `Buffer` ambient.
- **Random** — use `globalThis.crypto.getRandomValues`, not `crypto.randomBytes`.
- **Fetch** — inject a `fetcher` arg defaulting to `globalThis.fetch`; never import `node-fetch`.

If a `node:*` import is unavoidable for an internal helper, gate it behind a
runtime check and provide an edge fallback in the same module.

## 8. Concurrency handling

Multiple subagents working on the same repo at the same time will eventually
hit a `.git/index.lock` collision. The proven pattern:

```bash
# Subagent finishes its work and is ready to commit.
git stash push -u -m "<persona>-pending"

# Pull whatever the other agent landed.
git fetch origin
git reset --hard origin/<branch>

# Pop your stash and accept ONLY your own hunks.
git stash pop
git add -p <files-you-own>     # accept only your hunks; reject the rest

# Commit your hunks.
git commit -m "..."

# Restore the remaining stash (if anything is left).
git stash pop
```

The key invariants:

1. **Never `git push --force`** to land over another agent's work — if you see a non-fast-forward, stash + reset + replay.
2. **Never use `--no-verify`** to bypass a failing hook. The hook is right; fix the underlying issue.
3. **Always check `git log` after `git commit`** — concurrent commits can land on a sidecar rather than the branch tip. If your HEAD didn't advance, your commit is sidelined; rescue with `git cherry-pick`.
4. **Acquire your worktree via `git worktree add`** rather than `git checkout` if you're running in parallel with another agent on a different branch.

---

## Footnote — why this file exists

The mix of human + AI maintainers is novel; most OSS repos optimize for one
or the other. `AGENTS.md` formalizes the AI-specific rules so an agent can
self-onboard from a single file without spelunking through commit history.
If something is unclear, file an issue — that loop is itself feedback that
this contract needs sharpening.
