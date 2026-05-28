/**
 * `unblock identity normalize --persona X`
 *
 * D2.3 repair command for legacy mixed-case `UNBLOCK_CHAT_NAME` values in
 * `comms-v3.env`. NATS subjects are case-sensitive, so the CLI canonicalizes
 * chat names through the same wire helper used by DM routing.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { readCommsEnv, v3EnvPath } from '../auth/persona-store.js';
import { normalizeChatName } from '../comms/wire.js';

export interface IdentityNormalizeOptions {
  /**
   * Optional persona label for display + remediation hints. Persona-dir
   * routing itself is owned by the persona-store resolution chain (CLI
   * `--persona` flag → `UNBLOCK_HOME` env → default `~/.unblock/`), so
   * this string is purely cosmetic. Tracked as kink K9.1.
   */
  readonly persona?: string;
  readonly apply?: boolean;
}

export interface IdentityNormalizeResult {
  readonly persona: string;
  readonly old_chat_name: string;
  readonly new_chat_name: string;
  readonly would_change: boolean;
  readonly drain_subject_legacy: string;
  readonly drain_subject_new: string;
}

/** Resolve and optionally rewrite the current persona's canonical chat name. */
export async function runIdentityNormalize(
  opts: IdentityNormalizeOptions = {},
): Promise<IdentityNormalizeResult> {
  const persona = opts.persona?.trim() ?? '';

  const env = await readCommsEnv();
  if (env === null) {
    const personaHint = persona === '' ? '' : ` --persona ${persona}`;
    throw new Error(
      `identity normalize: no comms-v3.env at ${v3EnvPath()}. Run \`unblock login <invite-code>${personaHint}\` first.`,
    );
  }

  const oldChatName = env.chatName;
  const newChatName = normalizeChatName(oldChatName);
  const wouldChange = oldChatName !== newChatName;
  const result: IdentityNormalizeResult = {
    persona,
    old_chat_name: oldChatName,
    new_chat_name: newChatName,
    would_change: wouldChange,
    drain_subject_legacy: dmSubject(env.workspaceId, oldChatName),
    drain_subject_new: dmSubject(env.workspaceId, newChatName),
  };

  if (wouldChange && opts.apply === true) {
    const envPath = v3EnvPath();
    const raw = await readFile(envPath, 'utf-8');
    await writeFile(envPath, replaceChatNameLine(raw, newChatName), 'utf-8');
  }

  return result;
}

/** Human-readable dry-run/apply report. */
export function formatIdentityNormalize(
  result: IdentityNormalizeResult,
  opts: { readonly applied?: boolean } = {},
): string {
  if (!result.would_change) {
    return `already normalized: UNBLOCK_CHAT_NAME=${result.new_chat_name}\n`;
  }

  const verb = opts.applied === true ? 'changed' : 'would change';
  return [
    `${verb} UNBLOCK_CHAT_NAME from ${result.old_chat_name} to ${result.new_chat_name}`,
    '',
    'Drain recipe:',
    `legacy DM history remains queryable at the old subject: ${result.drain_subject_legacy}`,
    `new DMs route to the new subject: ${result.drain_subject_new}`,
    `to inspect legacy use unblock listen --subject ${result.drain_subject_legacy} --since 30d`,
    '',
  ].join('\n');
}

function dmSubject(workspaceId: string, chatName: string): string {
  return `unblock.chat.ws.${workspaceId}.to.${chatName}`;
}

function replaceChatNameLine(raw: string, newChatName: string): string {
  const parts = raw.split(/(\r\n|\n|\r)/);
  for (let i = 0; i < parts.length; i += 2) {
    const replaced = replaceChatNameInSingleLine(parts[i] ?? '', newChatName);
    if (replaced !== null) {
      parts[i] = replaced;
      return parts.join('');
    }
  }
  throw new Error('identity normalize: comms-v3.env is missing UNBLOCK_CHAT_NAME.');
}

function replaceChatNameInSingleLine(line: string, newChatName: string): string | null {
  const match = /^(\s*UNBLOCK_CHAT_NAME\s*=\s*)(?:(["'])(.*?)\2|([^#\r\n]*?))(\s*)$/.exec(line);
  if (match === null) return null;
  const prefix = match[1] ?? '';
  const quote = match[2];
  const suffix = match[5] ?? '';
  if (quote !== undefined) {
    return `${prefix}${quote}${newChatName}${quote}${suffix}`;
  }
  return `${prefix}${newChatName}${suffix}`;
}
