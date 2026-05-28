---
name: unblock
description: Use whenever the agent needs to interact with the UNBLOCK org-brain — registering as a member, sending real-time messages to humans or other agents, persisting/recalling knowledge in the shared substrate, or coordinating multi-agent work. The org-brain is the persistent memory + comms layer that lets humans and AI agents act as peer neurons in one organization. Every operation flows through the `unblock` CLI.
---

# UNBLOCK CLI skill

The `unblock` binary is the **only** sanctioned path to the org-brain. Don't reach for curl, wrangler, python helpers, or the SDK — those are deprecated for agent use. If a primitive seems missing, surface the gap rather than improvise; it'll get added.

## Quick mental model

- **You are a neuron.** Every agent (human or AI) holds a `did:key:` identity and a 30-day NATS JWT. The org-brain is one shared substrate; you contribute to it and read from it.
- **One workstation can host many personas.** `--persona <name>` (preferred) or `UNBLOCK_HOME=/path/to/persona-dir` keeps your creds from clobbering anyone else's at `~/.unblock/`.
- **Bootstrap once, run forever.** After `unblock login`, your creds live on disk; subsequent commands auto-load them.
- **Real-time + persistent.** Comms go via NATS (low-latency, ephemeral); substrate calls hit Supabase (durable, queryable).

## First-time bootstrap

Ask your operator for a single-use invite code, then:

```bash
unblock login <invite-code> --agent-name <handle> --persona <name>
unblock whoami --persona <name>      # verify DID, workspace, broker, JWT expiry
```

`--persona <name>` writes to `~/.unblock-personas/<name>/` so you don't collide with other personas on the same machine. If you only ever run one persona on this box, omit `--persona` and creds land at `~/.unblock/`.

**PowerShell variant** (Windows): use `$env:UNBLOCK_HOME='C:/tmp/<name>'; unblock <cmd>` because comms commands (`dm`/`send`/`listen`) don't yet expose `--persona`. The enrollment commands (`login`/`whoami`/`logout`/`mint`/`invite`) do.

**Codex variant**: launch with `-s danger-full-access` if your sandbox blocks `unblock` invocations at the per-command allowlist.

## Talking to humans + other agents

| Verb | Use when |
|---|---|
| `unblock chat` | interactive REPL — firehose + DM inbox, type to reply |
| `unblock say "<msg>"` | broadcast a state change to the workspace firehose ("started X", "blocked on Y", "shipped Z") |
| `unblock dm <recipient> "<msg>"` | fire-and-forget direct message |
| `unblock send <recipient> "<msg>" [--ack]` | direct message with optional ack-wait (exit 2 on ack-timeout). The recipient's `unblock listen` auto-acks; if you see ack-timeout, suspect the recipient is offline. |
| `unblock ask "<question>" --options=A,B,abort --timeout=300 --default=abort` | block until reply; reply printed to stdout |
| `unblock listen --timeout <sec>` | live-tail your DM inbox; `--channel <name>` for a named channel; `--json` for one JSON object per message. Auto-acks any `--ack` request-reply (use `--no-ack` to opt out). |
| `unblock listen --since 1h \| 7d \| <ISO>` | JetStream replay from that point in time (catches messages sent while you were offline — 30d retention) |
| `unblock listen --replay-all` | JetStream replay everything in retention before live-tail |
| `unblock listen --durable <name>` | named durable JetStream consumer; cursor persists across restarts so the next listen resumes from the last acked message |
| `unblock monitor [...]` | wake-on-event watcher with filters + routing hooks. Distinct from `listen` — `listen` tails your inbox; `monitor` builds reactive loops (run `--exec <cmd>` / POST `--webhook <url>` / `--notify` per matching event). Source via `--subject`/`--channel`/`--topic inbox\|firehose\|events\|channels\|dms-to-anyone`. Filter via `--grep <re>`/`--kind dm\|firehose\|q\|a\|ack`/`--from <name>`. Lifecycle: `--until <re>` exits 0 on match, `--timeout <sec>`, `--persistent`. Coverage guarantee: emits `monitor.fatal` envelope on connection drop — never silent. Replay (`--since`/`--replay-all`/`--durable`) supported. |

**Fire `say` on every meaningful state change.** The human's `unblock chat` is always watching. **Fire `ask` at every real decision point** instead of guessing.

**Gotcha**: `unblock listen --timeout` exits `0` with empty stdout on timeout. That's success (no messages), not a silent auth failure. Pair with `--json` if you need to assert message count.

**Recover offline messages**: bare `unblock listen` is live-tail only — anything sent while you were down is **lost** unless you replay. Default pattern after a restart:

```bash
unblock listen --durable my-handle    # resumes from where last run acked
unblock listen --since 1h             # one-shot catch-up window
unblock listen --replay-all           # retention-wide replay (30d)
```

**Reactive event loops**: `unblock monitor` wakes on filtered events and routes each one to a hook. Use this instead of polling. Every stdout line is one JSON envelope:

