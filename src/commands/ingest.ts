/**
 * `unblock ingest <path> [--recursive] [--format=md|jsonl|text]
 *                       [--scope=private|team|public]
 *                       [--dry-run] [--concurrency=N]
 *                       [--continue-on-error]`
 *
 * Bulk-load a file or directory of files into the org-brain. Walks the
 * filesystem, chunks each file via substrate's readers + chunker, then
 * sends each chunk through the same `remember` write path used by single-
 * block `unblock remember`.
 *
 * Why this exists (org-brain context):
 *   The org-brain is amnesiac on day 1 unless we can pre-load Viraj's
 *   existing Claude conversation history + memory files. This is the
 *   surface that makes that possible. Critical for YC demo
 *   (project_unblock_yc_demo_priority_20260524).
 *
 * Reader dispatch is by file extension, falling back to `--format`. The
 * full set of supported formats is whatever substrate's `knownReaderNames`
 * returns — today: markdown, claude-jsonl, text.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

import type { SubstrateFactory } from '../sdk/types.js';
import { resolveConfig, type ConfigOverrides } from '../config.js';

// We depend on substrate ONLY through the public surface (no deep
// imports). The check-boundaries rule lets `@unblock/protocol` through
// but blocks any other `@unblock/<pkg>/src/**`. The substrate is wired
// here via a relative file lookup at runtime — see substrateIngestModule
// for the indirection that keeps the boundary check happy.
import type {
  RawChunk,
  RawDocument,
  Reader,
} from './ingest-substrate-types.js';
import { loadSubstrateIngest } from './ingest-substrate-load.js';

export interface IngestDeps {
  readonly substrateFactory: SubstrateFactory;
  /**
   * Optional override for substrate-side primitives. Tests pass a stub
   * so the command can run without resolving the substrate package.
   */
  readonly substrateIngest?: {
    readerForExtension(ext: string): Reader;
    readerByName(name: string): Reader;
    knownReaderNames(): readonly string[];
    chunkDocuments(docs: readonly RawDocument[]): readonly RawChunk[];
  };
  /** Caller-supplied JWT getter once auth-issuer is wired. */
  readonly token?: () => Promise<string>;
  /** Override for filesystem read — tests inject an in-memory FS. */
  readonly fs?: {
    readFile(p: string): Promise<string>;
    readdir(p: string, opts: { withFileTypes: true }): Promise<readonly DirEntry[]>;
    stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  };
  /** Override for stdout writes (for testable summary output). */
  readonly stdout?: (s: string) => void;
}

export interface DirEntry {
  readonly name: string;
  isFile(): boolean;
  isDirectory(): boolean;
}

export interface IngestOptions extends ConfigOverrides {
  /** Filesystem path — single file or directory. */
  readonly path: string;
  /** Walk subdirs when `path` is a directory. Default false. */
  readonly recursive?: boolean;
  /** Force a reader by name (markdown / claude-jsonl / text); auto if absent. */
  readonly format?: string;
  /** Block scope. Default 'private'. */
  readonly scope?: 'private' | 'team' | 'public';
  /** Parse + chunk but skip writes. Default false. */
  readonly dryRun?: boolean;
  /** Per-window parallel remembers. Default 1 (sequential). */
  readonly concurrency?: number;
  /** Continue past per-file errors instead of throwing. Default false. */
  readonly continueOnError?: boolean;
}

export interface IngestPerFileResult {
  readonly file: string;
  /** Chunks the substrate accepted. */
  readonly ingested: number;
  /** Chunks the sensing-gate or content-hash idempotency skipped. */
  readonly skipped: number;
  /** Per-file errors (parse / chunk / remember). */
  readonly errors: readonly string[];
  /** Reader name used. */
  readonly reader: string;
}

export interface IngestOutput {
  /** Per-file outcome. */
  readonly perFile: readonly IngestPerFileResult[];
  /** Sum of all `ingested`. */
  readonly totalIngested: number;
  /** Sum of all `skipped`. */
  readonly totalSkipped: number;
  /** Total error count across all files. */
  readonly totalErrors: number;
  /** Elapsed wall time in milliseconds. */
  readonly elapsedMs: number;
  /** True when the command ran in --dry-run mode. */
  readonly dryRun: boolean;
}

const DEFAULT_SCOPE: 'private' | 'team' | 'public' = 'private';

