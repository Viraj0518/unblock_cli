# ADR-0003 — workspace_id = org slug, not "default"

**Date:** 2026-05-27
**Status:** Accepted

## Context

`unblock say` and all other chat commands (`dm`, `ask`, `chat`) failed with
`BAD_CREDS` when connecting to the NATS broker, even with a freshly-minted
30-day JWT.

The deployed auth-issuer (`auth.kaeva.app`) sets the JWT's
`nats.pub.allow` to `["unblock.chat.ws.<org_slug>.>", ...]` where
`org_slug` is derived from the org's DID via:

```
did:web:unblock.kaeva.app  → unblock
did:web:acme.kaeva.app     → acme
plain slug "unblock"       → unblock  (passthrough — no colon/slash)
```

A credential bootstrap script was writing `UNBLOCK_WORKSPACE_ID=default`
hard-coded to `~/.unblock/comms-v3.env`.

The CLI reads `workspaceId` from `comms-v3.env` and constructs the publish
subject as `unblock.chat.ws.<workspaceId>.firehose`. With `workspaceId="default"`
the subject was `unblock.chat.ws.default.firehose`, which does NOT match the
JWT's `pub.allow` pattern `unblock.chat.ws.unblock.>`. The NATS broker
correctly rejects this with `BAD_CREDS`.

### Why the test suite didn't catch it

The existing `say.test.ts` used a mock NATS client and an arbitrary
`workspaceId: 'ws-default'` in the test fixture — it never asserted that
the workspace_id in `comms-v3.env` must equal the org slug embedded in the
JWT's allow-list. The regression tests added in this fix cover exactly that
contract.

### Not a JWT/operator chain issue

The JWT itself is structurally correct. The operator/account/user chain is
valid. Decoding the JWT confirms:
- `pub.allow` contains `unblock.chat.ws.unblock.>` ✓
- `exp` is 30 days from issue ✓
- The broker is reachable (TLS handshake succeeds) ✓

The error is purely a subject mismatch between what the JWT allows and what
the CLI publishes.

## Decision

**`workspace_id` written to `comms-v3.env` MUST equal the org slug derived
from `org_did`, matching the subject pattern the auth-issuer bakes into the
JWT.**

The derivation function is:
```python
import re
def derive_workspace_id(org_did: str) -> str:
    m = re.match(r'^did:web:([^.]+)\.kaeva\.app$', org_did)
    return m.group(1) if m else org_did
```

This mirrors the `deriveOrgId()` / `workspaceIdFromOrgDid()` helpers in the
deployed auth-issuer.

### Canonical source of workspace_id

| Path | Source | Notes |
|---|---|---|
| `unblock login <invite-code>` | `workspace_id` from `/v1/identity/enroll` response | Correct — server sets it |
| credential bootstrap script | `derive_workspace_id(ORG_DID)` | Fixed in this ADR |
| CLI flag `--workspace-id` | explicit override | Wins over env |
| `UNBLOCK_WORKSPACE_ID` env | process env | Wins over comms-v3.env |
| `comms-v3.env` | written at login/mint time | Must be org slug |
| fallback | `"default"` in config.ts | Used only when no env/file |

The fallback `"default"` in `config.ts` is the same pre-existing behavior.
It is intentionally kept for isolated local dev without a login. It will NOT
match any production JWT's allow-list and will correctly surface as BAD_CREDS
rather than silently publishing to a wrong subject — this is the intended
crash-early fail-fast behavior.

## Consequences

- All agents and humans running `unblock say/dm/ask/chat` after re-running the
  bootstrap script (or re-running `unblock login`) will have the correct
  workspace_id and publish succeeds.
- The bootstrap script now self-documents the derivation rule in
  `derive_workspace_id()`.
- Two regression tests in `say.test.ts` enforce this contract going forward.
- No auth-issuer changes required — the issuer was correct all along.
- No broker changes required.

## Related

- The auth-issuer's NATS token issuance and subject-derivation helpers.
- The `/v1/identity/enroll` wave that returns `workspace_id` to the CLI.
