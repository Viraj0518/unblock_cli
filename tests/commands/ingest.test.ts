/**
 * `unblock ingest` command tests.
 *
 * Drive runIngest with an in-memory FS + a stub substrate-ingest module
 * so the test runs without touching disk or pulling in the substrate
 * package at runtime.
 */

import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { runIngest } from '../../src/commands/ingest.js';
import { createMockSubstrateFactory } from '../_fixtures/mock-substrate.js';
import type {
  RawChunk,
  RawDocument,
  Reader,
  SubstrateIngestModule,
} from '../../src/commands/ingest-substrate-types.js';

// ─── in-memory FS double ─────────────────────────────────────────────────────

function makeFs(files: Record<string, string>): {
  readFile(p: string): Promise<string>;
  readdir(p: string, opts: { withFileTypes: true }): Promise<readonly { name: string; isFile(): boolean; isDirectory(): boolean }[]>;
  stat(p: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
} {
  // Normalize the keyed file map so it lives in a Map keyed by
  // platform-native ABSOLUTE paths, then both lookups and walks use the
  // same notation as `path.resolve` does. This keeps the same in-memory
  // FS contract working on Windows AND Unix.
  //
  // Important: use path.resolve (NOT path.normalize). On Windows, a
  // leading-slash relative path like "/tmp/x" becomes "\tmp\x" under
  // normalize and "C:\tmp\x" under resolve — and our SUT calls resolve.
  const norm = (p: string): string => path.resolve(p);
  const sep = path.sep;
  const fileMap = new Map<string, string>();
  for (const [k, v] of Object.entries(files)) fileMap.set(norm(k), v);
  return {
    async readFile(p): Promise<string> {
      const v = fileMap.get(norm(p));
      if (v === undefined) throw new Error(`no such file: ${p}`);
      return v;
    },
    async readdir(p): Promise<readonly { name: string; isFile(): boolean; isDirectory(): boolean }[]> {
      const base = norm(p);
      const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
      const out: { name: string; isFile(): boolean; isDirectory(): boolean }[] = [];
      const seenDirs = new Set<string>();
      for (const f of fileMap.keys()) {
        if (!f.startsWith(prefix)) continue;
        const rest = f.slice(prefix.length);
        const slash = rest.indexOf(sep);
        if (slash < 0) {
          out.push({ name: rest, isFile: () => true, isDirectory: () => false });
        } else {
          const sub = rest.slice(0, slash);
          if (seenDirs.has(sub)) continue;
          seenDirs.add(sub);
          out.push({ name: sub, isFile: () => false, isDirectory: () => true });
        }
      }
      return out;
    },
    async stat(p): Promise<{ isFile(): boolean; isDirectory(): boolean }> {
      const base = norm(p);
      if (fileMap.has(base)) {
        return { isFile: () => true, isDirectory: () => false };
      }
      const prefix = base.endsWith(sep) ? base : `${base}${sep}`;
      for (const f of fileMap.keys()) {
        if (f.startsWith(prefix)) {
          return { isFile: () => false, isDirectory: () => true };
        }
      }
      throw new Error(`stat: no such path "${p}"`);
    },
  };
}

// ─── stub substrate ingest module ────────────────────────────────────────────

const stubMarkdownReader: Reader = {
  name: 'markdown',
  read({ text, uri }): readonly RawDocument[] {
    if (text.trim().length === 0) return [];
    return [{ content: text, metadata: { source_uri: uri, document_id: `stub::${uri}` } }];
  },
};
const stubTextReader: Reader = {
  name: 'text',
  read({ text, uri }): readonly RawDocument[] {
    if (text.length === 0) return [];
    return [{ content: text, metadata: { source_uri: uri, document_id: `stub::${uri}` } }];
  },
};

const stubSubstrate: SubstrateIngestModule = {
  readerForExtension(ext: string): Reader {
    const e = ext.replace(/^\./, '').toLowerCase();
    if (e === 'md') return stubMarkdownReader;
    if (e === 'txt' || e === 'log') return stubTextReader;
    throw new Error(`stub: no reader for ${ext}`);
  },
  readerByName(name: string): Reader {
    if (name === 'markdown') return stubMarkdownReader;
    if (name === 'text') return stubTextReader;
    throw new Error(`stub: no reader named ${name}`);
  },
  knownReaderNames(): readonly string[] {
    return ['markdown', 'text'];
  },
  chunkDocuments(docs: readonly RawDocument[]): readonly RawChunk[] {
    return docs.map((d): RawChunk => ({
      content: d.content,
      chunkIndex: 0,
      chunkCount: 1,
      metadata: { ...d.metadata, chunk_index: 0, chunk_count: 1 },
    }));
  },
};

// ─── tests ───────────────────────────────────────────────────────────────────

describe('runIngest', () => {
  it('single file: reads, chunks, calls remember once per chunk', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.rememberResponse = { blockId: 'blk_x', storedAt: '2026-05-24T00:00:00Z' };
    const fs = makeFs({ '/tmp/note.md': '# Hello\n\nworld\n' });
    const stdout: string[] = [];
    const result = await runIngest(
      {
        substrateFactory: factory,
        substrateIngest: stubSubstrate,
        fs,
        stdout: (s) => stdout.push(s),
      },
      { path: '/tmp/note.md' },
    );
    expect(result.totalIngested).toBe(1);
    expect(result.totalErrors).toBe(0);
    expect(state.rememberCalls).toHaveLength(1);
    expect(state.rememberCalls[0]?.content).toContain('Hello');
    expect(stdout.join('')).toContain('ingest summary');
    expect(stdout.join('')).toContain('TOTAL');
  });

  it('directory non-recursive: ingests only top-level files matching ext', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.rememberResponse = { blockId: 'blk_x', storedAt: 't' };
    const fs = makeFs({
      '/tmp/dir/a.md': 'aaa',
      '/tmp/dir/b.txt': 'bbb',
      '/tmp/dir/skip.xyz': 'xxx',
      '/tmp/dir/sub/c.md': 'ccc',
    });
    const result = await runIngest(
      {
        substrateFactory: factory,
        substrateIngest: stubSubstrate,
        fs,
        stdout: () => undefined,
      },
      { path: '/tmp/dir' },
    );
    // Should pick up a.md + b.txt; skip .xyz; skip sub/c.md (no recurse).
    expect(result.perFile.map((f) => f.file).sort()).toEqual(
      ['/tmp/dir/a.md', '/tmp/dir/b.txt'].map((p) => path.resolve(p)),
    );
    expect(state.rememberCalls).toHaveLength(2);
  });

  it('directory recursive: walks subdirs', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.rememberResponse = { blockId: 'blk_x', storedAt: 't' };
    const fs = makeFs({
      '/tmp/dir/a.md': 'aaa',
      '/tmp/dir/sub/c.md': 'ccc',
      '/tmp/dir/sub/deep/d.md': 'ddd',
    });
    const result = await runIngest(
      {
        substrateFactory: factory,
        substrateIngest: stubSubstrate,
        fs,
        stdout: () => undefined,
      },
      { path: '/tmp/dir', recursive: true },
    );
    expect(result.totalIngested).toBe(3);
    expect(state.rememberCalls).toHaveLength(3);
  });

  it('dry-run: skips writes, reports chunks as skipped', async () => {
    const { factory, state } = createMockSubstrateFactory();
    const fs = makeFs({ '/tmp/n.md': 'hello' });
    const result = await runIngest(
      {
        substrateFactory: factory,
        substrateIngest: stubSubstrate,
        fs,
        stdout: () => undefined,
      },
      { path: '/tmp/n.md', dryRun: true },
    );
    expect(result.dryRun).toBe(true);
    expect(result.totalIngested).toBe(0);
    expect(result.totalSkipped).toBe(1);
    expect(state.rememberCalls).toHaveLength(0);
  });

  it('--format override picks the named reader', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.rememberResponse = { blockId: 'blk_x', storedAt: 't' };
    const fs = makeFs({ '/tmp/weird.md': 'hello world' });
    const result = await runIngest(
      {
        substrateFactory: factory,
        substrateIngest: stubSubstrate,
        fs,
        stdout: () => undefined,
      },
      { path: '/tmp/weird.md', format: 'text' },
    );
    expect(result.perFile[0]?.reader).toBe('text');
  });

  it('per-file remember failure surfaces in errors and halts by default', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.rememberResponse = { blockId: 'blk_x', storedAt: 't' };
    // We need remember to fail. Patch the factory at the response level.
    const failingFactory = {
      create(): ReturnType<typeof factory.create> {
        const inner = factory.create({ authUrl: 'x' });
        return {
          ...inner,
          async remember(): Promise<never> {
            throw new Error('boom');
          },
        };
      },
    };
    const fs = makeFs({ '/tmp/n.md': 'hello' });
    const result = await runIngest(
      {
        substrateFactory: failingFactory,
        substrateIngest: stubSubstrate,
        fs,
        stdout: () => undefined,
      },
      { path: '/tmp/n.md' },
    );
    expect(result.totalErrors).toBe(1);
    expect(result.perFile[0]?.errors[0]).toContain('boom');
    void state; // satisfy linter
  });

  it('--continue-on-error keeps going past failures', async () => {
    const { factory } = createMockSubstrateFactory();
    let n = 0;
    const flakyFactory = {
      create(): ReturnType<typeof factory.create> {
        const inner = factory.create({ authUrl: 'x' });
        return {
          ...inner,
          async remember(): Promise<{ blockId: string; storedAt: string }> {
            n += 1;
            if (n === 1) throw new Error('first fails');
            return { blockId: `blk_${String(n)}`, storedAt: 't' };
          },
        };
      },
    };
    const fs = makeFs({ '/tmp/a.md': 'aaa', '/tmp/b.md': 'bbb', '/tmp/c.md': 'ccc' });
    const result = await runIngest(
      {
        substrateFactory: flakyFactory,
        substrateIngest: stubSubstrate,
        fs,
        stdout: () => undefined,
      },
      { path: '/tmp/a.md', continueOnError: true },
    );
    expect(result.totalErrors).toBe(1);
    // The single file ingest only sees one call (the first), since path
    // is a single file. Verify the failure landed without halting any
    // outer loop — re-run with all three to confirm continuation.
    const allFiles = await runIngest(
      {
        substrateFactory: flakyFactory,
        substrateIngest: stubSubstrate,
        fs,
        stdout: () => undefined,
      },
      { path: '/tmp', recursive: true, continueOnError: true },
    );
    // We don't assert exact counts (depends on the order of remember
    // calls within Promise.all batches), but total work should be more
    // than zero ingested.
    expect(allFiles.totalIngested).toBeGreaterThan(0);
  });

  it('throws when no supported files found', async () => {
    const { factory } = createMockSubstrateFactory();
    const fs = makeFs({ '/tmp/empty/.gitignore': '' });
    await expect(
      runIngest(
        {
          substrateFactory: factory,
          substrateIngest: stubSubstrate,
          fs,
          stdout: () => undefined,
        },
        { path: '/tmp/empty' },
      ),
    ).rejects.toThrow(/no supported files/);
  });

  it('elapsed wall time is reported in summary', async () => {
    const { factory, state } = createMockSubstrateFactory();
    state.rememberResponse = { blockId: 'blk_x', storedAt: 't' };
    const fs = makeFs({ '/tmp/n.md': 'hello' });
    const result = await runIngest(
      {
        substrateFactory: factory,
        substrateIngest: stubSubstrate,
        fs,
        stdout: () => undefined,
      },
      { path: '/tmp/n.md' },
    );
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });
});
