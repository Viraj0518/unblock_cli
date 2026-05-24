#!/usr/bin/env node
// `unblock` CLI entry point. Apps have a main; packages don't.
//
// Exported `main` is testable in isolation. The bottom-of-file invocation only
// runs when this file is loaded as the process entry point (i.e. as the `bin`
// script), so importing this module from tests doesn't trigger process.exit.

import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { Command } from 'commander';
import { runSay } from './commands/say.js';
import { runDm } from './commands/dm.js';
import { runAsk } from './commands/ask.js';
import { runChat } from './commands/chat.js';
import { runLogin } from './commands/login.js';
import { runLogout } from './commands/logout.js';
import { runWhoami } from './commands/whoami.js';
import { runRemember } from './commands/remember.js';
import { runQuery } from './commands/query.js';
import { createNatsFactory } from './comms/nats-client.js';
import { createHttpSubstrateFactory } from './sdk/http-substrate.js';
import { shortenDid } from './auth/did.js';
import { version } from './index.js';

/**
 * Entry point. Returns the desired exit code (caller calls process.exit).
 * Errors are converted to non-zero exit codes + stderr messages.
 */
export async function main(argv: readonly string[]): Promise<number> {
  const program = buildProgram();
  try {
    await program.parseAsync(['node', 'unblock', ...argv]);
    return toExitNumber(process.exitCode) ?? 0;
  } catch (err) {
    process.stderr.write(`${errMsg(err)}\n`);
    return toExitNumber(process.exitCode) ?? 1;
  }
}

