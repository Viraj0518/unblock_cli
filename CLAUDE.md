# CLAUDE.md — unblock_cli

Contributor guide for AI coding agents (Claude Code, Codex, etc.) and humans
working in this repository. Read before your first edit. The same rules apply
to everyone; see [AGENTS.md](./AGENTS.md) for the longer maintainer contract.

## What this is

The `unblock` command-line binary. It exposes verbs to humans and AI agents
over NATS (real-time comms) and HTTP (substrate + auth): `chat`, `say`, `dm`,
`ask`, `remember`, `query`, `login`, `whoami`, and the marketplace/collab
surface. It is APP-shaped — a terminal binary with a `bin` entry, not a library
(`package.json#exports` is `null`). It vendors its own HTTP client and NATS
wire and has no runtime dependency on other internal packages.

## The one rule

> Refactor any one unit without breaking the others.

Enforced mechanically by `scripts/check-boundaries.mjs`:

- No imports from any path containing `_shared/`.
- No deep imports from `@unblock/<other-pkg>/...` (root `@unblock/protocol` OK).
- No `process.env.X ?? <default>` in `src/` — config is a required argument,
  not a silent env fallback. Tests are exempt.
- No `as never` / `as unknown as X` blind casts, and no `@ts-ignore`.
- No bare `Buffer.*` without `import { Buffer } from "node:buffer"`.

## Build & test

Node 22 (only). Package manager: `pnpm`.

```bash
pnpm install
pnpm build                              # tsc --build → dist/
pnpm test                               # vitest
pnpm lint                               # eslint
node scripts/check-boundaries.mjs       # boundary rules
```

The acceptance gate, in order, all four green:

```bash
pnpm build && pnpm test && pnpm lint && node scripts/check-boundaries.mjs
```

No `--no-verify`. No skipping hooks. A red gate is not done.

## Conventions

- **Reuse before rebuild.** Check the rest of this repo (`src/index.ts` is the
  index of public symbols; `git grep` is fast) and OSS before writing fresh.
- **Honest types.** Match the actual shape; never `as never`, `as unknown as`,
  or `@ts-ignore`. If a type is wrong, fix the type.
- **Cross-runtime hygiene.** Source that imports a `node:*` built-in can break
  the edge/browser surface — gate it or inject a dependency. Import `Buffer`
  explicitly from `node:buffer`.
- **Tests are a design tool.** Write the failing test first for new behavior;
  ship a regression test in the same PR as a bug fix.
- **Crash early.** Surface a clear error with a `code` when state is
  unexpected, rather than silently falling back.
- **Small steps.** Keep PRs focused; prefer multiple small commits over one
  large one. Conventional Commit messages.

## Special notes

- The shebang `#!/usr/bin/env node` is required on the bin entry; without it
  the binary fails silently on Windows.
- Default endpoints (NATS broker, auth issuer, substrate API) live as named
  constants in `src/config.ts` and `src/sdk/http-substrate.ts`. They are
  overridable via env vars (`UNBLOCK_NATS_URL`, `UNBLOCK_AUTH_URL`,
  `UNBLOCK_SUBSTRATE_URL`) and CLI flags.

## Architecture

```
src/
  main.ts            # commander entry + bin shebang
  commands/          # one file per verb
  comms/             # vendored NATS client + wire format
  auth/              # DID, JWT, persona credential store
  interactive/       # chat REPL
  output/            # color + formatting helpers
  config.ts          # credential + endpoint loader
```
