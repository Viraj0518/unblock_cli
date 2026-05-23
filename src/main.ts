#!/usr/bin/env node
// `unblock` CLI entry point. Apps have a main; packages don't.
//
// Exported `main` is testable in isolation. The bottom-of-file invocation only
// runs when this file is loaded as the process entry point (i.e. as the `bin`
// script), so importing this module from tests doesn't trigger process.exit.

import { pathToFileURL } from 'node:url';

export async function main(argv: readonly string[]): Promise<void> {
  // implementation lands when unblock-v02-mig/packages/unblock-cli ports in
  throw new Error(`cli not implemented yet (argv: ${argv.join(' ')})`);
}

// Only run as a process when invoked directly (as the bin script). Comparing
// `import.meta.url` to `pathToFileURL(process.argv[1])` is the cross-platform
// ESM idiom for "is this the entry point?" — handles Windows backslashes and
// drive-letter prefixes correctly, unlike a naive string match.
const entry = process.argv[1];
const invokedDirectly = entry !== undefined &&
  import.meta.url === pathToFileURL(entry).href;

if (invokedDirectly) {
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`${String(err)}\n`);
    process.exit(1);
  });
}
