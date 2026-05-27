/**
 * Regression: when `npm link` or `npm install -g` install the bin,
 * `process.argv[1]` is the symlink (npm's global bin dir) but
 * `import.meta.url` resolves to the real source file. A naive URL
 * compare returns false → `main()` never runs → `unblock --help`
 * silently exits 0 on Windows.
 *
 * `isEntryPoint()` realpath-resolves `entry` before comparing, so
 * symlinked installs work cross-platform.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntryPoint } from '../src/main.js';

describe('isEntryPoint', () => {
  it('returns false when entry is undefined', () => {
    expect(isEntryPoint('file:///a/b.js', undefined)).toBe(false);
  });

  it('returns true when entry matches import.meta.url literally', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'unblock-entry-test-'));
    const file = join(tmp, 'main.js');
    writeFileSync(file, '// test');
    const url = pathToFileURL(file).href;
    expect(isEntryPoint(url, file)).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false when entry resolves to a different file', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'unblock-entry-test-'));
    const a = join(tmp, 'a.js');
    const b = join(tmp, 'b.js');
    writeFileSync(a, '// a');
    writeFileSync(b, '// b');
    expect(isEntryPoint(pathToFileURL(a).href, b)).toBe(false);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns true when entry is a symlink pointing at import.meta.url', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'unblock-entry-test-'));
    const real = join(tmp, 'real.js');
    const link = join(tmp, 'link.js');
    writeFileSync(real, '// real');
    try {
      symlinkSync(real, link, 'file');
    } catch (err: unknown) {
      // Windows requires admin OR developer mode for symlinks. Skip cleanly.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') {
        rmSync(tmp, { recursive: true, force: true });
        return;
      }
      throw err;
    }
    expect(isEntryPoint(pathToFileURL(real).href, link)).toBe(true);
    rmSync(tmp, { recursive: true, force: true });
  });

  it('returns false (does not throw) when entry path does not exist', () => {
    const phantom = join(tmpdir(), 'unblock-nonexistent-' + Date.now() + '.js');
    expect(existsSync(phantom)).toBe(false);
    // Should fall back to using `entry` as-is when realpathSync throws.
    expect(isEntryPoint('file:///elsewhere.js', phantom)).toBe(false);
  });
});
