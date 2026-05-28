/**
 * `unblock subjects [--persona NAME] [--json]`
 *
 * D2.4 operator introspection for the current persona's NATS subject map.
 * Reads `comms-v3.env`, decodes the NATS User JWT from the resolved creds
 * path, and reports the exact subjects a human or AI maintainer should use.
 */

import { readFile } from 'node:fs/promises';
import { readCommsEnv, v3EnvPath } from '../auth/persona-store.js';
import { decodeCreds } from '../auth/jwt.js';
import { chatDmSubject, chatFirehoseSubject, normalizeChatName } from '../comms/wire.js';

/** D2.4 abbreviated subject fields embedded into `unblock health --json`. */
export interface SubjectSummary {
  readonly canonical_chat_name: string;
  readonly dm_inbox_subject: string;
  readonly firehose_subject: string;
}

/** D2.4 full subject report printed by `unblock subjects --json`. */
export interface SubjectsResult extends SubjectSummary {
  readonly channel_subject_examples: readonly string[];
  readonly jwt_pub_allow: readonly string[];
  readonly jwt_sub_allow: readonly string[];
  readonly resolved_creds_path: string;
  readonly resolved_env_path: string;
}

/** Build D2.4 subject names from the already-resolved persona config. */
export function buildSubjectSummary(input: {
  readonly workspaceId: string;
  readonly chatName: string;
}): SubjectSummary {
  const canonicalChatName = normalizeChatName(input.chatName);
  return {
    canonical_chat_name: canonicalChatName,
    dm_inbox_subject: chatDmSubject(input.workspaceId, canonicalChatName),
    firehose_subject: chatFirehoseSubject(input.workspaceId),
  };
}

/** Resolve the current persona's full D2.4 subject and JWT permission report. */
export async function runSubjects(): Promise<SubjectsResult> {
  const env = await readCommsEnv();
  if (env === null) {
    throw new Error(
      `subjects: no comms-v3.env at ${v3EnvPath()}. Run \`unblock login <invite-code>\` first.`,
    );
  }

  const creds = await readCredsOrThrow(env.credsPath);
  const claims = decodeCreds(creds);
  if (claims === null) {
    throw new Error(`subjects: could not decode NATS User JWT from ${env.credsPath}.`);
  }

  const jwtName = pickStr(claims.name);
  const summary = buildSubjectSummary({
    workspaceId: env.workspaceId,
    chatName: jwtName ?? env.chatName,
  });

  return {
    ...summary,
    channel_subject_examples: ['unblock.channel.NAME.>'],
    jwt_pub_allow: pickStringArray(claims.nats?.pub?.allow),
    jwt_sub_allow: pickStringArray(claims.nats?.sub?.allow),
    resolved_creds_path: env.credsPath,
    resolved_env_path: v3EnvPath(),
  };
}

/** Human-readable D2.4 subject report for the default CLI output. */
export function formatSubjects(result: SubjectsResult): string {
  return [
    `canonical_chat_name:     ${result.canonical_chat_name}`,
    `dm_inbox_subject:        ${result.dm_inbox_subject}`,
    `firehose_subject:        ${result.firehose_subject}`,
    `channel_subject_example: ${result.channel_subject_examples.join(', ')}`,
    `jwt_pub_allow:           ${formatList(result.jwt_pub_allow)}`,
    `jwt_sub_allow:           ${formatList(result.jwt_sub_allow)}`,
    `resolved_creds_path:     ${result.resolved_creds_path}`,
    `resolved_env_path:       ${result.resolved_env_path}`,
    '',
  ].join('\n');
}

async function readCredsOrThrow(credsPath: string): Promise<string> {
  try {
    return await readFile(credsPath, 'utf-8');
  } catch (err) {
    if (typeof err === 'object' && err !== null && (err as { code?: string }).code === 'ENOENT') {
      throw new Error(`subjects: no creds at ${credsPath}. Run \`unblock login <invite-code>\` first.`);
    }
    throw err;
  }
}

function pickStr(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

function pickStringArray(v: readonly string[] | undefined): readonly string[] {
  if (v === undefined) return [];
  return v.filter((item) => item.trim() !== '');
}

function formatList(values: readonly string[]): string {
  return values.length === 0 ? '(none)' : values.join(', ');
}
