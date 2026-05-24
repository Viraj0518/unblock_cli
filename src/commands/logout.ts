/**
 * `unblock logout` — wipe local persona store. Idempotent.
 *
 * Removes:
 *   ~/.unblock/identity.json
 *   ~/.unblock/comms-v3.creds + comms-v3.env
 *   ~/.unblock/comms-v2.creds + comms-v2.env  (legacy cleanup)
 *
 * Does NOT contact the server. Server-side revocation is a separate
 * operation (`unblock revoke` or admin-side). Exit code is always 0
 * unless filesystem errors prevent any cleanup.
 */

import { wipePersonaStore } from '../auth/persona-store.js';

export interface LogoutResult {
  readonly removed: readonly string[];
}

export async function runLogout(): Promise<LogoutResult> {
  const removed = await wipePersonaStore();
  return { removed };
}
