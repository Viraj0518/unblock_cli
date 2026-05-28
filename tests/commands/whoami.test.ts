import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runWhoami } from '../../src/commands/whoami.js';
import { main } from '../../src/main.js';
import {
  writeCommsCreds,
  writeCommsEnv,
  writeIdentity,
} from '../../src/auth/persona-store.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';
import { Buffer } from 'node:buffer';

let tmp: TmpHome;
beforeEach(async () => {
  tmp = await makeTmpHome();
});
afterEach(async () => {
  await tmp.dispose();
});

function makeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ed25519' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.sig`;
}

describe('runWhoami', () => {
  it('returns not-logged-in when nothing exists', async () => {
    const res = await runWhoami();
    expect(res.loggedIn).toBe(false);
    expect(res.lines.join('\n')).toContain('not logged in');
  });

  it('returns full identity when persona is configured', async () => {
    await writeIdentity({
      did: 'did:key:z6MkfakeFakeFakeFakeFakeFakeFakeFake',
      agentName: 'Viraj-Alpha',
      ed25519PublicKeyHex: 'aa'.repeat(32),
      createdAt: '2026-05-24T00:00:00.000Z',
    });
    await writeCommsEnv({
      natsUrl: 'tls://nats.kaeva.app:39899',
      credsPath: '/path/creds',
      workspaceId: 'ws-default',
      orgId: 'org-test',
      chatName: 'Viraj-Alpha',
    });
    const jwt = makeJwt({ name: 'Viraj-Alpha', exp: 4102444800 }); // 2100-01-01
    await writeCommsCreds(
      `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n`,
    );

    const res = await runWhoami();
    expect(res.loggedIn).toBe(true);
    expect(res.did).toMatch(/^did:key:z/);
    expect(res.broker).toBe('tls://nats.kaeva.app:39899');
    expect(res.workspaceId).toBe('ws-default');
    expect(res.orgId).toBe('org-test');
    expect(res.jwtExpiresAt).toMatch(/^\d{4}-/);
    expect(res.jwtExpiresInSeconds).toBeGreaterThan(0);
  });

  it('CLI: `whoami --json` emits the identity fields as JSON', async () => {
    await writeIdentity({
      did: 'did:key:z6MkfakeFakeFakeFakeFakeFakeFakeFake',
      agentName: 'Viraj-Beta',
      ed25519PublicKeyHex: 'bb'.repeat(32),
      createdAt: '2026-05-28T00:00:00.000Z',
    });
    await writeCommsEnv({
      natsUrl: 'tls://nats.kaeva.app:39899',
      credsPath: '/path/creds',
      workspaceId: 'ws-beta',
      orgId: 'org-beta',
      chatName: 'Viraj-Beta',
    });
    const jwt = makeJwt({ name: 'Viraj-Beta', exp: 4102444800 }); // 2100-01-01
    await writeCommsCreds(
      `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n`,
    );

    const { code, stdout, stderr } = await runMainCapturing(['whoami', '--json']);

    expect(code).toBe(0);
    expect(stderr).toBe('');
    const parsed = JSON.parse(stdout) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      did: 'did:key:z6MkfakeFakeFakeFakeFakeFakeFakeFake',
      handle: 'Viraj-Beta',
      chat_name: 'Viraj-Beta',
      broker: 'tls://nats.kaeva.app:39899',
      workspace: 'ws-beta',
      org: 'org-beta',
      jwt_expiry: '2100-01-01T00:00:00.000Z',
    });
    expect(typeof parsed['jwt_expires_in_seconds']).toBe('number');
    expect(parsed['jwt_expires_in_seconds']).toBeGreaterThan(0);
  });
});

async function runMainCapturing(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const origStdoutWrite = process.stdout.write;
  const origStderrWrite = process.stderr.write;
  const origExitCode = process.exitCode;
  let stdout = '';
  let stderr = '';
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = origStdoutWrite;
    process.stderr.write = origStderrWrite;
    process.exitCode = origExitCode;
  }
}
