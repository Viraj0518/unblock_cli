#!/usr/bin/env bash
#
# demo-smoke.sh — cross-AI-session memory persistence smoke test.
#
# THE DEMO LOOP, proven against the live deployment:
#   1. `unblock remember "<unique marker>"`  -> writes a block to the substrate
#   2. (fresh process = a brand-new "session"/agent invocation)
#      `unblock query "<marker>"`            -> recalls the SAME block id + content
#
# This is the core claim: context persists across AI sessions and machines.
# remember/query route through the substrate HTTP API (the `unblock-api` edge
# function, X-API-Key auth) — NOT the NATS broker — so this is testable even
# while the broker is down.
#
# What this proves / does NOT prove:
#   PROVEN  : same-API-key cross-SESSION recall (write in one process, read in a
#             separate later process). That is exactly the demo's core claim:
#             "remember in session A, recall in session B."
#   NOT HERE: cross-USER recall (persona X reads persona Y's private block).
#             That requires the explicit sharing path (`unblock share`) or two
#             keys bound to one user/bubble scope. Run with SHARE_RECIPIENT set
#             to exercise the share verb; otherwise it is skipped and reported.
#
# Reuse > rebuild: this drives the real `unblock` binary. It does NOT
# reimplement the wire protocol.
#
# Exit codes:
#   0  PASS  — block id round-tripped, content matched, top hit was our block
#   1  FAIL  — any step failed (auth / write / read / scoping / mismatch)
#
# Usage:
#   UNBLOCK_HOME=/path/to/persona ./scripts/yc-demo-smoke.sh
#   # or rely on the default persona dir (~/.unblock)
#
# Env knobs:
#   UNBLOCK_HOME        persona dir (creds + api key). Default: ~/.unblock
#   UNBLOCK_BIN         path/name of the unblock binary. Default: unblock (PATH)
#   SHARE_RECIPIENT     if set, also exercise `unblock share <blk> <recipient>`
#   QUERY_TIMEOUT_S     per-query hard timeout in seconds. Default: 90
#
set -u
set -o pipefail

BIN="${UNBLOCK_BIN:-unblock}"
QUERY_TIMEOUT_S="${QUERY_TIMEOUT_S:-90}"

# ---- helpers ---------------------------------------------------------------
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
info()  { printf '  %s\n' "$*"; }

fail() {
  red "FAIL: $*"
  echo
  red "=============================================================="
  red " DEMO SMOKE: FAIL — cross-AI-session persistence is BROKEN"
  red "=============================================================="
  exit 1
}

# Portable monotonic-ish millisecond clock (date %N is GNU; fall back to %s*1000)
now_ms() {
  local ns
  ns="$(date +%s%N 2>/dev/null)"
  case "$ns" in
    *N|"") echo "$(( $(date +%s) * 1000 ))" ;;   # no nanos -> second resolution
    *)     echo "$(( ns / 1000000 ))" ;;
  esac
}

# Run a command with a timeout if `timeout`/`gtimeout` exists; else run plain.
run_timed() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "${secs}s" "$@"
  elif command -v gtimeout >/dev/null 2>&1; then
    gtimeout "${secs}s" "$@"
  else
    "$@"
  fi
}

echo "=============================================================="
echo " DEMO SMOKE — cross-AI-session memory persistence"
echo "=============================================================="
echo

# ---- 0. preflight: identity --------------------------------------------------
echo "[0/4] preflight: who am I?"
if ! WHOAMI_OUT="$("$BIN" whoami 2>&1)"; then
  echo "$WHOAMI_OUT"
  fail "whoami failed — not logged in / bad persona (UNBLOCK_HOME=${UNBLOCK_HOME:-<unset>})"
fi
echo "$WHOAMI_OUT" | sed 's/^/  /'
echo

# ---- unique marker (safe to re-run) -----------------------------------------
MARKER="DEMO-SMOKE-$(date +%s)-$$-${RANDOM}-${RANDOM}"
CONTENT="demo smoke marker ${MARKER} :: the unblock substrate persists context across ai sessions"
info "marker:  ${MARKER}"
echo