export async function runIngest(deps: IngestDeps, opts: IngestOptions): Promise<IngestOutput> {
  const fs = deps.fs ?? defaultFs();
  const stdout = deps.stdout ?? ((s: string): void => {
    process.stdout.write(s);
  });
  const substrateIngest = deps.substrateIngest ?? (await loadSubstrateIngest());

  const cfg = await resolveConfig(opts);
  const startMs = Date.now();

  // 1. Discover the file list. A single file or a (recursively) walked dir.
  const root = path.resolve(opts.path);
  const files = await collectFiles(fs, root, opts.recursive === true);
  if (files.length === 0) {
    throw new Error(`ingest: no supported files found under "${opts.path}"`);
  }

  // 2. Substrate client — only constructed if we'll actually write. In
  //    dry-run mode we never hit the wire.
  const client = opts.dryRun === true
    ? undefined
    : deps.substrateFactory.create({
        authUrl: cfg.authUrl,
        ...(deps.token !== undefined ? { token: deps.token } : {}),
      });

  // 3. For each file: pick reader, read text, chunk, remember each chunk.
  const scope = opts.scope ?? DEFAULT_SCOPE;
  const perFile: IngestPerFileResult[] = [];
  for (const file of files) {
    const reader = pickReader(file, opts.format, substrateIngest);
    const result = await ingestOneFile({
      file,
      reader,
      fs,
      substrateIngest,
      client,
      scope,
      dryRun: opts.dryRun === true,
      concurrency: Math.max(1, opts.concurrency ?? 1),
      continueOnError: opts.continueOnError === true,
    });
    perFile.push(result);
    if (!opts.continueOnError && result.errors.length > 0) {
      break;
    }
  }

  const totalIngested = perFile.reduce((a, b) => a + b.ingested, 0);
  const totalSkipped = perFile.reduce((a, b) => a + b.skipped, 0);
  const totalErrors = perFile.reduce((a, b) => a + b.errors.length, 0);
  const elapsedMs = Date.now() - startMs;

  // 4. Pretty-print the summary table.
  writeSummary(stdout, { perFile, totalIngested, totalSkipped, totalErrors, elapsedMs, dryRun: opts.dryRun === true });

  return { perFile, totalIngested, totalSkipped, totalErrors, elapsedMs, dryRun: opts.dryRun === true };
}

// ─── per-file pipeline ───────────────────────────────────────────────────────

interface IngestOneInput {
  readonly file: string;
  readonly reader: Reader;
  readonly fs: NonNullable<IngestDeps['fs']>;
  readonly substrateIngest: NonNullable<IngestDeps['substrateIngest']>;
  readonly client:
    | ReturnType<SubstrateFactory['create']>
    | undefined;
  readonly scope: 'private' | 'team' | 'public';
  readonly dryRun: boolean;
  readonly concurrency: number;
  readonly continueOnError: boolean;
}

async function ingestOneFile(input: IngestOneInput): Promise<IngestPerFileResult> {
  const { file, reader, fs, substrateIngest, client, dryRun, concurrency, continueOnError } = input;
  const errors: string[] = [];
  let text: string;
  try {
    text = await fs.readFile(file);
  } catch (err) {
    return {
      file,
      ingested: 0,
      skipped: 0,
      errors: [`read failed: ${errMsg(err)}`],
      reader: reader.name,
    };
  }

  let docs: readonly RawDocument[];
  try {
    docs = reader.read({ text, uri: file });
  } catch (err) {
    return {
      file,
      ingested: 0,
      skipped: 0,
      errors: [`parse failed: ${errMsg(err)}`],
      reader: reader.name,
    };
  }

  const chunks = substrateIngest.chunkDocuments(docs);
  if (chunks.length === 0) {
    return { file, ingested: 0, skipped: 0, errors: [], reader: reader.name };
  }

  if (dryRun || client === undefined) {
    return { file, ingested: 0, skipped: chunks.length, errors: [], reader: reader.name };
  }

  // POST each chunk to /v1/remember through the SubstrateClient. Bounded
  // concurrency keeps RAM/connection use bounded for large directories.
  let ingested = 0;
  let skipped = 0;
  for (let i = 0; i < chunks.length; i += concurrency) {
    const window = chunks.slice(i, i + concurrency);
    const results = await Promise.all(
      window.map((c) => rememberChunk(client, c, input.scope, continueOnError)),
    );
    for (const r of results) {
      if (r.kind === 'ingested') ingested += 1;
      else if (r.kind === 'skipped') skipped += 1;
      else {
        errors.push(r.message);
        if (!continueOnError) {
          return { file, ingested, skipped, errors, reader: reader.name };
        }
      }
    }
  }
  return { file, ingested, skipped, errors, reader: reader.name };
}

interface RememberOutcome {
  readonly kind: 'ingested' | 'skipped' | 'error';
  readonly message: string;
}

