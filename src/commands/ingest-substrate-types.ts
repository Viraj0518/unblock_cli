/**
 * Local type stubs that mirror the public surface of `unblock_substrate`'s
 * ingest module. We deliberately don't `import type { … } from
 * "unblock_substrate"` because:
 *
 *   - The CLI is not yet wired to depend on substrate via npm/workspace
 *     (the package is on GitHub, not yet workspace-linked). When that
 *     lands, swap these stubs for real imports and delete this file.
 *   - The boundary check forbids `@unblock/<other-pkg>` deep imports;
 *     these local types let us stay clean.
 *
 * Source of truth: `unblock_substrate/src/ingest/types.ts`. Keep these
 * shapes structurally compatible.
 */

export interface RawDocument {
  readonly content: string;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface RawChunk {
  readonly content: string;
  readonly chunkIndex: number;
  readonly chunkCount: number;
  readonly metadata: Readonly<Record<string, unknown>>;
}

export interface Reader {
  readonly name: string;
  read(input: { readonly text: string; readonly uri: string }): readonly RawDocument[];
}

export interface SubstrateIngestModule {
  readerForExtension(ext: string): Reader;
  readerByName(name: string): Reader;
  knownReaderNames(): readonly string[];
  chunkDocuments(docs: readonly RawDocument[]): readonly RawChunk[];
}
