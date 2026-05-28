/**
 * Tests for the `--persona NAME` flag plumbing on login / whoami / logout.
 *
 * The flag itself is parsed by commander in `main.ts`; what matters end-to-end
 * is that when the CLI calls `setPersonaDirOverride(personaHomeFor(NAME))`,
 * the subsequent `runLogin / runWhoami / runLogout` operate on
 * `~/.unblock-personas/<NAME>/` (NOT `~/.unblock/` and NOT whatever
 * `UNBLOCK_HOME` was pointed at by the parent shell).
 *
 * Each test uses an isolated tmp dir as the persona override target so we
 * never touch the developer's real home.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  identityPath,
  readCommsEnv,
  readIdentity,
  setPersonaDirOverride,
  unblockHome,
  v3CredsPath,
  v3EnvPath,
  writeCommsCreds,
  writeCommsEnv,
  writeIdentity,
} from '../../src/auth/persona-store.js';
import { runLogin } from '../../src/commands/login.js';
import { runWhoami } from '../../src/commands/whoami.js';
import { runLogout } from '../../src/commands/logout.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
let personaDir: string;

beforeEach(async () => {
  // Two isolated dirs: `tmp` becomes UNBLOCK_HOME (the "default" persona),
  // `personaDir` becomes the --persona target. The override should win
  // even though both exist.
  tmp = await makeTmpHome();
  personaDir = await mkdtemp(path.join(tmpdir(), 'unblock-persona-'));
});
afterEach(async () => {
  setPersonaDirOverride(null);
  await rm(personaDir, { recursive: true, force: true });
  await tmp.dispose();
});

describe('--persona flag plumbing', () => {
  it('setPersonaDirOverride takes priority over UNBLOCK_HOME env', () => {
    // Default (no override): unblockHome() == tmp.home (from UNBLOCK_HOME).
    expect(unblockHome()).toBe(tmp.home);

    setPersonaDirOverride(personaDir);
    expect(unblockHome()).toBe(personaDir);

    setPersonaDirOverride(null);
    expect(unblockHome()).toBe(tmp.home);
  });

  it('runLogin writes creds + identity to the --persona dir, leaving UNBLOCK_HOME untouched', async () => {
    setPersonaDirOverride(personaDir);

    const { factory, state } = createMockSubstrateFactory();
    state.enrollResponse = {
      natsCreds: '-----BEGIN NATS USER JWT-----\nFAKE\n------END NATS USER JWT------\n',
      natsUrl: 'tls://nats.kaeva.app:39899',
      workspaceId: 'ws-persona',
      orgId: 'org-persona',
      name: 'persona-alpha',
    };

    await runLogin({ substrateFactory: factory }, { inviteCode: 'INV-PERSONA' });

    // Files landed in personaDir, not UNBLOCK_HOME.
    expect(v3CredsPath().startsWith(personaDir)).toBe(true);
    expect(v3EnvPath().startsWith(personaDir)).toBe(true);
    const creds = await readFile(v3CredsPath(), 'utf-8');
    expect(creds).toContain('-----BEGIN NATS USER JWT-----');

    // Default UNBLOCK_HOME stays empty (no leakage).
    await expect(stat(path.join(tmp.home, 'identity.json'))).rejects.toThrow();
    await expect(stat(path.join(tmp.home, 'comms-v3.creds'))).rejects.toThrow();
  });

  it('runWhoami reads only from the --persona dir when override is set', async () => {
    // Plant DIFFERENT identities in tmp.home (default) and personaDir.
    // Whichever runWhoami returns reveals which dir it read.
    await writeIdentity({
      did: 'did:key:z6MkDefaultPersona',
      agentName: 'default-persona',
      ed25519PublicKeyHex: 'a'.repeat(64),
      createdAt: '2026-05-27T00:00:00.000Z',
    });
    await writeCommsEnv({
      natsUrl: 'tls://default:1',
      credsPath: '/p/default',
      workspaceId: 'ws-default',
      orgId: 'org-default',
      chatName: 'default-persona',
    });

    // Switch to the persona override, write a DIFFERENT persona there.
    setPersonaDirOverride(personaDir);
    await writeIdentity({
      did: 'did:key:z6MkAltPersona',
      agentName: 'alt-persona',
      ed25519PublicKeyHex: 'b'.repeat(64),
      createdAt: '2026-05-27T00:00:00.000Z',
    });
    await writeCommsEnv({
      natsUrl: 'tls://alt:1',
      credsPath: '/p/alt',
      workspaceId: 'ws-alt',
      orgId: 'org-alt',
      chatName: 'alt-persona',
    });

    const res = await runWhoami();
    expect(res.loggedIn).toBe(true);
    expect(res.agentName).toBe('alt-persona');
    expect(res.workspaceId).toBe('ws-alt');

    // Sanity: clear override, default persona reappears.
    setPersonaDirOverride(null);
    const res2 = await runWhoami();
    expect(res2.agentName).toBe('default-persona');
  });

  // ─── PR-pin: --persona now applies to comms verbs (dm/send/ask/listen/say/health/chat) ─────
  //
  // Before this PR, only login/whoami/logout/mint/invite honored --persona.
  // The directive (2026-05-27 P0 cohort) extends it uniformly to comms.
  // We assert at the persona-store layer that the override chain still wins
  // for every command that needs to read `comms-v3.env` — exactly the same
  // resolution priority the login/whoami/logout tests above pin.
  it('--persona override determines which comms-v3.env runDm reads (priority over UNBLOCK_HOME)', async () => {
    // Plant DIFFERENT chat names in tmp.home (default) and personaDir.
    // Whichever subject runDm publishes from reveals which env file was read.
    await writeCommsEnv({
      natsUrl: 'tls://default:1',
      credsPath: '/p/default',
      workspaceId: 'ws-default',
      orgId: 'org-default',
      chatName: 'default-persona',
    });

    setPersonaDirOverride(personaDir);
    await writeCommsEnv({
      natsUrl: 'tls://alt:1',
      credsPath: '/p/alt',
      workspaceId: 'ws-alt',
      orgId: 'org-alt',
      chatName: 'alt-persona',
    });

    // Lazy-import so the persona-store override has already been wired before
    // the SUT loads its module-scoped dependencies.
    const { runDm } = await import('../../src/commands/dm.js');
    const { createMockCommsFactory, decodeFrame } = await import('../_fixtures/mock-comms.js');
    const { factory, state } = createMockCommsFactory();

    await runDm({ commsFactory: factory }, { to: 'target', msg: 'hi' });

    // Workspace from alt env, not default (proves --persona dir was read).
    const subjects = state.publishedFrames.map((f) => f.subject);
    expect(subjects).toContain('unblock.chat.ws.ws-alt.to.target');
    expect(subjects.every((s) => !s.includes('ws-default'))).toBe(true);

    // Source on the envelope confirms the alt chat_name was used.
    const dm = state.publishedFrames.find((f) => f.subject.endsWith('.to.target'));
    expect(dm).toBeDefined();
    if (dm === undefined) return;
    expect(decodeFrame(dm)).toMatchObject({ source: 'alt-persona' });
  });

  it('runLogout wipes only the --persona dir, not UNBLOCK_HOME', async () => {
    // Plant identity + env in BOTH dirs.
    await writeIdentity({
      did: 'did:key:z6MkDefault',
      agentName: 'default',
      ed25519PublicKeyHex: 'a'.repeat(64),
      createdAt: '2026-05-27T00:00:00.000Z',
    });
    await writeCommsCreds('default-creds\n');

    setPersonaDirOverride(personaDir);
    await writeIdentity({
      did: 'did:key:z6MkAlt',
      agentName: 'alt',
      ed25519PublicKeyHex: 'b'.repeat(64),
      createdAt: '2026-05-27T00:00:00.000Z',
    });
    await writeCommsCreds('alt-creds\n');

    // Logout while override is active -> only personaDir files vanish.
    const removed = await runLogout();
    expect(removed.removed.length).toBeGreaterThanOrEqual(2);
    for (const p of removed.removed) {
      expect(p.startsWith(personaDir)).toBe(true);
    }

    // Default UNBLOCK_HOME identity must still be present.
    setPersonaDirOverride(null);
    const stillThere = await readIdentity();
    expect(stillThere).not.toBeNull();
    expect(stillThere?.agentName).toBe('default');
    // identityPath() now resolves back to tmp.home, and the file is intact.
    const back = await readFile(identityPath(), 'utf-8');
    expect(back).toContain('did:key:z6MkDefault');

    // Persona env is gone.
    setPersonaDirOverride(personaDir);
    expect(await readCommsEnv()).toBeNull();
  });
});
