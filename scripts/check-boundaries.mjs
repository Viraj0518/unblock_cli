#!/usr/bin/env node
/**
 * Boundary check — runs the rules from AGENTS.md §1 mechanically over src/.
 * Exits non-zero if any rule fires.
 *
 * Rules:
 *   1. No imports from any path containing `_shared/`
 *   2. No imports from `@unblock/<other-pkg>` deep paths (root `@unblock/protocol` OK)
 *   3. No `process.env.X ?? <default>` in src/ (config is required, not silent)
 *   4. No `as never` / `as unknown as` blind casts (per feedback_honest_typescript_fixes)
 *   5. No `@ts-ignore` (per same)
 *   6. No bare `Buffer.` usage without `import { Buffer } from "node:buffer"`
 *
 * The script is plain Node (no deps) so it can run before `pnpm install`
 * completes in CI's first leg.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const SRC = join(ROOT, 'src');

const violations = [];

/** @param {string} dir */
function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full);
    else if (entry.endsWith('.ts')) checkFile(full);
  }
}

/** @param {string} file */
function checkFile(file) {
  const text = readFileSync(file, 'utf-8');
  const lines = text.split(/\r?\n/);
  const rel = relative(ROOT, file).replace(/\\/g, '/');

  // Track whether this file declares an explicit Buffer import (any line).
  const hasBufferImport = /from\s+["']node:buffer["']/.test(text);

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const trimmed = line.trim();

    // Rule 1: _shared/
    if (/from\s+['"][^'"]*\/_shared\//.test(line)) {
      violations.push(`${rel}:${lineNo} — import from _shared/ (rule 1)`);
    }

    // Rule 2: @unblock/<pkg>/src/** deep imports (root @unblock/foo OK)
    const m = line.match(/from\s+['"](@unblock\/[a-z0-9-]+)(\/[^'"]+)['"]/);
    if (m && m[2] !== undefined && m[2] !== '/') {
      violations.push(`${rel}:${lineNo} — deep @unblock import "${m[1]}${m[2]}" (rule 2)`);
    }

    // Rule 3: process.env.X ?? <default>
    if (/process\.env\.[A-Z_]+\s*\?\?\s*['"`]/.test(line)) {
      violations.push(`${rel}:${lineNo} — process.env.X ?? "<default>" (rule 3)`);
    }
    if (/process\.env\[['"][A-Z_]+['"]\]\s*\?\?\s*['"`]/.test(line)) {
      violations.push(`${rel}:${lineNo} — process.env["X"] ?? "<default>" (rule 3)`);
    }

    // Rule 4: as never / as unknown as X / ts-ignore
    if (/\bas\s+never\b/.test(trimmed) && !trimmed.startsWith('//')) {
      violations.push(`${rel}:${lineNo} — \`as never\` (rule 4)`);
    }
    if (/\bas\s+unknown\s+as\s+/.test(trimmed) && !trimmed.startsWith('//')) {
      violations.push(`${rel}:${lineNo} — \`as unknown as X\` (rule 4)`);
    }

    // Rule 5: @ts-ignore (allow @ts-expect-error which is type-checked)
    if (/@ts-ignore/.test(line)) {
      violations.push(`${rel}:${lineNo} — @ts-ignore (rule 5)`);
    }

    // Rule 6: bare Buffer. usage without import
    if (!hasBufferImport && /\bBuffer\.(from|alloc|byteLength|isBuffer)\b/.test(line)) {
      violations.push(`${rel}:${lineNo} — bare Buffer.* without \`import { Buffer } from "node:buffer"\` (rule 6)`);
    }
  });
}

walk(SRC);

if (violations.length > 0) {
  process.stderr.write(`check-boundaries: ${violations.length} violation(s)\n`);
  for (const v of violations) process.stderr.write(`  ${v}\n`);
  process.exit(1);
}
process.stdout.write('check-boundaries: ok\n');
