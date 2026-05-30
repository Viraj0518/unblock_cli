# Demo Smoke — Results (cross-AI-session memory persistence)

> The demo's core loop — `remember` in one AI session, `query`/recall it from
> a **fresh** session — proven against the live deployment.

## TL;DR

**PASS.** First-ever real end-to-end proof of the substrate round-trip.
Every prior test in the fleet is mocked; this hits the live Supabase
`unblock-api` edge function with a real `X-API-Key` and a real embedding/query.

## What was run

- Driver: the live `unblock` binary (no reimplementation).
- Persona: an enrolled `did:key` persona, workspace/org `unblock`.
- Substrate target: the deployed `unblock-api` edge function
  (`/v1/remember` + `/v1/query`, `X-API-Key` auth — **not** the NATS broker,
  which was down at test time and is irrelevant to this loop).
- Date: 2026-05-28.

## Evidence (actual, from `scripts/demo-smoke.sh`)

| step | result |
|------|--------|
| `whoami` | OK — enrolled persona, jwt valid to 2026-06-27 |
| `remember` (write) | block `blk_402414085c3a4401030766ca1b1c9b5a`, **3,635 ms** |
| `query` in a **fresh process** (= new session) | **23,777 ms**, top hit = the written block |
| assert top-hit id == written id | OK |
| assert written content round-tripped | OK (score **0.9987**) |
| exit code | **0 (PASS)** |

A second, independent earlier run (marker `…1780034924…`, block
`blk_4dc3ab2bd65c16c05deb87269b6d0b77`) also appears in later query results —
confirming blocks **persist across separate invocations**, not just within one
script run. Manual warm re-query of the same marker returned in **8.6 s**.

## What this proves vs. does NOT prove

- **PROVEN — same-key cross-SESSION recall.** Write in process A, read in a
  separate later process B. This is exactly the demo claim: "remember in
  session A, recall in session B / on another machine." The two processes
  share nothing in memory; the only thing connecting them is the substrate.
- **NOT proven here — cross-USER recall.** persona X reading persona Y's
  *private* block requires the sharing path (`unblock share <blk> <recipient>`)
  or two API keys bound to one user/bubble scope. The smoke script exercises
  `unblock share` when `SHARE_RECIPIENT` is set; left unset it is skipped and
  explicitly reported (no silent pass).

## Honesty notes / risks for the demo

- **Query latency is high and variable** (cold 24–44 s, warm ~9 s). For a live
  demo this is a UX risk — pre-warm the path or have a recorded fallback.
  The write path is fast (~3.6 s).
- The loop depends on the substrate EF + Supabase being up. The NATS broker
  being down does **not** affect remember/query.

## Re-run

```bash
UNBLOCK_HOME=/path/to/persona ./scripts/demo-smoke.sh        # PASS -> exit 0
SHARE_RECIPIENT=some-persona UNBLOCK_HOME=… ./scripts/demo-smoke.sh  # also test share
```

Markers are unique per run, so it is safe to run repeatedly.
The FAIL path was verified too: pointing at a non-enrolled persona exits **1**.
