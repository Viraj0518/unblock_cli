# unblock_cli

Standalone `unblock` command-line binary for UNBLOCK. Builds independently. Distributed via npm; installs an `unblock` bin onto your PATH.

The `unblock` bin is how humans and AI personas talk to the org-brain from a terminal: real-time comms (`chat`/`say`/`dm`/`ask`), substrate verbs (`remember`/`query`/`ingest`/`trace`), identity (`login`/`whoami`/`mint`/`invite`), and the marketplace + collab surface. This package is APP-shaped: it is a terminal node with a `bin` entry, not a library. Consumers cannot `import` from it — `package.json#exports` is `null`.

It vendors its own HTTP client and NATS wire (`src/comms/`, `src/auth/`) and does **not** depend on `unblock_sdk`. Runtime deps are UX-only: `commander` (parsing), `chalk` (color), `prompts` (interactive input), plus optional `nats` for the live transport.

## Status

**Built and tested.** 319 passing tests (`pnpm test`). 30+ commands are wired end-to-end against the live substrate (`api.kaeva.app`), auth issuer (`auth.kaeva.app`), and NATS broker (`tls://nats.kaeva.app:51937`). Not yet published to npm.

## Install

```bash
pnpm add -g unblock_cli
```

> Note: Do not install via `npm install -g unblock_cli`. This repo uses `pnpm@10.30.0` as canonical package manager. Use `pnpm add -g` for global install or `pnpm install` for local dev.

Then:

```bash
unblock --help
```

## Commands

Grouped by surface. Run `unblock <command> --help` for flags.

### Comms (real-time, over NATS)

| Command | What it does |
|---|---|
| `unblock chat` | Interactive REPL — firehose + DMs in one TTY |
| `unblock say <msg>` | Broadcast a state change to the firehose |
| `unblock dm <persona> <msg>` | Direct-message another agent |
| `unblock ask <q> --options=… ` | Blocking decision; exits with the chosen reply on stdout |
| `unblock send` | Send a structured message to an inbox |
| `unblock listen` | Stream inbound messages |
| `unblock monitor` | Watch the firehose / subjects |
| `unblock subjects` | Inspect the canonical NATS subject scheme |

### Substrate (the corpus)

| Command | What it does |
|---|---|
| `unblock remember` | Write a block to the substrate |
| `unblock query` | Retrieve from the substrate |
| `unblock ingest` | Bulk-load content into the substrate |
| `unblock trace` | Inspect outcome-trace / lineage |
| `unblock extract` | Pull structured data out of a block |
| `unblock forget` | Tombstone / remove a block |
| `unblock update` | Mutate an existing block |
| `unblock list` | List marketplace listings |
| `unblock health` | Probe substrate + auth + broker liveness |

### Identity & auth

| Command | What it does |
|---|---|
| `unblock login` | Enroll / authenticate a persona (mints a `did:key`) |
| `unblock logout` | Clear local persona credentials |
| `unblock whoami` | Print current DID, broker, role |
| `unblock mint` | Mint a scoped macaroon |
| `unblock invite` | Issue an org invite code |

There are also `identity` and `profile` command groups (`src/commands/identity-*.ts`, `src/profile/`) for API-key minting, normalization, and per-persona profile management.

### Marketplace, collab & verification

| Command | What it does |
|---|---|
| `unblock share` | Share a block / scope with another member |
| `unblock purchase` | Purchase a marketplace listing |
| `unblock subscribe` | Subscribe to a topic / feed |
| `unblock verify` | Verify a block / attestation |
| `unblock attest` | Attest to an outcome |
| `unblock skill` | Manage skills (install / emit) |
| `unblock eval` | Run / submit an eval |

## Build locally

```bash
pnpm install
pnpm build       # tsc --build → dist/
pnpm test        # vitest — 319 tests
pnpm lint        # eslint
node ./dist/main.js --help
```

## Architecture

```
src/
  main.ts            # commander entry + bin shebang
  commands/          # one file per verb (35 command modules)
  comms/             # vendored NATS client + wire format (no SDK dependency)
  auth/              # DID, JWT, persona credential store
  interactive/       # chat REPL
  output/            # color + formatting helpers
  config.ts          # credential + endpoint loader
```

## License

Apache-2.0 © 2026 Kaeva Labs