function buildProgram(): Command {
  const program = new Command();
  program
    .name('unblock')
    .description(
      'UNBLOCK CLI — comms (chat/say/dm/ask), substrate (remember/query), auth (login/whoami/logout).',
    )
    .version(version, '-V, --version');

  // ─── comms ────────────────────────────────────────────────────────────────
  program
    .command('chat')
    .description('Interactive REPL: firehose + DM inbox. Type message · @<who> message · /a <qid> message · /quit.')
    .option('--name <handle>', 'display name (defaults to UNBLOCK_CHAT_NAME / persona JWT name)')
    .option('--nats-url <url>', 'broker URL override')
    .action(async (opts: Record<string, unknown>) => {
      await runChat(
        { commsFactory: createNatsFactory() },
        configOverrides(opts),
      );
    });

  program
    .command('say <msg>')
    .description('Fire-and-forget broadcast to the workspace firehose.')
    .option('--name <handle>', 'display name')
    .option('--nats-url <url>', 'broker URL override')
    .action(async (msg: string, opts: Record<string, unknown>) => {
      await runSay(
        { commsFactory: createNatsFactory() },
        { ...configOverrides(opts), msg },
      );
    });

  program
    .command('dm <to> <msg>')
    .description('Direct message a recipient (mirrored to firehose so humans can observe).')
    .option('--name <handle>', 'display name')
    .option('--nats-url <url>', 'broker URL override')
    .action(async (to: string, msg: string, opts: Record<string, unknown>) => {
      await runDm(
        { commsFactory: createNatsFactory() },
        { ...configOverrides(opts), to, msg },
      );
    });

  program
    .command('ask <question>')
    .description(
      'Publish a question and block until reply (or --timeout). Prints reply to stdout. ' +
        'Exit 0 = reply, exit 2 = timeout+--default, exit 1 = error.',
    )
    .option('--options <list>', 'comma-separated options shown to responders')
    .option('--timeout <sec>', 'seconds to wait (default 300)', (v) => Number.parseFloat(v))
    .option('--default <val>', 'print this and exit 2 on timeout instead of erroring')
    .option('--name <handle>', 'display name')
    .option('--nats-url <url>', 'broker URL override')
    .action(async (question: string, opts: Record<string, unknown>) => {
      const result = await runAsk(
        { commsFactory: createNatsFactory() },
        {
          ...configOverrides(opts),
          question,
          ...(typeof opts['options'] === 'string' ? { options: opts['options'] } : {}),
          ...(typeof opts['timeout'] === 'number' ? { timeout: opts['timeout'] } : {}),
          ...(typeof opts['default'] === 'string' ? { default: opts['default'] } : {}),
        },
      );
      process.stdout.write(`${result.answer}\n`);
      process.exitCode = result.outcome === 'timeout' ? 2 : 0;
    });

  // ─── auth ─────────────────────────────────────────────────────────────────
  program
    .command('login <invite-code>')
    .description('Redeem an org invite code: mints did:key, enrolls, writes ~/.unblock/comms-v3.{creds,env}.')
    .option('--agent-name <name>', 'human-readable handle (default: short DID)')
    .option('--auth-url <url>', 'auth-issuer URL override')
    .action(async (inviteCode: string, opts: Record<string, unknown>) => {
      const result = await runLogin(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...configOverrides(opts),
          inviteCode,
          ...(typeof opts['agentName'] === 'string' ? { agentName: opts['agentName'] } : {}),
        },
      );
      process.stdout.write(
        [
          `logged in as ${result.chatName}`,
          `  did:        ${result.did} (${shortenDid(result.did)})`,
          `  org:        ${result.orgId}`,
          `  workspace:  ${result.workspaceId}`,
          `  broker:     ${result.broker}`,
          ...(result.expiresAt !== undefined ? [`  jwt expiry: ${result.expiresAt}`] : []),
          result.mintedNewIdentity ? '(new identity minted)' : '(existing identity reused)',
        ].join('\n') + '\n',
      );
    });

  program
    .command('logout')
    .description('Remove local persona store (identity + comms creds). Idempotent.')
    .action(async () => {
      const result = await runLogout();
      if (result.removed.length === 0) {
        process.stdout.write('already logged out (no files to remove)\n');
      } else {
        process.stdout.write(`removed ${String(result.removed.length)} file(s):\n`);
        for (const p of result.removed) process.stdout.write(`  ${p}\n`);
      }
    });

  program
    .command('whoami')
    .description('Print current persona: DID, handle, broker, workspace, JWT expiry.')
    .action(async () => {
      const result = await runWhoami();
      for (const line of result.lines) process.stdout.write(`${line}\n`);
      process.exitCode = result.loggedIn ? 0 : 1;
    });

  // ─── substrate ────────────────────────────────────────────────────────────
  program
    .command('remember <content>')
    .description('Store a block in the substrate. Returns the block_id.')
    .option('--tag <list>', 'comma-separated tags')
    .option('--parent <block_id>', 'parent block id (for hierarchical blocks)')
    .option('--auth-url <url>', 'auth-issuer URL override')
    .action(async (content: string, opts: Record<string, unknown>) => {
      const tags = parseList(opts['tag']);
      const result = await runRemember(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...configOverrides(opts),
          content,
          ...(tags !== undefined ? { tags } : {}),
          ...(typeof opts['parent'] === 'string' ? { parentBlockId: opts['parent'] } : {}),
        },
      );
      process.stdout.write(`${result.blockId}\n`);
    });

  program
    .command('query <q>')
    .description('Search the substrate. Prints hits as JSON (or one per line for piping).')
    .option('--top-k <n>', 'how many hits to return (default 10)', (v) => Number.parseInt(v, 10))
    .option('--json', 'emit JSON instead of one-block-id-per-line', false)
    .option('--auth-url <url>', 'auth-issuer URL override')
    .action(async (q: string, opts: Record<string, unknown>) => {
      const hits = await runQuery(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...configOverrides(opts),
          query: q,
          ...(typeof opts['topK'] === 'number' ? { topK: opts['topK'] } : {}),
        },
      );
      if (opts['json'] === true) {
        process.stdout.write(`${JSON.stringify(hits, null, 2)}\n`);
      } else {
        for (const h of hits) {
          process.stdout.write(`${h.blockId}\t${h.score.toFixed(4)}\t${h.snippet}\n`);
        }
      }
    });

  return program;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function configOverrides(opts: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof opts['name'] === 'string') out['name'] = opts['name'];
  if (typeof opts['natsUrl'] === 'string') out['natsUrl'] = opts['natsUrl'];
  if (typeof opts['authUrl'] === 'string') out['authUrl'] = opts['authUrl'];
  if (typeof opts['workspaceId'] === 'string') out['workspaceId'] = opts['workspaceId'];
  return out;
}

function parseList(v: unknown): readonly string[] | undefined {
  if (typeof v !== 'string') return undefined;
  const parts = v
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return parts.length > 0 ? parts : undefined;
}

function toExitNumber(v: string | number | undefined | null): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number.parseInt(v, 10);
    return Number.isNaN(n) ? undefined : n;
  }
  return undefined;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return `error: ${err.message}`;
  return `error: ${String(err)}`;
}

// Only run as a process when invoked directly (as the bin script). Comparing
// `import.meta.url` to `pathToFileURL(process.argv[1])` is the cross-platform
// ESM idiom for "is this the entry point?" — handles Windows backslashes and
// drive-letter prefixes correctly, unlike a naive string match.
const entry = process.argv[1];
const invokedDirectly = entry !== undefined && import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => {
      process.exit(code);
    })
    .catch((err: unknown) => {
      process.stderr.write(`${errMsg(err)}\n`);
      process.exit(1);
    });
}
