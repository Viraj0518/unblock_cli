import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Buffer } from 'node:buffer';
import path from 'node:path';
import { main } from '../../src/main.js';
import { personaHomeFor, v3CredsPath, writeCommsCreds, writeCommsEnv } from '../../src/auth/persona-store.js';
import { runSubjects } from '../../src/commands/subjects.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;

beforeEach(async () => {
  tmp = await makeTmpHome();
});

afterEach(async () => {
  await tmp.dispose();
});

describe('runSubjects', () => {
  it('returns JSON-ready output with all 8 required fields', async () => {
    await seedCurrentPersona({
      workspaceId: 'ws-default',
      chatName: 'Viraj-Alpha',
      jwtPayload: {
        name: 'Viraj-Alpha',
        nats: {
          pub: { allow: ['unblock.chat.ws.ws-default.firehose'] },
          sub: { allow: ['unblock.chat.ws.ws-default.to.viraj-alpha'] },
        },
      },
    });

    const result = await runSubjects();

    expect(Object.keys(result).sort()).toEqual([
      'canonical_chat_name',
      'channel_subject_examples',
      'dm_inbox_subject',
      'firehose_subject',
      'jwt_pub_allow',
      'jwt_sub_allow',
      'resolved_creds_path',
      'resolved_env_path',
    ]);
    expect(result).toMatchObject({
      canonical_chat_name: 'viraj-alpha',
      dm_inbox_subject: 'unblock.chat.ws.ws-default.to.viraj-alpha',
      firehose_subject: 'unblock.chat.ws.ws-default.firehose',
      channel_subject_examples: ['unblock.channel.NAME.>'],
      resolved_creds_path: v3CredsPath(),
    });
  });

  it('extracts nats.pub.allow and nats.sub.allow from the User JWT payload', async () => {
    await seedCurrentPersona({
      workspaceId: 'ws-jwt',
      chatName: 'wave-one',
      jwtPayload: {
        name: 'wave-one',
        nats: {
          pub: { allow: ['unblock.chat.ws.ws-jwt.firehose', 'unblock.channel.ops.>'] },
          sub: { allow: ['unblock.chat.ws.ws-jwt.to.wave-one', 'unblock.events.>'] },
        },
      },
    });

    const result = await runSubjects();

    expect(result.jwt_pub_allow).toEqual([
      'unblock.chat.ws.ws-jwt.firehose',
      'unblock.channel.ops.>',
    ]);
    expect(result.jwt_sub_allow).toEqual([
      'unblock.chat.ws.ws-jwt.to.wave-one',
      'unblock.events.>',
    ]);
  });
});

describe('unblock subjects --persona', () => {
  it('routes through ~/.unblock-personas/<NAME>/ instead of UNBLOCK_HOME', async () => {
    await seedCurrentPersona({
      workspaceId: 'ws-default',
      chatName: 'default-persona',
      jwtPayload: { name: 'default-persona' },
    });

    const personaName = `subjects-test-${process.pid}-${Date.now()}`;
    const personaDir = personaHomeFor(personaName);
    await mkdir(personaDir, { recursive: true });
    const credsPath = path.join(personaDir, 'comms-v3.creds');
    const envPath = path.join(personaDir, 'comms-v3.env');
    await writeFile(
      credsPath,
      fakeCreds({
        name: 'Persona-Alt',
        nats: {
          pub: { allow: ['unblock.chat.ws.ws-alt.firehose'] },
          sub: { allow: ['unblock.chat.ws.ws-alt.to.persona-alt'] },
        },
      }),
      'utf-8',
    );
    await writeFile(
      envPath,
      [
        'UNBLOCK_NATS_URL=tls://alt:1',
        `UNBLOCK_NATS_CREDS=${credsPath}`,
        'UNBLOCK_WORKSPACE_ID=ws-alt',
        'UNBLOCK_ORG_ID=org-alt',
        'UNBLOCK_CHAT_NAME=Persona-Alt',
        '',
      ].join('\n'),
      'utf-8',
    );

    try {
      const { code, stdout } = await runMainCapturingStdout([
        'subjects',
        '--persona',
        personaName,
        '--json',
      ]);
      const parsed = JSON.parse(stdout) as Record<string, unknown>;

      expect(code).toBe(0);
      expect(parsed['canonical_chat_name']).toBe('persona-alt');
      expect(parsed['dm_inbox_subject']).toBe('unblock.chat.ws.ws-alt.to.persona-alt');
      expect(parsed['resolved_env_path']).toBe(envPath);
      expect(parsed['resolved_creds_path']).toBe(credsPath);
    } finally {
      await rm(personaDir, { recursive: true, force: true });
    }
  });
});

async function seedCurrentPersona(input: {
  readonly workspaceId: string;
  readonly chatName: string;
  readonly jwtPayload: Record<string, unknown>;
}): Promise<void> {
  await writeCommsCreds(fakeCreds(input.jwtPayload));
  await writeCommsEnv({
    natsUrl: 'tls://nats.kaeva.app:39899',
    credsPath: v3CredsPath(),
    workspaceId: input.workspaceId,
    orgId: 'org-test',
    chatName: input.chatName,
  });
}

function fakeCreds(jwtPayload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'ed25519' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(jwtPayload)).toString('base64url');
  const jwt = `${header}.${body}.sig`;
  return `-----BEGIN NATS USER JWT-----\n${jwt}\n------END NATS USER JWT------\n`;
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