# ---- 1. remember (write to substrate) ---------------------------------------
echo "[1/4] remember (write block to PROD substrate)"
T0="$(now_ms)"
if ! REMEMBER_OUT="$("$BIN" remember "$CONTENT" 2>&1)"; then
  echo "$REMEMBER_OUT" | sed 's/^/  /'
  fail "remember failed (write path). Check X-API-Key auth + substrate EF up."
fi
T1="$(now_ms)"
# remember prints the bare block id on stdout (e.g. blk_<32hex>)
BLOCK_ID="$(printf '%s\n' "$REMEMBER_OUT" | grep -oE 'blk_[0-9a-f]+' | head -n1)"
[ -n "$BLOCK_ID" ] || { echo "$REMEMBER_OUT" | sed 's/^/  /'; fail "could not parse block id from remember output"; }
green "  wrote block: ${BLOCK_ID}  ($(( T1 - T0 ))ms)"
echo

# ---- 2. query in a FRESH process (= new session) ----------------------------
# This is a separate `unblock` invocation: a brand-new OS process with no shared
# in-memory state. It is the literal cross-session read.
echo "[2/4] query in a FRESH process (new session) — proving cross-session recall"
T2="$(now_ms)"
if ! QUERY_OUT="$(run_timed "$QUERY_TIMEOUT_S" "$BIN" query "$MARKER" --json --top-k 5 2>&1)"; then
  echo "$QUERY_OUT" | sed 's/^/  /'
  fail "query failed or timed out after ${QUERY_TIMEOUT_S}s (read path)."
fi
T3="$(now_ms)"
echo "$QUERY_OUT" | sed 's/^/  /'
echo
green "  query latency: $(( T3 - T2 ))ms"
echo

# ---- 3. assert: same block id came back, as the top hit, with our content ----
echo "[3/4] assert round-trip integrity"

# top hit block id
TOP_ID="$(printf '%s' "$QUERY_OUT" | grep -oE 'blk_[0-9a-f]+' | head -n1)"
info "top hit block id: ${TOP_ID:-<none>}"

[ -n "$TOP_ID" ] || fail "query returned no block ids"
[ "$TOP_ID" = "$BLOCK_ID" ] || fail "top hit ${TOP_ID} != written block ${BLOCK_ID} (scoping/ranking broke)"

# our marker must appear in the snippet/content of the response
printf '%s' "$QUERY_OUT" | grep -qF "$MARKER" \
  || fail "written marker not found in query response content (content not round-tripped)"

green "  OK: top hit == written block id, and content matched"
echo

# ---- 4. (optional) cross-USER recall via share ------------------------------
echo "[4/4] cross-USER recall (sharing path)"
if [ -n "${SHARE_RECIPIENT:-}" ]; then
  info "SHARE_RECIPIENT=${SHARE_RECIPIENT} — exercising \`unblock share\`"
  if SHARE_OUT="$("$BIN" share "$BLOCK_ID" "$SHARE_RECIPIENT" 2>&1)"; then
    echo "$SHARE_OUT" | sed 's/^/  /'
    green "  share verb returned OK (recipient-side read not asserted here)"
  else
    echo "$SHARE_OUT" | sed 's/^/  /'
    red  "  share verb FAILED — cross-user path not yet wired (non-fatal for this LT)"
  fi
else
  info "SKIPPED — no SHARE_RECIPIENT set."
  info "PROVEN here: same-key cross-SESSION recall (the demo's core claim)."
  info "NOT proven : cross-USER recall — needs \`unblock share\` or a second"
  info "             key bound to the same user/bubble scope."
fi
echo

green "=============================================================="
green " DEMO SMOKE: PASS"
green "   wrote ${BLOCK_ID}, recalled it from a fresh process,"
green "   top-hit + content matched. Cross-AI-session persistence WORKS."
green "=============================================================="
exit 0
