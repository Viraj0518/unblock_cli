/**
 * Profile registry tests — atomic write / locking / CAS / mode-600 / paths.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile, stat } from 'node:fs/promises';
import {
  isValidApiKey,
  isValidProfileName,
  loadRegistry,
  profileCheckpointPath,
  profileDir,
  profileKeyPath,
  profilesRegistryPath,
  readProfileKey,
  removeProfileDir,
  updateRegistryCAS,
  withRegistryLock,
  writeProfileKey,
} from '../../src/profile/registry.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;

beforeEach(async () => {
  tmp = await makeTmpHome();
});
afterEach(async () => {
  await tmp.dispose();
});

describe('profile/registry — paths', () => {
  it('paths live under UNBLOCK_HOME', () => {
    expect(profilesRegistryPath()).toContain(tmp.home);
    expect(profilesRegistryPath().endsWith('profiles.json')).toBe(true);
    expect(profileDir('alpha')).toContain(tmp.home);
    expect(profileKeyPath('alpha').endsWith('api_key')).toBe(true);
    expect(profileCheckpointPath('alpha').endsWith('import-progress.db')).toBe(true);
  });

  it('isValidProfileName accepts canonical and rejects garbage', () => {
    expect(isValidProfileName('alpha')).toBe(true);
    expect(isValidProfileName('alpha-1_2')).toBe(true);
    expect(isValidProfileName('a')).toBe(true);
    expect(isValidProfileName('Alpha')).toBe(false);
    expect(isValidProfileName('-bad')).toBe(false);
    expect(isValidProfileName('')).toBe(false);
    expect(isValidProfileName('x'.repeat(33))).toBe(false);
  });

  it('isValidApiKey enforces unb_<32hex>', () => {
    expect(isValidApiKey(`unb_${'a'.repeat(32)}`)).toBe(true);
    expect(isValidApiKey('unb_ABC' + 'a'.repeat(29))).toBe(false); // uppercase hex
    expect(isValidApiKey('unb_short')).toBe(false);
    expect(isValidApiKey('')).toBe(false);
  });
});

describe('profile/registry — load + save + CAS', () => {
  it('loadRegistry returns empty when the file is missing', async () => {
    const reg = await loadRegistry();
    expect(reg).toEqual({ generation: 0, active: null, profiles: {} });
  });

  it('updateRegistryCAS commits and bumps generation', async () => {
    await updateRegistryCAS<void>((reg) => ({
      commit: true,
      result: undefined,
      next: {
        generation: reg.generation,
        active: 'alpha',
        profiles: { alpha: { created_at: 1 } },
      },
    }));
    const after = await loadRegistry();
    expect(after.active).toBe('alpha');
    expect(after.generation).toBe(1);
    expect(after.profiles['alpha']).toBeDefined();
  });

  it('updateRegistryCAS with commit:false is a no-op', async () => {
    await updateRegistryCAS<void>(() => ({ commit: false, result: undefined }));
    const after = await loadRegistry();
    expect(after.generation).toBe(0);
    expect(after.active).toBeNull();
  });

  it('two sequential CAS commits increment generation by one each', async () => {
    await updateRegistryCAS<void>((reg) => ({
      commit: true,
      result: undefined,
      next: { generation: reg.generation, active: null, profiles: { a: { created_at: 1 } } },
    }));
    await updateRegistryCAS<void>((reg) => ({
      commit: true,
      result: undefined,
      next: {
        generation: reg.generation,
        active: 'a',
        profiles: { ...reg.profiles },
      },
    }));
    const after = await loadRegistry();
    expect(after.generation).toBe(2);
    expect(after.active).toBe('a');
  });
});

describe('profile/registry — key file', () => {
  it('writeProfileKey rejects malformed keys', async () => {
    await expect(writeProfileKey('alpha', 'nope')).rejects.toThrow(/invalid API key/);
  });

  it('writeProfileKey + readProfileKey round-trip', async () => {
    const key = `unb_${'b'.repeat(32)}`;
    const written = await writeProfileKey('alpha', key);
    expect(written).toBe(profileKeyPath('alpha'));
    const read = await readProfileKey('alpha');
    expect(read).toBe(key);
  });

  it('writeProfileKey lands the file at mode 600 on POSIX (best-effort on Win32)', async () => {
    const key = `unb_${'c'.repeat(32)}`;
    await writeProfileKey('alpha', key);
    const st = await stat(profileKeyPath('alpha'));
    if (process.platform !== 'win32') {
      // 0o600 == 384 in decimal; mask away file-type bits.
      expect(st.mode & 0o777).toBe(0o600);
    } else {
      // Windows fs APIs ignore the mode; just assert the file exists and is readable.
      expect(st.isFile()).toBe(true);
    }
  });

  it('readProfileKey returns null when the key file is missing', async () => {
    expect(await readProfileKey('does-not-exist')).toBeNull();
  });

  it('removeProfileDir is idempotent', async () => {
    await writeProfileKey('alpha', `unb_${'d'.repeat(32)}`);
    await removeProfileDir('alpha');
    expect(await readProfileKey('alpha')).toBeNull();
    // Second call: no throw.
    await removeProfileDir('alpha');
  });
});

describe('profile/registry — lock', () => {
  it('withRegistryLock serialises overlapping calls', async () => {
    const order: number[] = [];
    const slow = withRegistryLock(async () => {
      order.push(1);
      await new Promise((r) => setTimeout(r, 50));
      order.push(2);
    });
    // Kick off the second one slightly later; it must wait.
    const fast = (async (): Promise<void> => {
      await new Promise((r) => setTimeout(r, 5));
      await withRegistryLock(async () => {
        order.push(3);
      });
    })();
    await Promise.all([slow, fast]);
    // 1 and 2 must come before 3 — second mkdir blocked until first released.
    expect(order).toEqual([1, 2, 3]);
  });
});

describe('profile/registry — write shape', () => {
  it('writes a parseable JSON object with the expected keys', async () => {
    await updateRegistryCAS<void>((reg) => ({
      commit: true,
      result: undefined,
      next: {
        generation: reg.generation,
        active: 'alpha',
        profiles: { alpha: { created_at: 17, note: 'first' } },
      },
    }));
    const raw = await readFile(profilesRegistryPath(), 'utf-8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed['generation']).toBe(1);
    expect(parsed['active']).toBe('alpha');
    expect(typeof parsed['profiles']).toBe('object');
  });
});
