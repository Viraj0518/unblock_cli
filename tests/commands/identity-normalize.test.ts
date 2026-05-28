import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Buffer } from 'node:buffer';
import { main } from '../../src/main.js';
import { personaHomeFor, setPersonaDirOverride, writeCommsEnv } from '../../src/auth/persona-store.js';
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

describe('unblock identity normalize', () => {
  it('dry-runs by default and does not write comms-v3.env', async () => {
    const persona = uniquePersona('dry-run');
    const envPath = await seedPersonaEnv(persona, {
      workspaceId: 'WS',
      chatName: 'Viraj-Alpha',
      extraLines: ['UNBLOCK_API_KEY=unb_' + 'a'.repeat(64)],
    });
    const before = await readFile(envPath, 'utf-8');

    const { code, stdout } = await runMainCapturingStdout([
      'identity',
      'normalize',
      '--persona',
      persona,
    ]);

    expect(code).toBe(0);
    expect(await readFile(envPath, 'utf-8')).toBe(before);
    expect(stdout).toContain('would change UNBLOCK_CHAT_NAME from Viraj-Alpha to viraj-alpha');
    expect(stdout).toContain('legacy DM history remains queryable at the old subject');
    expect(stdout).toContain('unblock listen --subject unblock.chat.ws.WS.to.Viraj-Alpha --since 30d');
  });

  it('--apply writes the normalized chat name and preserves other lines', async () => {
    const persona = uniquePersona('apply');
    const envPath = await seedPersonaEnv(persona, {
      workspaceId: 'ws-apply',
      chatName: 'Codex-W1D',
      extraLines: ['UNBLOCK_JWT_EXPIRES_AT=2026-06-27T00:00:00.000Z'],
    });

    const { code, stdout } = await runMainCapturingStdout([
      'identity',
      'normalize',
      '--persona',
      persona,
      '--apply',
    ]);

    const after = await readFile(envPath, 'utf-8');
    expect(code).toBe(0);
    expect(stdout).toContain('changed UNBLOCK_CHAT_NAME from Codex-W1D to codex-w1d');
    expect(after).toContain('UNBLOCK_CHAT_NAME=codex-w1d');
    expect(after).toContain('UNBLOCK_JWT_EXPIRES_AT=2026-06-27T00:00:00.000Z');
    expect(after).toContain('UNBLOCK_ORG_ID=org-test');
  });

  it('already-lowercase chat names are a no-op', async () => {
    const persona = uniquePersona('noop');
    const envPath = await seedPersonaEnv(persona, {
      workspaceId: 'ws-noop',
      chatName: 'codex-w1d',
    });
    const before = await readFile(envPath, 'utf-8');

    const { code, stdout } = await runMainCapturingStdout([
      'identity',
      'normalize',
      '--persona',
      persona,
      '--apply',
    ]);

    expect(code).toBe(0);
    expect(stdout).toBe('already normalized: UNBLOCK_CHAT_NAME=codex-w1d\n');
    expect(await readFile(envPath, 'utf-8')).toBe(before);
  });

  it('--json emits the structured D2.3 shape', async () => {
    const persona = uniquePersona('json');
    await seedPersonaEnv(persona, {
      workspaceId: 'ws-json',
      chatName: 'JSON-Alpha',
    });

    const { code, stdout } = await runMainCapturingStdout([
      'identity',
      'normalize',
      '--persona',
      persona,
      '--json',
    ]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(Object.keys(parsed).sort()).toEqual([
      'drain_subject_legacy',
      'drain_subject_new',
      'new_chat_name',
      'old_chat_name',
      'persona',
      'would_change',
    ]);
    expect(parsed).toEqual({
      persona,
      old_chat_name: 'JSON-Alpha',
      new_chat_name: 'json-alpha',
      would_change: true,
      drain_subject_legacy: 'unblock.chat.ws.ws-json.to.JSON-Alpha',
      drain_subject_new: 'unblock.chat.ws.ws-json.to.json-alpha',
    });
  });

  it('--persona routes to ~/.unblock-personas/<NAME>/ instead of UNBLOCK_HOME', async () => {
    await writeCommsEnv({
      natsUrl: 'tls://default:1',
      credsPath: '/default/creds',
      workspaceId: 'ws-default',
      orgId: 'org-default',
      chatName: 'default-name',
    });
    const persona = uniquePersona('route');
    await seedPersonaEnv(persona, {
      workspaceId: 'ws-persona',
      chatName: 'Persona-Route',
    });

    const { code, stdout } = await runMainCapturingStdout([
      'identity',
      'normalize',
      '--persona',
      persona,
      '--json',
    ]);
    const parsed = JSON.parse(stdout) as Record<string, unknown>;

    expect(code).toBe(0);
    expect(parsed['old_chat_name']).toBe('Persona-Route');
    expect(parsed['drain_subject_new']).toBe('unblock.chat.ws.ws-persona.to.persona-route');
  });
});

function uniquePersona(prefix: string): string {
  return `identity-normalize-${prefix}-${process.pid}-${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}`;
}

async function seedPersonaEnv(
  persona: string,
  input: {
    readonly workspaceId: string;
    readonly chatName: string;
    readonly extraLines?: readonly string[];
  },
): Promise<string> {
  const dir = personaHomeFor(persona);
  personaDirs.push(dir);
  await mkdir(dir, { recursive: true });
  const envPath = path.join(dir, 'comms-v3.env');
  await writeFile(
    envPath,
    [
      '# test env',
      'UNBLOCK_NATS_URL=tls://nats.kaeva.app:39899',
      `UNBLOCK_NATS_CREDS=${path.join(dir, 'comms-v3.creds')}`,
      `UNBLOCK_WORKSPACE_ID=${input.workspaceId}`,
      'UNBLOCK_ORG_ID=org-test',
      `UNBLOCK_CHAT_NAME=${input.chatName}`,
      ...(input.extraLines ?? []),
      '',
    ].join('\n'),
    'utf-8',
  );
  return envPath;
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
