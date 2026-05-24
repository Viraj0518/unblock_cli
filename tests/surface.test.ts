import { describe, it, expect } from 'vitest';
import { version } from '../src/index.js';
import { main } from '../src/main.js';

describe('unblock_cli public surface', () => {
  it('exports a version string', () => {
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('main() exists as an async function', () => {
    expect(typeof main).toBe('function');
    // Commander's --version + --help call process.exit, so we don't drive
    // main() at the surface layer — runtime behavior is covered by the
    // per-command tests in tests/commands/.
  });
});
