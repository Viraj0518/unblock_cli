/**
 * Output formatters — JSON for scripting, pretty for humans.
 *
 * `chalk` is the only color dep. The CLI is Node-only so we never have to
 * worry about edge runtimes here (per package.json `engines.node = >=22`).
 */

import chalk from 'chalk';
import type { ChatEnvelope } from '../sdk/types.js';

export type OutputMode = 'pretty' | 'json';

/** Format a chat envelope for the REPL / `say` echo. */
export function formatChatEvent(evt: ChatEnvelope, mode: OutputMode = 'pretty'): string {
  if (mode === 'json') return JSON.stringify(evt);
  const ts = formatTs(evt.ts);
  const src = String(evt.source).padEnd(14);
  switch (evt.kind) {
    case 'say':
      return `${chalk.dim(`[${ts}]`)} ${chalk.cyan(src)} ${asString(evt['msg'])}`;
    case 'dm': {
      const to = String(evt['to'] ?? '?');
      return `${chalk.dim(`[${ts}]`)} ${chalk.cyan(src)} → ${chalk.green(to)}: ${asString(evt['msg'])}`;
    }
    case 'ask': {
      const opts = Array.isArray(evt['options']) && evt['options'].length > 0
        ? (evt['options'] as string[]).join('|')
        : 'free-form';
      const qid = String(evt['question_id'] ?? '');
      return `${chalk.dim(`[${ts}]`)} ${chalk.cyan(src)} ${chalk.yellow('ASK')} [${qid}]: ${asString(evt['msg'])}  ${chalk.dim(`↳ [${opts}]`)}`;
    }
    case 'reply': {
      const qid = String(evt['question_id'] ?? '');
      return `${chalk.dim(`[${ts}]`)} ${chalk.cyan(src)} ${chalk.magenta('REPLY')} [${qid}]: ${asString(evt['msg'])}`;
    }
    default:
      return `${chalk.dim(`[${ts}]`)} ${chalk.cyan(src)} ${evt.kind}: ${JSON.stringify(evt)}`;
  }
}

export function formatTs(ms: number): string {
  return new Date(ms).toISOString().slice(11, 19);
}

function asString(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}
