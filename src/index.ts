// This package is APP-shaped (terminal node with a `bin` entry, not a library).
// `package.json#exports` is `null`, so consumers cannot `import` from this file.
// It exists only so the build is uniform with the rest of the polyrepo (every
// package compiles a `src/index.ts`).
//
// All real entry-point behavior lives in `src/main.ts`, which is what the
// `unblock` bin resolves to.

export const version = '0.0.0';
