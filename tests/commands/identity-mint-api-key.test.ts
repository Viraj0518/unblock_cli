/**
 * Tests for `unblock identity mint-api-key` (kink #136 backfill).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { main } from '../../src/main.js';
import {
  AlreadyPresentError,
  runMintApiKey,
  replaceOrAppendApiKey,
} from '../../src/commands/identity-mint-api-key.js';
import {
  personaHomeFor,
  setPersonaDirOverride,
} from '../../src/auth/persona-store.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;
const personaDirs: string[] = [];

beforeEach(async () => {
  tmp = await makeTmpHome();
});

afterEach(async () => {
  setPersonaDirOverride(null);
  for (const dir of personaDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
  await tmp.dispose();
});

describe('unblock identity mint-api-key', () => {
  it('mints + persists api_key on first run; INSERTs members + api_keys via Supabase REST', async () => {
    const persona = uniquePersona('mint');
    const { envPath } = await seedPersonaIdentity(persona, {
      did: 'did:key:z6MkVirajAlpha',
      agentName: 'Viraj-Alpha',
      orgId: 'did:web:unblock.kaeva.app',
    });
    setPersonaDirOverride(personaHomeFor(persona));

    const calls: Array<{ url: string; body: unknown; method: string }> = [];
    const mockFetcher = makeMockFetcher(async (input, init) => {
      const url = typeof input === 'string' ? input : String(input);
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      });
      return new Response('', { status: 201 });
    });

    const result = await runMintApiKey(
      { fetcher: mockFetcher, randomBytes32: () => Buffer.alloc(32, 0x42) },
      {
        persona,
        supabaseServiceRoleKey: 'service-role-key',
        supabaseUrl: 'https://example.supabase.co',
      },
    );

    // Action + shape
    expect(result.action).toBe('minted');
    expect(result.did).toBe('did:key:z6MkVirajAlpha');
    expect(result.orgDid).toBe('did:web:unblock.kaeva.app');
    expect(result.apiKey).toMatch(/^unb_[0-9a-f]{64}$/);
    // Deterministic key from 32 0x42 bytes
    const expectedKey = `unb_${'42'.repeat(32)}`;
    expect(result.apiKey).toBe(expectedKey);
    expect(result.apiKeyId).toBe(`akey_backfill_${'42'.repeat(8)}`);

    // Two REST calls — members first (FK target), then api_keys
    expect(calls).toHaveLength(2);
    expect(calls[0]?.url).toBe('https://example.supabase.co/rest/v1/members');
    expect(calls[1]?.url).toBe('https://example.supabase.co/rest/v1/api_keys');

    // members body shape
    const memberBody = calls[0]?.body as Array<Record<string, unknown>>;
    expect(memberBody[0]).toMatchObject({
      member_did: 'did:key:z6MkVirajAlpha',
      org_did: 'did:web:unblock.kaeva.app',
      kind: 'agent',
      display_name: 'Viraj-Alpha',
      status: 'active',
    });

    // api_keys body shape
    const apiKeyBody = calls[1]?.body as Array<Record<string, unknown>>;
    const expectedSha = createHash('sha256').update(expectedKey, 'utf-8').digest('hex');
    expect(apiKeyBody[0]).toMatchObject({
      api_key_id: `akey_backfill_${'42'.repeat(8)}`,
      org_did: 'did:web:unblock.kaeva.app',
      owner_did: 'did:key:z6MkVirajAlpha',
      key_sha256: expectedSha,
      display_name: 'manual backfill via mint-api-key',
      is_root: false,
      purpose: 'agent',
    });

    // env file rewritten with UNBLOCK_API_KEY appended
    const after = await readFile(envPath, 'utf-8');
    expect(after).toContain(`UNBLOCK_API_KEY=${expectedKey}`);
    // Other lines preserved
    expect(after).toContain('UNBLOCK_ORG_ID=did:web:unblock.kaeva.app');
    expect(after).toContain('UNBLOCK_CHAT_NAME=viraj-alpha');
  });

  it('idempotent: second run without --force throws AlreadyPresentError', async () => {
    const persona = uniquePersona('idempotent');
    await seedPersonaIdentity(persona, {
      did: 'did:key:z6MkExisting',
      agentName: 'Existing-Persona',
      orgId: 'did:web:unblock.kaeva.app',
      extraEnvLines: [`UNBLOCK_API_KEY=unb_${'aa'.repeat(32)}`],
    });
    setPersonaDirOverride(personaHomeFor(persona));

    const mockFetcher = makeMockFetcher(async () => new Response('', { status: 201 }));

    await expect(
      runMintApiKey(
        { fetcher: mockFetcher, randomBytes32: () => Buffer.alloc(32, 0x99) },
        {
          persona,
          supabaseServiceRoleKey: 'service-role-key',
          supabaseUrl: 'https://example.supabase.co',
        },
      ),
    ).rejects.toBeInstanceOf(AlreadyPresentError);
  });

  it('--force overwrites the existing UNBLOCK_API_KEY line', async () => {
    const persona = uniquePersona('force');
    const oldKey = `unb_${'aa'.repeat(32)}`;
    const { envPath } = await seedPersonaIdentity(persona, {
      did: 'did:key:z6MkForce',
      agentName: 'Force-Persona',
      orgId: 'did:web:unblock.kaeva.app',
      extraEnvLines: [`UNBLOCK_API_KEY=${oldKey}`],
    });
    setPersonaDirOverride(personaHomeFor(persona));

    const mockFetcher = makeMockFetcher(async () => new Response('', { status: 201 }));

    const result = await runMintApiKey(
      { fetcher: mockFetcher, randomBytes32: () => Buffer.alloc(32, 0x11) },
      {
        persona,
        force: true,
        supabaseServiceRoleKey: 'service-role-key',
        supabaseUrl: 'https://example.supabase.co',
      },
    );

    expect(result.action).toBe('minted');
    const newKey = `unb_${'11'.repeat(32)}`;
    expect(result.apiKey).toBe(newKey);
    const after = await readFile(envPath, 'utf-8');
    expect(after).toContain(`UNBLOCK_API_KEY=${newKey}`);
    expect(after).not.toContain(oldKey);
  });

  it('missing SUPABASE_SERVICE_ROLE_KEY falls back to SQL stdout (action=sql_only)', async () => {
    const persona = uniquePersona('sql');
    const { envPath } = await seedPersonaIdentity(persona, {
      did: 'did:key:z6MkSql',
      agentName: 'SQL-Persona',
      orgId: 'did:web:unblock.kaeva.app',
    });
    setPersonaDirOverride(personaHomeFor(persona));
    const beforeEnv = await readFile(envPath, 'utf-8');

    const prevSrv = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];

    // Block the fetcher entirely — if we accidentally call it in the
    // fallback path, the test will fail loudly.
    const mockFetcher = makeMockFetcher(async () => {
      throw new Error('fetcher must not be called when SUPABASE_SERVICE_ROLE_KEY is missing');
    });

    try {
      const result = await runMintApiKey(
        { fetcher: mockFetcher, randomBytes32: () => Buffer.alloc(32, 0x33) },
        { persona },
      );
      expect(result.action).toBe('sql_only');
      expect(result.sql).toContain('INSERT INTO public.members');
      expect(result.sql).toContain('INSERT INTO public.api_keys');
      expect(result.sql).toContain('did:key:z6MkSql');
      expect(result.sql).toContain('did:web:unblock.kaeva.app');
      expect(result.sql).toContain('ON CONFLICT');
      // Env file must NOT be rewritten in the fallback path — the key
      // hasn't been registered server-side yet.
      expect(await readFile(envPath, 'utf-8')).toBe(beforeEnv);
    } finally {
      if (prevSrv !== undefined) process.env['SUPABASE_SERVICE_ROLE_KEY'] = prevSrv;
    }
  });

  it('--json emits the documented shape via the CLI surface', async () => {
    const persona = uniquePersona('json');
    await seedPersonaIdentity(persona, {
      did: 'did:key:z6MkJson',
      agentName: 'Json-Persona',
      orgId: 'did:web:unblock.kaeva.app',
    });

    // Force the SQL fallback path (no service-role key) so the CLI
    // surface test stays hermetic and avoids any real network calls.
    const prevSrv = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
    try {
      const { code, stdout } = await runMainCapturingStdout([
        'identity',
        'mint-api-key',
        '--persona',
        persona,
        '--json',
      ]);
      expect(code).toBe(0);
      const parsed = JSON.parse(stdout) as Record<string, unknown>;
      expect(parsed['persona']).toBe(persona);
      expect(parsed['did']).toBe('did:key:z6MkJson');
      expect(parsed['org_did']).toBe('did:web:unblock.kaeva.app');
      expect(parsed['action']).toBe('sql_only');
      expect(typeof parsed['api_key_id']).toBe('string');
      expect(typeof parsed['env_path']).toBe('string');
      expect(typeof parsed['sql']).toBe('string');
    } finally {
      if (prevSrv !== undefined) process.env['SUPABASE_SERVICE_ROLE_KEY'] = prevSrv;
    }
  });

  it('handles 4xx from Supabase REST as an error (preserves env)', async () => {
    const persona = uniquePersona('4xx');
    const { envPath } = await seedPersonaIdentity(persona, {
      did: 'did:key:z6MkErr',
      agentName: 'Err-Persona',
      orgId: 'did:web:unblock.kaeva.app',
    });
    setPersonaDirOverride(personaHomeFor(persona));
    const beforeEnv = await readFile(envPath, 'utf-8');

    const mockFetcher = makeMockFetcher(async () =>
      new Response('{"message":"violates foreign key"}', { status: 409 }),
    );

    await expect(
      runMintApiKey(
        { fetcher: mockFetcher, randomBytes32: () => Buffer.alloc(32, 0x44) },
        {
          persona,
          supabaseServiceRoleKey: 'sk',
          supabaseUrl: 'https://example.supabase.co',
        },
      ),
    ).rejects.toThrow(/failed to upsert members row/);

    // Env file untouched on failure
    expect(await readFile(envPath, 'utf-8')).toBe(beforeEnv);
  });

  it('CLI exit code: 2 when api key already present (without --force)', async () => {
    const persona = uniquePersona('exit-2');
    await seedPersonaIdentity(persona, {
      did: 'did:key:z6MkAlready',
      agentName: 'Already-Persona',
      orgId: 'did:web:unblock.kaeva.app',
      extraEnvLines: [`UNBLOCK_API_KEY=unb_${'bb'.repeat(32)}`],
    });

    const { code, stderr } = await runMainCapturingBoth([
      'identity',
      'mint-api-key',
      '--persona',
      persona,
    ]);

    expect(code).toBe(2);
    expect(stderr).toContain('UNBLOCK_API_KEY already present');
  });

  it('CLI honors --persona dir routing without UNBLOCK_HOME pollution', async () => {
    const personaA = uniquePersona('routing-a');
    const personaB = uniquePersona('routing-b');
    await seedPersonaIdentity(personaA, {
      did: 'did:key:z6MkPersonaA',
      agentName: 'PersonaA',
      orgId: 'did:web:unblock.kaeva.app',
    });
    await seedPersonaIdentity(personaB, {
      did: 'did:key:z6MkPersonaB',
      agentName: 'PersonaB',
      orgId: 'did:web:unblock.kaeva.app',
    });

    // SQL-only path keeps the test hermetic; we just verify routing.
    const prevSrv = process.env['SUPABASE_SERVICE_ROLE_KEY'];
    delete process.env['SUPABASE_SERVICE_ROLE_KEY'];
    try {
      const { code: codeA, stdout: stdoutA } = await runMainCapturingStdout([
        'identity',
        'mint-api-key',
        '--persona',
        personaA,
        '--json',
      ]);
      const { code: codeB, stdout: stdoutB } = await runMainCapturingStdout([
        'identity',
        'mint-api-key',
        '--persona',
        personaB,
        '--json',
      ]);
      const parsedA = JSON.parse(stdoutA) as Record<string, unknown>;
      const parsedB = JSON.parse(stdoutB) as Record<string, unknown>;
      expect(codeA).toBe(0);
      expect(codeB).toBe(0);
      expect(parsedA['did']).toBe('did:key:z6MkPersonaA');
      expect(parsedB['did']).toBe('did:key:z6MkPersonaB');
      // env_path should differ per persona dir
      expect(parsedA['env_path']).not.toBe(parsedB['env_path']);
    } finally {
      if (prevSrv !== undefined) process.env['SUPABASE_SERVICE_ROLE_KEY'] = prevSrv;
    }
  });
});

describe('replaceOrAppendApiKey (idempotent env-file edit)', () => {
  it('replaces an existing UNBLOCK_API_KEY line', () => {
    const before = [
      '# header',
      'UNBLOCK_NATS_URL=tls://x:1',
      'UNBLOCK_API_KEY=unb_oldoldoldold',
      'UNBLOCK_ORG_ID=org-x',
      '',
    ].join('\n');
    const out = replaceOrAppendApiKey(before, 'unb_newnewnewnew');
    expect(out).toContain('UNBLOCK_API_KEY=unb_newnewnewnew');
    expect(out).not.toContain('UNBLOCK_API_KEY=unb_oldoldoldold');
    expect(out).toContain('UNBLOCK_ORG_ID=org-x');
  });

  it('appends UNBLOCK_API_KEY when missing, preserving LF terminator', () => {
    const before = ['UNBLOCK_NATS_URL=tls://x:1', 'UNBLOCK_ORG_ID=org-x', ''].join('\n');
    const out = replaceOrAppendApiKey(before, 'unb_keykey');
    expect(out.endsWith('UNBLOCK_API_KEY=unb_keykey\n')).toBe(true);
    expect(out).toContain('UNBLOCK_ORG_ID=org-x');
  });

  it('preserves CRLF line endings when appending', () => {
    const before = 'UNBLOCK_NATS_URL=tls://x:1\r\nUNBLOCK_ORG_ID=org-x\r\n';
    const out = replaceOrAppendApiKey(before, 'unb_crlf');
    expect(out.endsWith('UNBLOCK_API_KEY=unb_crlf\r\n')).toBe(true);
  });
});

// ─── helpers ────────────────────────────────────────────────────────────────

function uniquePersona(prefix: string): string {
  return `mint-api-key-${prefix}-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

async function seedPersonaIdentity(
  persona: string,
  input: {
    readonly did: string;
    readonly agentName: string;
    readonly orgId: string;
    readonly extraEnvLines?: readonly string[];
  },
): Promise<{ readonly envPath: string; readonly identityPath: string }> {
  const dir = personaHomeFor(persona);
  personaDirs.push(dir);
  await mkdir(dir, { recursive: true });

  const identityPath = path.join(dir, 'identity.json');
  await writeFile(
    identityPath,
    `${JSON.stringify(
      {
        did: input.did,
        agentName: input.agentName,
        ed25519PublicKeyHex: 'a'.repeat(64),
        createdAt: '2026-05-20T00:00:00.000Z',
      },
      null,
      2,
    )}\n`,
    'utf-8',
  );

  const envPath = path.join(dir, 'comms-v3.env');
  // Lowercased chat name matches what `unblock identity normalize` produces.
  const chatName = input.agentName.toLowerCase();
  await writeFile(
    envPath,
    [
      '# seed env',
      'UNBLOCK_NATS_URL=tls://nats.kaeva.app:39899',
      `UNBLOCK_NATS_CREDS=${path.join(dir, 'comms-v3.creds')}`,
      'UNBLOCK_WORKSPACE_ID=ws-seed',
      `UNBLOCK_ORG_ID=${input.orgId}`,
      `UNBLOCK_CHAT_NAME=${chatName}`,
      ...(input.extraEnvLines ?? []),
      '',
    ].join('\n'),
    'utf-8',
  );
  return { envPath, identityPath };
}

function makeMockFetcher(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): typeof globalThis.fetch {
  const f: typeof globalThis.fetch = async (input, init) => handler(input, init);
  return f;
}

async function runMainCapturingStdout(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
}> {
  const originalWrite = process.stdout.write;
  const originalExitCode = process.exitCode;
  let stdout = '';
  process.exitCode = undefined;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf-8');
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await main(argv);
    return { code, stdout };
  } finally {
    process.stdout.write = originalWrite;
    process.exitCode = originalExitCode;
  }
}

async function runMainCapturingBoth(argv: readonly string[]): Promise<{
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  const originalStdoutWrite = process.stdout.write;
  const originalStderrWrite = process.stderr.write;
  const originalExitCode = process.exitCode;
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
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exitCode = originalExitCode;
  }
}
