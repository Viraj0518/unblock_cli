import { describe, it, expect } from 'vitest';
import { version } from '../src/index.js';
import { main } from '../src/main.js';

describe('unblock_cli public surface', () => {
  it('exports a version string', () => {
    expect(typeof version).toBe('string');
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('main() throws "not implemented" until the v02-mig port lands', async () => {
    await expect(main([])).rejects.toThrow(/not implemented/);
  });
});