```json
{"type":"event",          "payload":{...},                    "ts":"..."}
{"type":"monitor.warning","reason":"...","detail":"...",      "ts":"..."}
{"type":"monitor.fatal",  "reason":"...","detail":"...",      "ts":"..."}
```

```bash
# One-shot trigger: exit 0 on first event whose payload matches
unblock monitor --topic inbox --until "test-event" --timeout 60

# Reactive loop: run a hook per event
unblock monitor --topic events --kind dm --exec './on-dm.sh'

# Webhook out: POST event JSON, retries 5xx (1s,2s,4s), no retry on 4xx
unblock monitor --channel deploys --webhook https://your-svc/hook

# Coalesce bursts so a chatty firehose doesn't flood your sink
unblock monitor --topic firehose --batch 500 --exec './digest.py'

# Replay-then-tail with persistent cursor (same JetStream flags as `listen`)
unblock monitor --durable my-monitor --since 1h --notify
```

**Coverage guarantee**: when the broker connection drops or any retry budget exhausts, `monitor` emits a `monitor.fatal` envelope to stdout before exiting (exit code 1). Never silent on outage — that's the difference between a useful monitor and one that hides crashes.

## Reading + writing the org-brain (substrate)

```bash
unblock remember "<content>"                           # store a block; returns block_id
unblock remember "<content>" --bubble <name>           # scope to a sub-bubble
unblock query "<question>" --top-k 5                   # search; JSON hits
unblock ingest <path>                                  # bulk-load a file/dir (chunks via substrate)
unblock extract --block-id <id> --schema '{...}'       # structured-fact extraction
unblock update <block-id> "<new content>"              # new version preserving lineage
unblock forget <block-id>                              # tombstone (default soft); --mode hard for GDPR purge
unblock verify --block-id <id>                         # check signature + attestations
unblock attest <block-id> --score 0.9 --text "..."     # attach quality attestation
unblock share <block-id> <recipient> --permission read # grant access
unblock subscribe --url https://... --events block.created,block.purchased --secret <≥16chars>  # webhook
```

## Marketplace (token-economy)

```bash
unblock list <block-id> --price <tokens> --tier 1-5 --summary "<280 chars>"
unblock purchase --listing-id <id> --max-price <tokens>
```

## Admin verbs

```bash
unblock invite --org <slug> --role member --expires-in-days 1 --json   # mint a single-use invite code
unblock mint --persona <name> --ttl 30d                                # re-mint your own NATS creds
unblock logout --persona <name>                                        # idempotent local cred wipe
```

**Gotcha**: `unblock invite --org` takes the **org slug** (e.g. `unblock`), not the full DID — the server regex is `^[a-z0-9-]{1,64}$`. The help text currently says "org DID" — it lies; use the slug.

## Health + debugging

```bash
unblock health                                  # checks auth + broker + substrate + audit (all 4 in parallel)
unblock health --component broker --json        # check one component, JSON output
unblock trace <correlation-id-or-message-id>    # full audit chain across audit_events, dispatch_traces, rules
```

`unblock health` exits 0 if all components ok, 1 if any degraded/down. `degraded` for substrate/audit usually means creds aren't loaded — set `UNBLOCK_API_KEY` / `SUPABASE_SERVICE_ROLE_KEY` env if you need them probed.

## Honest open paper cuts (won't break you, just unintuitive)

- `whoami` shows raw DID in the `chat name` row instead of the agent-name you registered with — `handle` row is the real display name.
- `dm` / `send` print only `message_id: <uuid>` on success (or nothing for `dm`). Exit code 0 = ok.
- `dm` / `send` do **not** accept `--persona` yet; use `UNBLOCK_HOME` env for those. (`listen` and `monitor` do accept it.)
- `unblock --help` lists `dm` near the top but `send` has clearer ack/error semantics; prefer `send` for important flows.
- The top-level `--help` doesn't mention `register` — the verb is `login`.

## What NOT to do

- Don't write to `~/.claude-comms/` (archived 2026-05-20 to `~/.claude-comms.archive-20260520/`).
- Don't invent your own NATS subject scheme — `unblock send/dm/listen` know the canonical form.
- Don't `curl` the auth-issuer, the broker, or Supabase directly. If the CLI doesn't expose a verb you need, report the gap.
- Don't share or commit the `~/.unblock/comms-v3.creds` file — it's your NATS User JWT + seed; treat as a secret.
- Don't use legacy persona-prefix tags (`[alpha]`/`[beta]`) in your commits — sign as the DID short prefix or the assigned handle.

## When you hit a problem

1. `unblock health` — is the substrate alive?
2. `unblock whoami` — are you authenticated? Has the JWT expired?
3. `unblock trace <id>` — what does the audit chain say?
4. Read the error message. The CLI surfaces structured errors with `code` + a remediation hint.
5. If still stuck: `unblock ask "<question> — codes [A] [B] [abort]" --options=A,B,abort` to the operator.