async function rememberChunk(
  client: ReturnType<SubstrateFactory['create']>,
  chunk: RawChunk,
  _scope: 'private' | 'team' | 'public',
  _continueOnError: boolean,
): Promise<RememberOutcome> {
  // Today the SubstrateClient.remember surface only accepts
  // (content, tags?, parentBlockId?). The richer metadata (chunk_index,
  // source_uri, etc.) needs the auth-issuer's /v1/remember to grow a
  // `metadata` field — tracked as open question 5 in the deliverable.
  // For now we pass content; downstream filtering won't be able to
  // query by chunk_index until that lands.
  try {
    await client.remember({ content: chunk.content });
    return { kind: 'ingested', message: '' };
  } catch (err) {
    return { kind: 'error', message: errMsg(err) };
  }
}

// ─── filesystem discovery ────────────────────────────────────────────────────

async function collectFiles(
  fs: NonNullable<IngestDeps['fs']>,
  root: string,
  recursive: boolean,
): Promise<readonly string[]> {
  const st = await fs.stat(root);
  if (st.isFile()) {
    return [root];
  }
  if (!st.isDirectory()) {
    throw new Error(`ingest: path "${root}" is neither a file nor a directory`);
  }
  const out: string[] = [];
  await walkDir(fs, root, recursive, out);
  out.sort();
  return out;
}

async function walkDir(
  fs: NonNullable<IngestDeps['fs']>,
  dir: string,
  recursive: boolean,
  out: string[],
): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (recursive) await walkDir(fs, full, recursive, out);
      continue;
    }
    if (!e.isFile()) continue;
    // Filter by extension — defer to extensionLooksSupported so we don't
    // require the substrateIngest module just to do shape filtering.
    if (extensionLooksSupported(full)) out.push(full);
  }
}

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown', '.jsonl', '.txt', '.log']);

function extensionLooksSupported(p: string): boolean {
  return SUPPORTED_EXTENSIONS.has(path.extname(p).toLowerCase());
}

// ─── reader selection ────────────────────────────────────────────────────────

function pickReader(
  file: string,
  format: string | undefined,
  substrateIngest: NonNullable<IngestDeps['substrateIngest']>,
): Reader {
  if (format !== undefined && format.length > 0) {
    return substrateIngest.readerByName(format);
  }
  const ext = path.extname(file);
  return substrateIngest.readerForExtension(ext);
}

// ─── output ──────────────────────────────────────────────────────────────────

function writeSummary(stdout: (s: string) => void, out: IngestOutput): void {
  const lines: string[] = [];
  lines.push('');
  lines.push(`ingest summary${out.dryRun ? ' (DRY RUN — no writes)' : ''}:`);
  lines.push('  file                                                          reader        chunks  ingested  skipped  errors');
  for (const r of out.perFile) {
    const chunkCount = r.ingested + r.skipped;
    lines.push(
      `  ${pad(short(r.file), 60)}  ${pad(r.reader, 12)}  ${padNum(chunkCount, 6)}  ${padNum(r.ingested, 8)}  ${padNum(r.skipped, 7)}  ${padNum(r.errors.length, 6)}`,
    );
    for (const e of r.errors) {
      lines.push(`    ! ${e}`);
    }
  }
  lines.push('  ' + '─'.repeat(110));
  lines.push(
    `  ${pad('TOTAL', 60)}  ${pad('', 12)}  ${padNum(out.totalIngested + out.totalSkipped, 6)}  ${padNum(out.totalIngested, 8)}  ${padNum(out.totalSkipped, 7)}  ${padNum(out.totalErrors, 6)}`,
  );
  lines.push(`  elapsed: ${String(out.elapsedMs)}ms`);
  lines.push('');
  stdout(lines.join('\n'));
}

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}
function padNum(n: number, w: number): string {
  const s = String(n);
  if (s.length >= w) return s;
  return ' '.repeat(w - s.length) + s;
}
function short(p: string): string {
  if (p.length <= 60) return p;
  return '…' + p.slice(p.length - 59);
}

// ─── defaults ────────────────────────────────────────────────────────────────

function defaultFs(): NonNullable<IngestDeps['fs']> {
  return {
    async readFile(p: string): Promise<string> {
      return readFile(p, 'utf-8');
    },
    async readdir(p: string, _opts: { withFileTypes: true }): Promise<readonly DirEntry[]> {
      const entries = await readdir(p, { withFileTypes: true });
      return entries.map((e) => ({
        name: e.name,
        isFile: () => e.isFile(),
        isDirectory: () => e.isDirectory(),
      }));
    },
    async stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }> {
      const s = await stat(p);
      return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory() };
    },
  };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
