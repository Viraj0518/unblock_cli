/**
 * Runtime loader for substrate's ingest module.
 *
 * Until `unblock_substrate` is workspace-linked (Stage 3 of polyrepo
 * decomposition), the CLI looks up the substrate package at runtime via
 * a configurable resolution path:
 *
 *   1. `UNBLOCK_SUBSTRATE_DIST` env (CI / test override — points at
 *      `<repo>/dist/index.js`).
 *   2. `UNBLOCK_SUBSTRATE_MODULE` env (a bare module specifier or path,
 *      passed directly to `import()`).
 *   3. Sibling package at `../unblock_substrate/dist/index.js` relative
 *      to this file (the canonical local-dev layout).
 *
 * If none resolve, throws a clear error telling the user how to wire it.
 * Tests pass `deps.substrateIngest` directly and never call this.
 *
 * Boundary note: the dynamic import means the boundary-check script
 * doesn't see a static `@unblock/substrate` import, which is correct —
 * we are NOT taking a deep import; we're taking the package's published
 * root surface at runtime.
 */

import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { SubstrateIngestModule } from './ingest-substrate-types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export async function loadSubstrateIngest(): Promise<SubstrateIngestModule> {
  const candidates = candidateSpecifiers();
  let lastErr: unknown;
  for (const spec of candidates) {
    try {
      // The dynamic-import spec must be a URL or a bare module name.
      // For absolute filesystem paths we convert to a file:// URL so
      // Windows backslash paths round-trip correctly.
      const url = spec.startsWith('file://') || !path.isAbsolute(spec)
        ? spec
        : pathToFileURL(spec).href;
      const mod: unknown = await import(url);
      const m = mod as Partial<SubstrateIngestModule>;
      if (
        typeof m.readerForExtension === 'function' &&
        typeof m.readerByName === 'function' &&
        typeof m.knownReaderNames === 'function' &&
        typeof m.chunkDocuments === 'function'
      ) {
        return m as SubstrateIngestModule;
      }
      lastErr = new Error(
        `loaded module from "${spec}" but it does not export the expected ingest surface`,
      );
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    [
      'ingest: could not resolve unblock_substrate ingest module.',
      'Tried:',
      ...candidates.map((c) => `  - ${c}`),
      'Set UNBLOCK_SUBSTRATE_DIST to an absolute path to substrate dist/index.js',
      `Last error: ${errMsg(lastErr)}`,
    ].join('\n'),
  );
}

function candidateSpecifiers(): readonly string[] {
  const out: string[] = [];
  const distEnv = process.env['UNBLOCK_SUBSTRATE_DIST'];
  if (distEnv && distEnv.length > 0) out.push(distEnv);
  const modEnv = process.env['UNBLOCK_SUBSTRATE_MODULE'];
  if (modEnv && modEnv.length > 0) out.push(modEnv);
  // Sibling polyrepo (canonical local layout).
  out.push(path.resolve(HERE, '..', '..', '..', '..', 'unblock_substrate', 'dist', 'index.js'));
  // Bare module — works if substrate ever lands in npm/workspace.
  out.push('unblock_substrate');
  return out;
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
