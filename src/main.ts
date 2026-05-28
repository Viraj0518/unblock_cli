#!/usr/bin/env node
// `unblock` CLI entry point. Apps have a main; packages don't.
//
// Exported `main` is testable in isolation. The bottom-of-file invocation only
// runs when this file is loaded as the process entry point (i.e. as the `bin`
// script), so importing this module from tests doesn't trigger process.exit.

import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { Command, CommanderError } from 'commander';
import { runSay } from './commands/say.js';
import { runDm } from './commands/dm.js';
import { runAsk } from './commands/ask.js';
import { runChat } from './commands/chat.js';
import { runLogin } from './commands/login.js';
import { runLogout } from './commands/logout.js';
import { runWhoami } from './commands/whoami.js';
import { runRemember } from './commands/remember.js';
import { runQuery } from './commands/query.js';
import { runShare } from './commands/share.js';
import { runListMarketplace } from './commands/list-marketplace.js';
import { runPurchase } from './commands/purchase.js';
import { runVerify } from './commands/verify.js';
import { runAttest } from './commands/attest.js';
import { runSubscribe } from './commands/subscribe.js';
import { runUpdate } from './commands/update.js';
import { runExtract } from './commands/extract.js';
import { runForget } from './commands/forget.js';
import { runIngest } from './commands/ingest.js';
import { runEval, type EvalBench } from './commands/eval.js';
import { runMint } from './commands/mint.js';
import { runInvite, type InviteRole } from './commands/invite.js';
import { runListen } from './commands/listen.js';
import { runMonitor, type MonitorKind, type MonitorTopic } from './commands/monitor.js';
import { runSend } from './commands/send.js';
import { runTrace } from './commands/trace.js';
import { runHealth, type ComponentName } from './commands/health.js';
import { formatSubjects, runSubjects } from './commands/subjects.js';
import { registerSkillCommands } from './commands/skill.js';
import { formatIdentityNormalize, runIdentityNormalize } from './commands/identity-normalize.js';
import {
  AlreadyPresentError,
  formatMintApiKey,
  MINT_API_KEY_EXIT,
  runMintApiKey,
} from './commands/identity-mint-api-key.js';
import {
  cmdProfileAdd,
  cmdProfileList,
  cmdProfileRm,
  cmdProfileUse,
  type ProfileResult,
} from './profile/commands.js';
import { createNatsFactory } from './comms/nats-client.js';
import { createHttpSubstrateFactory } from './sdk/http-substrate.js';
import { shortenDid } from './auth/did.js';
import { personaHomeFor, setPersonaDirOverride } from './auth/persona-store.js';
import { loadRegistry, readProfileKey } from './profile/registry.js';
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
    if (err instanceof CommanderError) {
      return toExitNumber(err.exitCode) ?? 1;
    }
    process.stderr.write(`${errMsg(err)}\n`);
    return toExitNumber(process.exitCode) ?? 1;
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name('unblock')
    .description(
      'UNBLOCK CLI — comms (chat/say/dm/ask), substrate (remember/query/share/list/purchase/verify/attest/subscribe/update/extract/forget), auth (login/whoami/logout/invite/mint).\n' +
        '\n' +
        'Multi-persona on one workstation: every auth/persona command accepts ' +
        '`--persona NAME` (preferred) to read/write `~/.unblock-personas/<NAME>/` ' +
        'instead of `~/.unblock/`. You can also export `UNBLOCK_HOME=<dir>` to ' +
        'pin a persona for the whole shell session.',
    )
    .version(version, '-V, --version')
    .exitOverride()
    .action(() => {
      program.outputHelp();
      process.exitCode = 0;
    });

  // ─── comms ────────────────────────────────────────────────────────────────
  program
    .command('chat')
    .description(
      'Interactive REPL: firehose + DM inbox. Type message · @<who> message · /a <qid> message · /quit. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/.',
    )
    .option('--name <handle>', 'display name (defaults to UNBLOCK_CHAT_NAME / persona JWT name)')
    .option('--nats-url <url>', 'broker URL override')
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (opts: Record<string, unknown>) => {
      await withPersonaFlag(opts['persona'], async () => {
        await runChat(
          { commsFactory: createNatsFactory() },
          configOverrides(opts),
        );
      });
    });

  program
    .command('say <msg>')
    .description(
      'Fire-and-forget broadcast to the workspace firehose. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/.',
    )
    .option('--name <handle>', 'display name')
    .option('--nats-url <url>', 'broker URL override')
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (msg: string, opts: Record<string, unknown>) => {
      await withPersonaFlag(opts['persona'], async () => {
        await runSay(
          { commsFactory: createNatsFactory() },
          { ...configOverrides(opts), msg },
        );
      });
    });

  program
    .command('dm <to> <msg>')
    .description(
      'Direct message a recipient (mirrored to firehose so humans can observe). ' +
        'Recipient name is case-normalized (lowercased) to match enrollment — ' +
        'NATS subjects are case-sensitive, so `Viraj-Alpha` and `viraj-alpha` would otherwise be different inboxes. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/.',
    )
    .option('--name <handle>', 'display name')
    .option('--nats-url <url>', 'broker URL override')
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (to: string, msg: string, opts: Record<string, unknown>) => {
      await withPersonaFlag(opts['persona'], async () => {
        await runDm(
          { commsFactory: createNatsFactory() },
          { ...configOverrides(opts), to, msg },
        );
      });
    });

  // ─── X1: mint ────────────────────────────────────────────────────────────────
  program
    .command('mint')
    .description(
      'Re-mint fresh NATS credentials for a persona without a full invite-code flow. ' +
        'Reads MACAROON_ROOT_SECRET from env or Supabase app_secrets. ' +
        'Writes to ~/.unblock-personas/<NAME>/comms-v3.{creds,env} (LF line endings). ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/. ' +
        'Exit 0 on success, 1 on error.',
    )
    .option('--persona <name>', 'persona name (writes ~/.unblock-personas/<name>/; default: current persona)')
    .option('--ttl <duration>', 'credential TTL, e.g. 30d, 1h, 2592000 (default: 30d)')
    .option('--print', 'print JSON to stdout, do not write files', false)
    .option('--json', 'machine-readable JSON output', false)
    .option('--auth-url <url>', 'auth-issuer URL override')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const result = await runMint(
          {},
          {
            ...configOverrides(opts),
            ...(typeof opts['persona'] === 'string' ? { persona: opts['persona'] } : {}),
            ...(typeof opts['ttl'] === 'string' ? { ttl: opts['ttl'] } : {}),
            print: opts['print'] === true,
          },
        );
        if (opts['json'] === true) {
          process.stdout.write(`${JSON.stringify({
            persona: result.persona,
            did: result.did,
            jwt_expires_at: result.jwtExpiresAt,
            ttl_seconds: result.ttlSeconds,
            creds_path: result.credsPath ?? null,
            env_path: result.envPath ?? null,
          }, null, 2)}\n`);
        } else if (opts['print'] === true) {
          process.stdout.write(`${result.natsCreds}`);
        } else {
          process.stdout.write(
            `minted  ${result.persona}\n` +
              `  did:      ${result.did}\n` +
              `  expires:  ${result.jwtExpiresAt}\n` +
              `  creds:    ${result.credsPath ?? '(not written)'}\n`,
          );
        }
      } catch (err) {
        process.stderr.write(`${errMsg(err)}\n`);
        process.exitCode = 1;
      }
    });

  // ─── invite (Gap A) ──────────────────────────────────────────────────────────
  program
    .command('invite')
    .description(
      'Mint an org invite code that a new persona can redeem via `unblock login <code>`. ' +
        'Reads the admin NATS JWT from <persona-dir>/comms-v3.creds. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/. ' +
        'Exit 0 on success, 1 on error.',
    )
    .requiredOption('--org <slug>', "org slug (e.g. 'unblock'), NOT the full org_did")
    .requiredOption('--role <role>', 'admin | member | guest')
    .option('--expires-in-days <n>', 'invite TTL in days (default 7, max 90)', (v) =>
      Number.parseInt(v, 10),
    )
    .option('--json', 'machine-readable JSON output', false)
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/comms-v3.creds')
    .option('--auth-url <url>', 'auth-issuer URL override (default https://auth.kaeva.app)')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const role = typeof opts['role'] === 'string' ? opts['role'].toLowerCase() : '';
        if (role !== 'admin' && role !== 'member' && role !== 'guest') {
          process.stderr.write(
            `error: --role must be one of admin | member | guest (got "${String(opts['role'])}")\n`,
          );
          process.exitCode = 1;
          return;
        }

        const inviteOpts = {
          ...configOverrides(opts),
          org: typeof opts['org'] === 'string' ? opts['org'] : '',
          role: role as InviteRole,
          ...(typeof opts['expiresInDays'] === 'number' ? { expiresInDays: opts['expiresInDays'] } : {}),
          ...(typeof opts['persona'] === 'string' ? { persona: opts['persona'] } : {}),
        };

        const result = await runInvite({}, inviteOpts);

        if (opts['json'] === true) {
          process.stdout.write(`${JSON.stringify({
            invite_code: result.inviteCode,
            role: result.role,
            expires_at: result.expiresAt,
            org_id: result.orgId,
          }, null, 2)}\n`);
        } else {
          process.stdout.write(`invite_code: ${result.inviteCode}\n`);
          process.stdout.write(`role:        ${result.role}\n`);
          if (result.expiresAt !== '') {
            process.stdout.write(`expires_at:  ${result.expiresAt}\n`);
          }
          if (result.orgId !== '') {
            process.stdout.write(`org_id:      ${result.orgId}\n`);
          }
        }
      } catch (err) {
        process.stderr.write(`${errMsg(err)}\n`);
        process.exitCode = 1;
      }
    });

  // ─── X2: listen ──────────────────────────────────────────────────────────────
  program
    .command('listen')
    .description(
      'Long-running NATS subscribe. Default subject = current persona DM inbox. ' +
        '--channel NAME subscribes to unblock.channel.<name>.>. ' +
        'When the loaded chat_name has uppercase chars, ALSO subscribes to its lowercased variant ' +
        'as a transitional safety net (NATS subjects are case-sensitive).\n' +
        '\n' +
        'Four delivery modes (mutually composable with --filter / --timeout / --json):\n' +
        '  (default)    live-tail only — messages sent while listener is down are LOST.\n' +
        '  --since      replay from a point in time, then live-tail. ISO-8601 OR a\n' +
        '               duration: 1h, 30m, 7d, 45s, 2w.\n' +
        '  --replay-all replay everything in 30-day JetStream retention, then live-tail.\n' +
        '  --durable    named durable JetStream consumer; cursor PERSISTS across restarts\n' +
        '               so the next `listen` resumes where this one left off.\n' +
        '  --reset-durable delete and recreate the named durable consumer before listening.\n' +
        '\n' +
        'Auto-ack: when an incoming envelope has a NATS request-reply `reply` subject\n' +
        '(set by `unblock send --ack`), publishes a tiny ack envelope back BEFORE\n' +
        'printing — fixes the `--ack` always-timeout bug. Opt out with --no-ack.\n' +
        '\n' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/. ' +
        'Exit 0 on Ctrl+C or timeout, 1 on auth failure, 2 on bad --filter regex or unavailable JetStream.',
    )
    .option('--subject <pattern>', 'NATS subject filter (supports * and > wildcards)')
    .option('--channel <name>', 'subscribe to unblock.channel.<name>.>')
    .option('--filter <regex>', 'only print messages where body matches regex')
    .option('--json', 'emit one JSON object per message', false)
    .option('--timeout <sec>', 'exit after N seconds', (v) => Number.parseFloat(v))
    .option('--since <duration|iso>', 'JetStream replay from this point (e.g. 1h, 7d, 2026-05-27T12:00:00Z)')
    .option('--replay-all', 'JetStream replay everything in retention (30d) before live-tail', false)
    .option('--durable <name>', 'use named durable JetStream consumer (cursor persists across restarts)')
    .option('--reset-durable', 'delete and recreate the named durable consumer before listening', false)
    .option('--no-ack', 'disable auto-ack on incoming request-reply messages (default: ack)')
    .option('--name <handle>', 'display name override')
    .option('--nats-url <url>', 'broker URL override')
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (opts: Record<string, unknown>) => {
      try {
        await withPersonaFlag(opts['persona'], async () => {
          const result = await runListen(
            { commsFactory: createNatsFactory() },
            {
              ...configOverrides(opts),
              ...(typeof opts['subject'] === 'string' ? { subject: opts['subject'] } : {}),
              ...(typeof opts['channel'] === 'string' ? { channel: opts['channel'] } : {}),
              ...(typeof opts['filter'] === 'string' ? { filter: opts['filter'] } : {}),
              json: opts['json'] === true,
              ...(typeof opts['timeout'] === 'number' ? { timeout: opts['timeout'] } : {}),
              ...(typeof opts['since'] === 'string' ? { since: opts['since'] } : {}),
              replayAll: opts['replayAll'] === true,
              ...(typeof opts['durable'] === 'string' ? { durable: opts['durable'] } : {}),
              resetDurable: opts['resetDurable'] === true,
              // commander's --no-ack inverts: opts.ack === false means user passed --no-ack.
              noAck: opts['ack'] === false,
            },
          );
          if (result.exitReason === 'timeout') process.exitCode = 0;
        });
      } catch (err) {
        process.stderr.write(`${errMsg(err)}\n`);
        process.exitCode = 1;
      }
    });

  // ─── monitor: wake-on-event with filters + routing hooks ─────────────────────
  program
    .command('monitor')
    .description(
      'Long-running NATS event watcher modeled on Claude Code\'s Monitor tool. ' +
        'Each matching event becomes one stdout line (or --exec invocation / --webhook POST / --notify). ' +
        'Distinct from `unblock listen` — listen tails your DM inbox; monitor wakes on filtered events ' +
        'with routing hooks for reactive loops around the org-brain.\n' +
        '\n' +
        'Source (one of, default = inbox):\n' +
        '  --subject <pattern>    raw NATS subject (supports * and >)\n' +
        '  --channel <name>       shorthand for unblock.channel.<name>.>\n' +
        '  --topic <preset>       inbox|firehose|events|channels|dms-to-anyone\n' +
        '\n' +
        'Filters (applied before emit):\n' +
        '  --grep <regex>         only emit when payload JSON matches\n' +
        '  --kind <k>             envelope.kind exact: dm|firehose|q|a|ack\n' +
        '  --from <name|did>      envelope.source case-insensitive match\n' +
        '\n' +
        'Routing (pick one; default = stdout JSON lines):\n' +
        '  --exec <cmd>           spawn per event, pipe event JSON to stdin\n' +
        '  --webhook <url>        POST event JSON; retries 5xx (1s,2s,4s), no retry on 4xx\n' +
        '  --notify               OS desktop notification per event\n' +
        '\n' +
        'Persistence + replay (forces JetStream path):\n' +
        '  --durable <name>       named JS consumer; cursor persists across restarts\n' +
        '  --reset-durable        delete and recreate the named durable consumer before monitoring\n' +
        '  --since <dur|iso>      replay from a point (1h, 7d, ISO timestamp)\n' +
        '  --replay-all           replay everything in 30d retention\n' +
        '\n' +
        'Lifecycle:\n' +
        '  --until <regex>        exit 0 on first event whose JSON matches\n' +
        '  --timeout <sec>        exit 0 after N seconds (no events required)\n' +
        '  --persistent           run until SIGINT (default unless --timeout/--until)\n' +
        '\n' +
        'Output shape: every stdout line is one JSON envelope (--no-json for human format).\n' +
        '  {"type":"event",          "payload":{...},                    "ts":"..."}\n' +
        '  {"type":"monitor.warning","reason":"...","detail":"...",      "ts":"..."}\n' +
        '  {"type":"monitor.fatal",  "reason":"...","detail":"...",      "ts":"..."}\n' +
        'Coverage guarantee: connection drops / consumer death always emit a fatal envelope; never silent.\n' +
        '\n' +
        '  --batch <ms>           coalesce events within N ms into one emit\n' +
        '  --quiet-failures       suppress per-event 5xx/non-zero-exit warnings\n' +
        '\n' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/. ' +
        'Exit 0 on clean exit, 1 on fatal, 2 on bad --grep/--until regex or unavailable JetStream.',
    )
    .option('--subject <pattern>', 'NATS subject filter (supports * and > wildcards)')
    .option('--channel <name>', 'subscribe to unblock.channel.<name>.>')
    .option('--topic <preset>', 'inbox | firehose | events | channels | dms-to-anyone')
    .option('--grep <regex>', 'only emit events where payload JSON matches')
    .option('--kind <kind>', 'envelope.kind filter: dm | firehose | q | a | ack')
    .option('--from <name>', 'envelope.source filter (case-insensitive)')
    .option('--exec <cmd>', 'spawn <cmd> per event, pipe event JSON to its stdin')
    .option('--webhook <url>', 'POST event JSON to URL; retries 5xx (max 3), no retry on 4xx')
    .option('--notify', 'OS desktop notification per event', false)
    .option('--durable <name>', 'use named durable JetStream consumer (cursor persists)')
    .option('--reset-durable', 'delete and recreate the named durable consumer before monitoring', false)
    .option('--since <dur|iso>', 'JetStream replay from this point (e.g. 1h, 7d, ISO timestamp)')
    .option('--replay-all', 'JetStream replay everything in retention before live-tail', false)
    .option('--until <regex>', 'exit 0 on first event whose JSON matches')
    .option('--timeout <sec>', 'exit after N seconds (no events required)', (v) => Number.parseFloat(v))
    .option('--persistent', 'run until SIGINT (default unless --timeout/--until)', false)
    .option('--json', 'emit one JSON envelope per event (default)', true)
    .option('--no-json', 'human format instead of JSON')
    .option('--batch <ms>', 'coalesce events within N ms into one emit', (v) => Number.parseInt(v, 10))
    .option('--quiet-failures', 'suppress per-event 5xx/non-zero-exit warnings', false)
    .option('--name <handle>', 'display name override')
    .option('--nats-url <url>', 'broker URL override')
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (opts: Record<string, unknown>) => {
      try {
        await withPersonaFlag(opts['persona'], async () => {
          const topicRaw = opts['topic'];
          const validTopics: ReadonlySet<MonitorTopic> = new Set([
            'inbox',
            'firehose',
            'events',
            'channels',
            'dms-to-anyone',
          ]);
          if (
            typeof topicRaw === 'string' &&
            !validTopics.has(topicRaw as MonitorTopic)
          ) {
            process.stderr.write(
              `error: --topic must be one of inbox|firehose|events|channels|dms-to-anyone (got "${topicRaw}")\n`,
            );
            process.exitCode = 1;
            return;
          }
          const kindRaw = opts['kind'];
          const validKinds: ReadonlySet<MonitorKind> = new Set([
            'dm',
            'firehose',
            'q',
            'a',
            'ack',
          ]);
          if (
            typeof kindRaw === 'string' &&
            !validKinds.has(kindRaw as MonitorKind)
          ) {
            process.stderr.write(
              `error: --kind must be one of dm|firehose|q|a|ack (got "${kindRaw}")\n`,
            );
            process.exitCode = 1;
            return;
          }

          const result = await runMonitor(
            { commsFactory: createNatsFactory() },
            {
              ...configOverrides(opts),
              ...(typeof opts['subject'] === 'string' ? { subject: opts['subject'] } : {}),
              ...(typeof opts['channel'] === 'string' ? { channel: opts['channel'] } : {}),
              ...(typeof topicRaw === 'string' ? { topic: topicRaw as MonitorTopic } : {}),
              ...(typeof opts['grep'] === 'string' ? { grep: opts['grep'] } : {}),
              ...(typeof kindRaw === 'string' ? { kind: kindRaw as MonitorKind } : {}),
              ...(typeof opts['from'] === 'string' ? { from: opts['from'] } : {}),
              ...(typeof opts['exec'] === 'string' ? { exec: opts['exec'] } : {}),
              ...(typeof opts['webhook'] === 'string' ? { webhook: opts['webhook'] } : {}),
              notify: opts['notify'] === true,
              ...(typeof opts['durable'] === 'string' ? { durable: opts['durable'] } : {}),
              resetDurable: opts['resetDurable'] === true,
              ...(typeof opts['since'] === 'string' ? { since: opts['since'] } : {}),
              replayAll: opts['replayAll'] === true,
              ...(typeof opts['until'] === 'string' ? { until: opts['until'] } : {}),
              ...(typeof opts['timeout'] === 'number' ? { timeout: opts['timeout'] } : {}),
              persistent: opts['persistent'] === true,
              // commander's --no-json inverts: opts.json === false ⇒ user passed --no-json.
              json: opts['json'] !== false,
              ...(typeof opts['batch'] === 'number' ? { batch: opts['batch'] } : {}),
              quietFailures: opts['quietFailures'] === true,
            },
          );
          process.exitCode = result.exitCode;
        });
      } catch (err) {
        process.stderr.write(`${errMsg(err)}\n`);
        // MonitorRegexError / MonitorJetStreamUnavailableError ⇒ exit 2
        const name = err instanceof Error ? err.name : '';
        if (name === 'MonitorRegexError' || name === 'MonitorJetStreamUnavailableError') {
          process.exitCode = 2;
        } else {
          process.exitCode = 1;
        }
      }
    });

  // ─── X4: send (dm with --ack) ─────────────────────────────────────────────────
  program
    .command('send <to> <msg>')
    .description(
      'Send a direct message. With --ack, waits for recipient acknowledgement ' +
        'before exiting. ' +
        'Recipient name is case-normalized (lowercased) to match enrollment — ' +
        'NATS subjects are case-sensitive, so `Viraj-Alpha` and `viraj-alpha` would otherwise be different inboxes. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/. ' +
        'Exit 0=ok, 2=ack-timeout, 1=error.',
    )
    .option('--ack', 'wait for recipient ack before exiting', false)
    .option('--timeout <sec>', 'seconds to wait for ack (default 30)', (v) => Number.parseFloat(v))
    .option('--json', 'machine-readable output', false)
    .option('--name <handle>', 'display name override')
    .option('--nats-url <url>', 'broker URL override')
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (to: string, msg: string, opts: Record<string, unknown>) => {
      try {
        await withPersonaFlag(opts['persona'], async () => {
          const result = await runSend(
            { commsFactory: createNatsFactory() },
            {
              ...configOverrides(opts),
              to,
              msg,
              ack: opts['ack'] === true,
              ...(typeof opts['timeout'] === 'number' ? { timeout: opts['timeout'] } : {}),
              json: opts['json'] === true,
            },
          );
          if (opts['json'] === true) {
            process.stdout.write(`${JSON.stringify({
              to: result.to,
              message_id: result.messageId,
              ack_received: result.ackReceived ?? null,
              ack_source: result.ackSource ?? null,
              ts: result.ts,
              elapsed_ms: result.elapsedMs,
            }, null, 2)}\n`);
          } else {
            process.stdout.write(`message_id: ${result.messageId}\n`);
            if (result.ackReceived !== undefined) {
              process.stdout.write(
                result.ackReceived
                  ? `ack: received from ${result.ackSource ?? 'unknown'} (${result.elapsedMs}ms)\n`
                  : `ack: timeout after ${result.elapsedMs}ms\n`,
              );
            }
          }
          process.exitCode = result.exitCode;
        });
      } catch (err) {
        process.stderr.write(`${errMsg(err)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command('ask <question>')
    .description(
      'Publish a question and block until reply (or --timeout). Prints reply to stdout. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/. ' +
        'Exit 0 = reply, exit 2 = timeout+--default, exit 1 = error.',
    )
    .option('--options <list>', 'comma-separated options shown to responders')
    .option('--timeout <sec>', 'seconds to wait (default 300)', (v) => Number.parseFloat(v))
    .option('--default <val>', 'print this and exit 2 on timeout instead of erroring')
    .option('--name <handle>', 'display name')
    .option('--nats-url <url>', 'broker URL override')
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (question: string, opts: Record<string, unknown>) => {
      await withPersonaFlag(opts['persona'], async () => {
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
    });

  // ─── auth ─────────────────────────────────────────────────────────────────
  program
    .command('login <invite-code>')
    .description(
      'Redeem an org invite code: mints did:key, enrolls, writes <persona-dir>/comms-v3.{creds,env}. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/.',
    )
    .option('--agent-name <name>', 'human-readable handle (default: short DID)')
    .option('--persona <name>', 'write to ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .option('--auth-url <url>', 'auth-issuer URL override')
    .action(async (inviteCode: string, opts: Record<string, unknown>) => {
      await withPersonaFlag(opts['persona'], async () => {
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
            // P1 substrate-unreachable fix · 2026-05-27 — surface api-key
            // status so the user knows whether substrate verbs work without
            // a separate `profile add`. `apiKeyMinted=true` ⇒ comms-v3.env
            // now carries UNBLOCK_API_KEY and `remember`/`query` will auth.
            result.apiKeyMinted
              ? `  api key:    ${result.apiKeyId ?? '(minted)'} → substrate reachable`
              : '  api key:    (not minted; substrate verbs will 401 until you `unblock profile add --api-key`)',
            result.mintedNewIdentity ? '(new identity minted)' : '(existing identity reused)',
          ].join('\n') + '\n',
        );
      });
    });

  program
    .command('logout')
    .description(
      'Remove local persona store (identity + comms creds). Idempotent. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/.',
    )
    .option('--persona <name>', 'wipe ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (opts: Record<string, unknown>) => {
      await withPersonaFlag(opts['persona'], async () => {
        const result = await runLogout();
        if (result.removed.length === 0) {
          process.stdout.write('already logged out (no files to remove)\n');
        } else {
          process.stdout.write(`removed ${String(result.removed.length)} file(s):\n`);
          for (const p of result.removed) process.stdout.write(`  ${p}\n`);
        }
      });
    });

  program
    .command('whoami')
    .description(
      'Print current persona: DID, handle, broker, workspace, JWT expiry. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/.',
    )
    .option('--json', 'machine-readable JSON output', false)
    .option('--persona <name>', 'read ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (opts: Record<string, unknown>) => {
      await withPersonaFlag(opts['persona'], async () => {
        const result = await runWhoami();
        if (opts['json'] === true) {
          process.stdout.write(`${JSON.stringify({
            did: result.did ?? null,
            handle: result.agentName ?? null,
            chat_name: result.chatName ?? null,
            broker: result.broker ?? null,
            workspace: result.workspaceId ?? null,
            org: result.orgId ?? null,
            jwt_expiry: result.jwtExpiresAt ?? null,
            jwt_expires_in_seconds: result.jwtExpiresInSeconds ?? null,
          }, null, 2)}\n`);
        } else {
          for (const line of result.lines) process.stdout.write(`${line}\n`);
        }
        process.exitCode = result.loggedIn ? 0 : 1;
      });
    });

  // ─── substrate ────────────────────────────────────────────────────────────
  program
    .command('remember <content>')
    .description('Store a block in the substrate. Returns the block_id.')
    .option('--tag <list>', 'comma-separated tags')
    .option('--parent <block_id>', 'parent block id (for hierarchical blocks)')
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (content: string, opts: Record<string, unknown>) => {
      const tags = parseList(opts['tag']);
      const result = await runRemember(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          content,
          ...(tags !== undefined ? { tags } : {}),
          ...(typeof opts['parent'] === 'string' ? { parentBlockId: opts['parent'] } : {}),
        },
      );
      process.stdout.write(`${result.blockId}\n`);
    });

  program
    .command('ingest <path>')
    .description(
      'Bulk-load a file or directory into the org-brain. Walks the FS, chunks via substrate, ' +
        'pipes each chunk through /v1/remember. Critical for the YC demo: pre-load existing ' +
        'Claude conversation history + memory files so the brain isn\'t amnesiac on day 1.',
    )
    .option('--recursive', 'walk subdirectories when <path> is a directory', false)
    .option('--format <name>', 'force reader by name (markdown | claude-jsonl | text); auto if absent')
    .option('--scope <scope>', 'private | team | public (default: private)')
    .option('--dry-run', 'parse + chunk but skip writes', false)
    .option('--concurrency <n>', 'parallel remember batches (default 1)', (v) => Number.parseInt(v, 10))
    .option('--continue-on-error', 'do not halt on per-file errors', false)
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (p: string, opts: Record<string, unknown>) => {
      const result = await runIngest(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          path: p,
          recursive: opts['recursive'] === true,
          dryRun: opts['dryRun'] === true,
          continueOnError: opts['continueOnError'] === true,
          ...(typeof opts['format'] === 'string' ? { format: opts['format'] } : {}),
          ...(typeof opts['scope'] === 'string'
            ? { scope: opts['scope'] as 'private' | 'team' | 'public' }
            : {}),
          ...(typeof opts['concurrency'] === 'number' ? { concurrency: opts['concurrency'] } : {}),
        },
      );
      // Non-zero exit if any file errored and we weren't in continue-on-error mode.
      if (result.totalErrors > 0 && opts['continueOnError'] !== true) {
        process.exitCode = 1;
      }
    });

  // ─── X11: trace ──────────────────────────────────────────────────────────────
  program
    .command('trace <id>')
    .description(
      'Pull full audit chain for a correlation-id or message-id across ' +
        'audit_events, dispatch_traces, and dispatch_rules. ' +
        'Reads SUPABASE_SERVICE_ROLE_KEY from env or .env.demo.',
    )
    .option('--json', 'emit structured JSON', false)
    .option('--supabase-url <url>', 'Supabase project URL override')
    .option('--supabase-service-role-key <key>', 'service-role key override')
    .action(async (id: string, opts: Record<string, unknown>) => {
      try {
        const result = await runTrace(
          {},
          {
            id,
            json: opts['json'] === true,
            ...(typeof opts['supabaseUrl'] === 'string' ? { supabaseUrl: opts['supabaseUrl'] } : {}),
            ...(typeof opts['supabaseServiceRoleKey'] === 'string'
              ? { supabaseServiceRoleKey: opts['supabaseServiceRoleKey'] }
              : {}),
          },
        );
        if (opts['json'] === true) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          if (result.rows.length === 0) {
            process.stdout.write(`no events found for id: ${id}\n`);
          } else {
            process.stdout.write(
              `ts                        component  action      actor                      outcome  payload\n`,
            );
            process.stdout.write(`${'─'.repeat(120)}\n`);
            for (const row of result.rows) {
              const ts = row.ts.slice(0, 23);
              const snippet = row.payloadSnippet.slice(0, 40).replace(/\n/g, ' ');
              process.stdout.write(
                `${ts.padEnd(26)}${row.component.padEnd(11)}${row.action.padEnd(12)}${row.actorDid.slice(0, 26).padEnd(27)}${row.outcome.padEnd(9)}${snippet}\n`,
              );
            }
          }
        }
      } catch (err) {
        process.stderr.write(`${errMsg(err)}\n`);
        process.exitCode = 1;
      }
    });

  // ─── X12: health ─────────────────────────────────────────────────────────────
  program
    .command('health')
    .description(
      'Synthetic health check: auth | broker | substrate | audit | all. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/. ' +
        'Exit 0 if all ok, 1 if any degraded/down.',
    )
    .option('--component <name>', 'auth | broker | substrate | audit | all (default: all)')
    .option('--json', 'emit structured JSON', false)
    .option('--supabase-url <url>', 'Supabase project URL override')
    .option('--supabase-service-role-key <key>', 'Supabase service-role key')
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (opts: Record<string, unknown>) => {
      try {
        await withPersonaFlag(opts['persona'], async () => {
          const rawComponent = opts['component'];
          const validComponents = ['auth', 'broker', 'substrate', 'audit', 'all'] as const;
          const component: ComponentName | 'all' =
            typeof rawComponent === 'string' && validComponents.includes(rawComponent as ComponentName | 'all')
              ? (rawComponent as ComponentName | 'all')
              : 'all';

          const result = await runHealth(
            { commsFactory: createNatsFactory() },
            {
              ...configOverrides(opts),
              component,
              json: opts['json'] === true,
              ...(typeof opts['supabaseUrl'] === 'string' ? { supabaseUrl: opts['supabaseUrl'] } : {}),
              ...(typeof opts['supabaseServiceRoleKey'] === 'string'
                ? { supabaseServiceRoleKey: opts['supabaseServiceRoleKey'] }
                : {}),
            },
          );

          if (opts['json'] === true) {
            process.stdout.write(`${JSON.stringify({
              components: result.components,
              subjects: result.subjects,
            }, null, 2)}\n`);
          } else {
            process.stdout.write(`${'component'.padEnd(12)}${'status'.padEnd(12)}${'latency_ms'.padEnd(14)}last_error\n`);
            process.stdout.write(`${'─'.repeat(70)}\n`);
            for (const c of result.components) {
              const status = c.status === 'ok' ? 'ok' : c.status;
              process.stdout.write(
                `${c.component.padEnd(12)}${status.padEnd(12)}${String(c.latencyMs).padEnd(14)}${c.lastError ?? ''}\n`,
              );
            }
          }

          process.exitCode = result.allOk ? 0 : 1;
        });
      } catch (err) {
        process.stderr.write(`${errMsg(err)}\n`);
        process.exitCode = 1;
      }
    });

  program
    .command('subjects')
    .description(
      'Print the current persona NATS subject map and JWT pub/sub allowlists. ' +
        'Persona dir resolution: --persona NAME (preferred) > UNBLOCK_HOME env > default ~/.unblock/.',
    )
    .option('--json', 'emit structured JSON', false)
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ instead of ~/.unblock/')
    .action(async (opts: Record<string, unknown>) => {
      try {
        await withPersonaFlag(opts['persona'], async () => {
          const result = await runSubjects();
          if (opts['json'] === true) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            process.stdout.write(formatSubjects(result));
          }
        });
      } catch (err) {
        process.stderr.write(`${errMsg(err)}\n`);
        process.exitCode = 1;
      }
    });

  const identity = program.command('identity').description('Manage local persona identity files.');

  identity
    .command('normalize')
    .description(
      'Normalize comms-v3.env UNBLOCK_CHAT_NAME to the canonical lowercase wire name. ' +
        'Dry-run by default; pass --apply to rewrite the env file in place. ' +
        'Persona dir is resolved per the standard chain (--persona flag > UNBLOCK_HOME env > default ~/.unblock/).',
    )
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/comms-v3.env (overrides UNBLOCK_HOME)')
    .option('--apply', 'rewrite comms-v3.env in place', false)
    .option('--json', 'emit structured JSON', false)
    .action(async (opts: Record<string, unknown>) => {
      try {
        const persona = typeof opts['persona'] === 'string' ? opts['persona'] : '';
        await withPersonaFlag(persona, async () => {
          const result = await runIdentityNormalize({
            persona,
            apply: opts['apply'] === true,
          });
          if (opts['json'] === true) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            process.stdout.write(formatIdentityNormalize(result, { applied: opts['apply'] === true }));
          }
        });
      } catch (err) {
        process.stderr.write(`${errMsg(err)}\n`);
        process.exitCode = 1;
      }
    });

  identity
    .command('mint-api-key')
    .description(
      'Backfill a substrate API key for a pre-W1e persona that has NATS creds ' +
        'but no UNBLOCK_API_KEY in comms-v3.env (kink #136). Mints `unb_<64hex>`, ' +
        'writes the api_keys + members rows via Supabase REST (idempotent ' +
        'ON CONFLICT), and rewrites comms-v3.env in place preserving other lines. ' +
        'Falls back to printing SQL to stdout when SUPABASE_SERVICE_ROLE_KEY is ' +
        'unavailable. Exit 0=minted (or SQL printed), 1=error, 2=already present (without --force).',
    )
    .option('--persona <name>', 'use ~/.unblock-personas/<name>/ (overrides UNBLOCK_HOME)')
    .option('--force', 'overwrite an existing UNBLOCK_API_KEY (does not revoke the old key server-side)', false)
    .option('--json', 'emit structured JSON', false)
    .option('--supabase-url <url>', 'Supabase project URL override')
    .option('--supabase-service-role-key <key>', 'service-role key override')
    .action(async (opts: Record<string, unknown>) => {
      try {
        const persona = typeof opts['persona'] === 'string' ? opts['persona'] : '';
        await withPersonaFlag(persona, async () => {
          const result = await runMintApiKey(
            {},
            {
              persona,
              force: opts['force'] === true,
              json: opts['json'] === true,
              ...(typeof opts['supabaseUrl'] === 'string' ? { supabaseUrl: opts['supabaseUrl'] } : {}),
              ...(typeof opts['supabaseServiceRoleKey'] === 'string'
                ? { supabaseServiceRoleKey: opts['supabaseServiceRoleKey'] }
                : {}),
            },
          );
          if (opts['json'] === true) {
            process.stdout.write(`${JSON.stringify({
              persona: result.persona,
              did: result.did,
              org_did: result.orgDid,
              api_key_id: result.apiKeyId,
              env_path: result.envPath,
              action: result.action,
              ...(result.sql !== undefined ? { sql: result.sql } : {}),
              ...(result.apiKey !== undefined ? { api_key: result.apiKey } : {}),
            }, null, 2)}\n`);
          } else {
            process.stdout.write(formatMintApiKey(result));
          }
          process.exitCode = MINT_API_KEY_EXIT.ok;
        });
      } catch (err) {
        if (err instanceof AlreadyPresentError) {
          process.stderr.write(`${err.message}\n`);
          process.exitCode = MINT_API_KEY_EXIT.already_present;
          return;
        }
        process.stderr.write(`${errMsg(err)}\n`);
        process.exitCode = MINT_API_KEY_EXIT.error;
      }
    });

  // ─── eval ─────────────────────────────────────────────────────────────────
  program
    .command('eval <bench>')
    .description(
      'Run a substrate benchmark (locomo10 | longmemeval | all) and write results ' +
        'to ~/.unblock/eval-<bench>-<ts>.json. Per LT-6 (YC lock-in tests): honest ' +
        'baseline numbers + reproducibility kit.',
    )
    .option(
      '--strategy <s>',
      'sample strategy: full | stratified:N (default stratified:10 per category)',
    )
    .option('--data-locomo <path>', 'override path to locomo10.json (defaults to packaged fixture)')
    .option('--data-longmemeval <path>', 'override path to LongMemEval JSON (defaults to packaged fixture)')
    .option('--out <dir>', 'output directory for the JSON report (default ~/.unblock/)')
    .option('--synth <mode>', 'synth LLM: none | openai (default none — retrieval-only baseline)')
    .option('--judge <mode>', 'judge LLM: noop | openai (default noop — plumbing only)')
    .action(async (bench: string, opts: Record<string, unknown>) => {
      if (bench !== 'locomo10' && bench !== 'longmemeval' && bench !== 'all') {
        process.stderr.write(`unknown bench '${bench}' (expected locomo10 | longmemeval | all)\n`);
        process.exitCode = 1;
        return;
      }
      const evalOpts = {
        bench: bench as EvalBench,
        ...(typeof opts['strategy'] === 'string' ? { strategy: opts['strategy'] } : {}),
        ...(typeof opts['dataLocomo'] === 'string' ? { dataLocomo: opts['dataLocomo'] } : {}),
        ...(typeof opts['dataLongmemeval'] === 'string' ? { dataLongmemeval: opts['dataLongmemeval'] } : {}),
        ...(typeof opts['out'] === 'string' ? { out: opts['out'] } : {}),
        ...(typeof opts['synth'] === 'string' ? { synth: opts['synth'] } : {}),
        ...(typeof opts['judge'] === 'string' ? { judge: opts['judge'] } : {}),
      };
      const result = await runEval({}, evalOpts);
      process.exitCode = result.exitCode;
    });

  // ─── profile ──────────────────────────────────────────────────────────────
  const profile = program.command('profile').description('Manage named profiles (multi-persona tenancy on one workstation).');

  profile
    .command('add <name>')
    .description('Add a profile. --api-key required (unb_<32hex>). --force overwrites.')
    .requiredOption('--api-key <key>', 'API key for this profile')
    .option('--catalog-api <url>', 'override catalog-api URL for this profile')
    .option('--note <text>', 'free-form note')
    .option('--force', 'overwrite if the profile already exists', false)
    .action(async (name: string, opts: Record<string, unknown>) => {
      const result = await cmdProfileAdd({
        name,
        apiKey: typeof opts['apiKey'] === 'string' ? opts['apiKey'] : '',
        ...(typeof opts['catalogApi'] === 'string' ? { catalogApi: opts['catalogApi'] } : {}),
        ...(typeof opts['note'] === 'string' ? { note: opts['note'] } : {}),
        force: opts['force'] === true,
      });
      writeProfileResult(result);
    });

  profile
    .command('list')
    .description('List all profiles. --json emits the raw registry.')
    .option('--json', 'machine-readable JSON', false)
    .action(async (opts: Record<string, unknown>) => {
      const result = await cmdProfileList({ json: opts['json'] === true });
      writeProfileResult(result);
    });

  profile
    .command('use <name>')
    .description('Set the active profile.')
    .action(async (name: string) => {
      const result = await cmdProfileUse(name);
      writeProfileResult(result);
    });

  profile
    .command('rm <name>')
    .description('Remove a profile and its per-profile state.')
    .action(async (name: string) => {
      const result = await cmdProfileRm(name);
      writeProfileResult(result);
    });

  program
    .command('query <q>')
    .description('Search the substrate. Prints hits as JSON (or one per line for piping).')
    .option('--top-k <n>', 'how many hits to return (default 10)', (v) => Number.parseInt(v, 10))
    .option('--json', 'emit JSON instead of one-block-id-per-line', false)
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (q: string, opts: Record<string, unknown>) => {
      const hits = await runQuery(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
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

  program
    .command('share <block-id> <recipient>')
    .description(
      'Grant a recipient access to a block. recipient = DID or email. ' +
        '--permission read,write,share,admin (default: read). ' +
        '--expires-at epoch-seconds.',
    )
    .option('--permission <list>', 'comma-separated: read,write,share,admin (default: read)')
    .option('--expires-at <sec>', 'grant expiry as epoch seconds', (v) => Number.parseInt(v, 10))
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (blockId: string, recipient: string, opts: Record<string, unknown>) => {
      const permissions = parseList(opts['permission']);
      const result = await runShare(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          blockId,
          recipient,
          ...(permissions !== undefined ? { permissions } : {}),
          ...(typeof opts['expiresAt'] === 'number' ? { expiresAt: opts['expiresAt'] } : {}),
        },
      );
      process.stdout.write(`share_id: ${result.shareId}\nblock_id: ${result.blockId}\n`);
    });

  program
    .command('list <block-id>')
    .description(
      'List a block on the marketplace. --price required (UNBLOCK tokens). ' +
        '--tier 1-5 (default 3). --summary up to 280 chars. --delist-existing removes prior listing.',
    )
    .requiredOption('--price <n>', 'price in UNBLOCK tokens (e.g. 4.99)', (v) => Number.parseFloat(v))
    .option('--tier <n>', 'marketplace tier 1-5 (default 3)', (v) => Number.parseInt(v, 10))
    .option('--summary <text>', 'short description (max 280 chars)')
    .option('--delist-existing', 'remove any existing listing for this block first', false)
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (blockId: string, opts: Record<string, unknown>) => {
      const result = await runListMarketplace(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          blockId,
          priceUnblock: typeof opts['price'] === 'number' ? opts['price'] : 0,
          ...(typeof opts['tier'] === 'number' ? { tier: opts['tier'] } : {}),
          ...(typeof opts['summary'] === 'string' ? { summary: opts['summary'] } : {}),
          delistExisting: opts['delistExisting'] === true,
        },
      );
      process.stdout.write(`listing_id: ${result.listingId}\n`);
    });

  program
    .command('purchase')
    .description(
      'Purchase a block or listing. Supply --block-id OR --listing-id. ' +
        '--max-price caps the spend (UNBLOCK tokens). --payment-method wallet|relay (default relay).',
    )
    .option('--block-id <id>', 'purchase by block id')
    .option('--listing-id <id>', 'purchase by listing id')
    .option('--max-price <n>', 'maximum price willing to pay (UNBLOCK tokens)', (v) => Number.parseFloat(v))
    .option('--payment-method <m>', 'wallet | relay (default relay)')
    .option('--wallet-name <name>', 'named wallet (default: "default")')
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (opts: Record<string, unknown>) => {
      if (typeof opts['blockId'] !== 'string' && typeof opts['listingId'] !== 'string') {
        process.stderr.write('error: supply --block-id or --listing-id\n');
        process.exitCode = 1;
        return;
      }
      const result = await runPurchase(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          ...(typeof opts['blockId'] === 'string' ? { blockId: opts['blockId'] } : {}),
          ...(typeof opts['listingId'] === 'string' ? { listingId: opts['listingId'] } : {}),
          ...(typeof opts['maxPrice'] === 'number' ? { maxPrice: opts['maxPrice'] } : {}),
          ...(typeof opts['paymentMethod'] === 'string'
            ? { paymentMethod: opts['paymentMethod'] as 'wallet' | 'relay' }
            : {}),
          ...(typeof opts['walletName'] === 'string' ? { walletName: opts['walletName'] } : {}),
        },
      );
      process.stdout.write(`block_id:   ${result.blockId}\nreceipt_id: ${result.receiptId}\n`);
    });

  program
    .command('verify')
    .description(
      'Verify a block\'s signature and retrieve attestations. Supply --block-id OR --content-hash.',
    )
    .option('--block-id <id>', 'block to verify')
    .option('--content-hash <hash>', 'content hash to verify against')
    .option('--signature <sig>', 'signature to validate (optional)')
    .option('--json', 'emit full JSON result instead of formatted text', false)
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (opts: Record<string, unknown>) => {
      if (typeof opts['blockId'] !== 'string' && typeof opts['contentHash'] !== 'string') {
        process.stderr.write('error: supply --block-id or --content-hash\n');
        process.exitCode = 1;
        return;
      }
      const result = await runVerify(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          ...(typeof opts['blockId'] === 'string' ? { blockId: opts['blockId'] } : {}),
          ...(typeof opts['contentHash'] === 'string' ? { contentHash: opts['contentHash'] } : {}),
          ...(typeof opts['signature'] === 'string' ? { signature: opts['signature'] } : {}),
        },
      );
      if (opts['json'] === true) {
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      } else {
        process.stdout.write(
          `block_id:         ${result.blockId}\n` +
            `signature_valid:  ${String(result.signatureValid)}\n` +
            `attestations:     ${String(result.attestations.length)}\n`,
        );
        for (const a of result.attestations) {
          process.stdout.write(`  ${a.attesterId}: ${a.statement}\n`);
        }
      }
    });

  program
    .command('attest <block-id>')
    .description(
      'Attach a quality attestation to a block. --score 0-1 required. ' +
        '--text up to 4000 chars. --signature Ed25519 hex (optional).',
    )
    .requiredOption('--score <n>', 'quality score 0.0–1.0', (v) => Number.parseFloat(v))
    .option('--text <t>', 'attestation text (max 4000 chars)')
    .option('--signature <sig>', 'Ed25519 signature hex')
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (blockId: string, opts: Record<string, unknown>) => {
      const result = await runAttest(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          blockId,
          score: typeof opts['score'] === 'number' ? opts['score'] : 0,
          ...(typeof opts['text'] === 'string' ? { attestationText: opts['text'] } : {}),
          ...(typeof opts['signature'] === 'string' ? { signature: opts['signature'] } : {}),
        },
      );
      process.stdout.write(`attestation_id: ${result.attestationId}\n`);
    });

  program
    .command('subscribe')
    .description(
      'Register a webhook for substrate events. --url (https required) --events comma-list --secret (≥16 chars). ' +
        'Events: block.created block.updated block.forgotten block.listed block.purchased block.attested ' +
        'cap-token.issued cap-token.revoked.',
    )
    .requiredOption('--url <url>', 'webhook endpoint (must be https)')
    .requiredOption('--events <list>', 'comma-separated event types')
    .requiredOption('--secret <s>', 'signing secret (min 16 chars) for HMAC verification')
    .option('--no-active', 'register as inactive (paused)')
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (opts: Record<string, unknown>) => {
      const events = parseList(opts['events']) ?? [];
      const result = await runSubscribe(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          url: typeof opts['url'] === 'string' ? opts['url'] : '',
          events,
          secret: typeof opts['secret'] === 'string' ? opts['secret'] : '',
          active: opts['active'] !== false,
        },
      );
      process.stdout.write(`subscription_id: ${result.subscriptionId}\n`);
    });

  program
    .command('update <block-id> <content>')
    .description(
      'Create a new version of an existing block. Preserves the block_id lineage. ' +
        '--revision-reason optional note. --tag comma-list. --client-msg-id for idempotency.',
    )
    .option('--revision-reason <text>', 'reason for the update (max 1000 chars)')
    .option('--tag <list>', 'comma-separated tags for the new version')
    .option('--client-msg-id <id>', 'idempotency key (max 128 chars)')
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (blockId: string, content: string, opts: Record<string, unknown>) => {
      const tags = parseList(opts['tag']);
      const result = await runUpdate(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          blockId,
          content,
          ...(tags !== undefined ? { tags } : {}),
          ...(typeof opts['revisionReason'] === 'string' ? { revisionReason: opts['revisionReason'] } : {}),
          ...(typeof opts['clientMsgId'] === 'string' ? { clientMsgId: opts['clientMsgId'] } : {}),
        },
      );
      process.stdout.write(`block_id:     ${result.blockId}\ncontent_hash: ${result.contentHash}\n`);
    });

  program
    .command('extract')
    .description(
      'Extract structured facts from a block or semantic query. ' +
        'Supply --block-id OR --query. --schema JSON object describing the desired output shape.',
    )
    .option('--block-id <id>', 'extract facts from this block')
    .option('--query <text>', 'semantic query to extract facts from (max 4000 chars)')
    .option('--schema <json>', 'JSON object describing output shape')
    .option('--json', 'emit raw JSON array instead of newline-delimited facts', false)
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (opts: Record<string, unknown>) => {
      if (typeof opts['blockId'] !== 'string' && typeof opts['query'] !== 'string') {
        process.stderr.write('error: supply --block-id or --query\n');
        process.exitCode = 1;
        return;
      }
      let schema: Record<string, unknown> | undefined;
      if (typeof opts['schema'] === 'string') {
        try {
          schema = JSON.parse(opts['schema']) as Record<string, unknown>;
        } catch {
          process.stderr.write('error: --schema must be valid JSON\n');
          process.exitCode = 1;
          return;
        }
      }
      const result = await runExtract(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          ...(typeof opts['blockId'] === 'string' ? { blockId: opts['blockId'] } : {}),
          ...(typeof opts['query'] === 'string' ? { query: opts['query'] } : {}),
          ...(schema !== undefined ? { schema } : {}),
        },
      );
      if (opts['json'] === true) {
        process.stdout.write(`${JSON.stringify(result.facts, null, 2)}\n`);
      } else {
        for (const fact of result.facts) {
          process.stdout.write(`${JSON.stringify(fact)}\n`);
        }
      }
    });

  program
    .command('forget <block-id>')
    .description(
      'Tombstone (soft) or permanently delete (hard) a block. Default mode: soft. ' +
        '--mode hard triggers GDPR-compliant purge. --gdpr flags a data-subject request.',
    )
    .option('--mode <m>', 'soft | hard (default soft)')
    .option('--reason <text>', 'reason for deletion (max 2000 chars)')
    .option('--gdpr', 'flag as a data-subject deletion request', false)
    .option('--auth-url <url>', 'auth-issuer URL override')
    .option('--substrate-url <url>', 'substrate API URL override')
    .option('--api-key <key>', 'API key override (unb_<32hex>)')
    .action(async (blockId: string, opts: Record<string, unknown>) => {
      const mode =
        typeof opts['mode'] === 'string' && opts['mode'] === 'hard' ? 'hard' : 'soft';
      const result = await runForget(
        { substrateFactory: createHttpSubstrateFactory() },
        {
          ...(await substrateConfigOverrides(opts)),
          blockId,
          mode,
          ...(typeof opts['reason'] === 'string' ? { reason: opts['reason'] } : {}),
          gdprRequest: opts['gdpr'] === true,
        },
      );
      const eligibleAt =
        result.hardDeleteEligibleAt !== null
          ? new Date(result.hardDeleteEligibleAt * 1000).toISOString()
          : 'n/a';
      process.stdout.write(
        `block_id:                ${result.blockId}\n` +
          `deleted_at:              ${new Date(result.deletedAt * 1000).toISOString()}\n` +
          `mode:                    ${result.mode}\n` +
          `cascade_count:           ${String(result.cascadeCount)}\n` +
          `hard_delete_eligible_at: ${eligibleAt}\n`,
      );
    });

  // ─── skill (W2a un-cut: YC demo install flow) ────────────────────────────────
  registerSkillCommands(program);

  return program;
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function writeProfileResult(result: ProfileResult): void {
  for (const line of result.stdout) process.stdout.write(`${line}\n`);
  for (const line of result.stderr) process.stderr.write(`${line}\n`);
  if (result.exitCode !== 0) process.exitCode = result.exitCode;
}

/**
 * Substrate-aware config overrides for `remember` / `query` / etc.
 *
 * In addition to the comms overrides, this loads the active profile's
 * `api_key` from `~/.unblock/profiles/<active>/api_key` when neither
 * `--api-key` flag nor `UNBLOCK_API_KEY` env is set. Without that the
 * substrate EF returns 401 AUTH_MISSING for every verb.
 */
async function substrateConfigOverrides(
  opts: Record<string, unknown>,
): Promise<Record<string, string>> {
  const base = configOverrides(opts);
  if (base['apiKey'] !== undefined) return base;
  if (typeof process.env['UNBLOCK_API_KEY'] === 'string' && process.env['UNBLOCK_API_KEY'].trim() !== '') {
    return base;
  }
  // Resolve active profile (best-effort — no profile = no key, let the
  // substrate 401 with a clear message).
  try {
    const reg = await loadRegistry();
    if (reg.active === null) return base;
    const key = await readProfileKey(reg.active);
    if (key === null) return base;
    return { ...base, apiKey: key };
  } catch {
    return base;
  }
}

/**
 * Run `fn` with the persona dir override active when the user passed
 * `--persona NAME`. Restores the override on exit so subsequent commands
 * (or repeated `program.parseAsync` calls inside tests) start clean.
 *
 * The override resolves to `~/.unblock-personas/<NAME>/` — same layout
 * `mint --persona NAME` writes to.
 */
async function withPersonaFlag(
  rawPersona: unknown,
  fn: () => Promise<void>,
): Promise<void> {
  if (typeof rawPersona !== 'string' || rawPersona.trim() === '') {
    await fn();
    return;
  }
  setPersonaDirOverride(personaHomeFor(rawPersona.trim()));
  try {
    await fn();
  } finally {
    setPersonaDirOverride(null);
  }
}

function configOverrides(opts: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof opts['name'] === 'string') out['name'] = opts['name'];
  if (typeof opts['natsUrl'] === 'string') out['natsUrl'] = opts['natsUrl'];
  if (typeof opts['authUrl'] === 'string') out['authUrl'] = opts['authUrl'];
  if (typeof opts['substrateUrl'] === 'string') out['substrateUrl'] = opts['substrateUrl'];
  if (typeof opts['apiKey'] === 'string') out['apiKey'] = opts['apiKey'];
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

/**
 * Detect whether `import.meta.url` belongs to the entry-point file.
 * Resolves symlinks on `entry` because `npm link` (and `npm install -g`)
 * install the bin via a symlink: `process.argv[1]` ends up at the symlink
 * path while `import.meta.url` resolves to the real file path, so a naive
 * URL compare returns false and `main()` never runs.
 */
export function isEntryPoint(importMetaUrl: string, entry: string | undefined): boolean {
  if (entry === undefined) return false;
  let resolved: string;
  try {
    resolved = realpathSync(entry);
  } catch {
    resolved = entry;
  }
  return importMetaUrl === pathToFileURL(resolved).href;
}

// Only run as a process when invoked directly (as the bin script).
const invokedDirectly = isEntryPoint(import.meta.url, process.argv[1]);

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
