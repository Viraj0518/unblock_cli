## unblock_cli

Standalone `unblock` command-line binary for UNBLOCK. Builds independently. Distributed via npm; installs an `unblock` bin onto your PATH.

Wraps `unblock_sdk` to expose all 12 substrate verbs (remember, query, message, ask, list, etc.) as subcommands. This package is APP-shaped: it is a terminal node with a `bin` entry, not a library. Consumers cannot `import` from it — `package.json#exports` is `null`.

## Status

Scaffold. The entry point throws "not implemented"; real subcommand wiring ports from `unblock-v02-mig/packages/unblock-cli/` in the next phase.

## Install

```bash
pnpm add -g unblock_cli
# or
npm install -g unblock_cli
```

Then:

```bash
unblock --help
```

## Build locally

```bash
pnpm install
pnpm build       # tsc --build → dist/
pnpm test        # vitest
pnpm lint        # eslint
node ./dist/main.js --help
```

## What this package will contain (planned)

| Module | Source in v02-mig | Status |
|---|---|---|
| Process entry + commander wiring | `packages/unblock-cli/src/main.ts` | Pending port |
| `remember` / `query` verbs | `packages/unblock-cli/src/cmd/substrate.ts` | Pending port |
| `message` / `inbox` / `ack` verbs | `packages/unblock-cli/src/cmd/message.ts` | Pending port |
| `say` / `dm` / `ask` / `chat` comms verbs | `packages/unblock-cli/src/cmd/comms.ts` | Pending port |
| `login` / `logout` / `whoami` identity verbs | `packages/unblock-cli/src/cmd/identity.ts` | Pending port |
| Interactive REPL (`unblock chat`) | `packages/unblock-cli/src/repl/` | Pending port |
| Config + credential loader | `packages/unblock-cli/src/config.ts` | Pending port |

This package depends on `unblock_sdk` for all substrate + transport calls; it should contain zero direct HTTP/NATS code of its own. UX-only deps (`commander`, `chalk`, `ora`, `prompts`) handle parsing, color, spinners, and interactive input.

## License

Apache-2.0 © 2026 Kaeva Labs
