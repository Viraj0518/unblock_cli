/**
 * Profile subcommand tests — `add`, `list`, `use`, `rm`.
 *
 * Each subcommand returns a structured `ProfileResult` (exit code + lines)
 * so we can assert on outcomes without scraping stdout/stderr.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cmdProfileAdd,
  cmdProfileList,
  cmdProfileRm,
  cmdProfileUse,
} from '../../src/profile/commands.js';
import {
  loadRegistry,
  readProfileKey,
} from '../../src/profile/registry.js';
import { makeTmpHome, type TmpHome } from '../_fixtures/tmp-home.js';

let tmp: TmpHome;

beforeEach(async () => {
  tmp = await makeTmpHome();
});
afterEach(async () => {
  await tmp.dispose();
});

const KEY_A = `unb_${'a'.repeat(32)}`;
const KEY_B = `unb_${'b'.repeat(32)}`;

describe('cmdProfileAdd', () => {
  it('rejects invalid name', async () => {
    const r = await cmdProfileAdd({ name: 'BadName', apiKey: KEY_A });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join('\n')).toMatch(/invalid profile name/);
  });

  it('rejects malformed api key', async () => {
    const r = await cmdProfileAdd({ name: 'alpha', apiKey: 'nope' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join('\n')).toMatch(/unb_<32hex>/);
  });

  it('adds a new profile, sets it active when it is the first', async () => {
    const r = await cmdProfileAdd({ name: 'alpha', apiKey: KEY_A });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join('\n')).toMatch(/ok added profile "alpha"/);
    expect(r.stdout.join('\n')).toMatch(/active profile -> alpha/);
    const reg = await loadRegistry();
    expect(reg.active).toBe('alpha');
    expect(reg.profiles['alpha']).toBeDefined();
    expect(await readProfileKey('alpha')).toBe(KEY_A);
  });

  it('preserves the previously active profile when adding a second', async () => {
    await cmdProfileAdd({ name: 'alpha', apiKey: KEY_A });
    const r = await cmdProfileAdd({ name: 'beta', apiKey: KEY_B });
    expect(r.exitCode).toBe(0);
    const reg = await loadRegistry();
    expect(reg.active).toBe('alpha');
    expect(Object.keys(reg.profiles).sort()).toEqual(['alpha', 'beta']);
  });

  it('refuses to overwrite without --force', async () => {
    await cmdProfileAdd({ name: 'alpha', apiKey: KEY_A });
    const r = await cmdProfileAdd({ name: 'alpha', apiKey: KEY_B });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join('\n')).toMatch(/already exists/);
    expect(await readProfileKey('alpha')).toBe(KEY_A);
  });

  it('overwrites with --force', async () => {
    await cmdProfileAdd({ name: 'alpha', apiKey: KEY_A });
    const r = await cmdProfileAdd({ name: 'alpha', apiKey: KEY_B, force: true });
    expect(r.exitCode).toBe(0);
    expect(await readProfileKey('alpha')).toBe(KEY_B);
  });

  it('persists catalog_api and note on the entry', async () => {
    await cmdProfileAdd({
      name: 'alpha',
      apiKey: KEY_A,
      catalogApi: 'https://example.test',
      note: 'tracer',
    });
    const reg = await loadRegistry();
    expect(reg.profiles['alpha']?.catalog_api).toBe('https://example.test');
    expect(reg.profiles['alpha']?.note).toBe('tracer');
  });
});

describe('cmdProfileList', () => {
  it('reports empty state', async () => {
    const r = await cmdProfileList();
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join('\n')).toMatch(/no profiles/);
  });

  it('lists added profiles with the active tag', async () => {
    await cmdProfileAdd({ name: 'alpha', apiKey: KEY_A });
    await cmdProfileAdd({ name: 'beta', apiKey: KEY_B });
    const r = await cmdProfileList();
    expect(r.exitCode).toBe(0);
    const joined = r.stdout.join('\n');
    expect(joined).toMatch(/alpha \(active\)/);
    expect(joined).toMatch(/^ {2}beta/m);
  });

  it('--json emits a JSON-parseable single line', async () => {
    await cmdProfileAdd({ name: 'alpha', apiKey: KEY_A });
    const r = await cmdProfileList({ json: true });
    expect(r.exitCode).toBe(0);
    const parsed = JSON.parse(r.stdout.join('\n')) as Record<string, unknown>;
    expect(parsed['active']).toBe('alpha');
    expect(typeof parsed['profiles']).toBe('object');
  });
});

describe('cmdProfileUse', () => {
  it('flips the active profile', async () => {
    await cmdProfileAdd({ name: 'alpha', apiKey: KEY_A });
    await cmdProfileAdd({ name: 'beta', apiKey: KEY_B });
    const r = await cmdProfileUse('beta');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join('\n')).toMatch(/active profile -> beta/);
    const reg = await loadRegistry();
    expect(reg.active).toBe('beta');
  });

  it('errors on unknown profile', async () => {
    const r = await cmdProfileUse('ghost');
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join('\n')).toMatch(/not found/);
  });

  it('rejects invalid name without touching disk', async () => {
    const r = await cmdProfileUse('Bad-NAME');
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join('\n')).toMatch(/invalid profile name/);
  });
});

describe('cmdProfileRm', () => {
  it('removes the profile and its key file', async () => {
    await cmdProfileAdd({ name: 'alpha', apiKey: KEY_A });
    const r = await cmdProfileRm('alpha');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.join('\n')).toMatch(/ok removed profile "alpha"/);
    const reg = await loadRegistry();
    expect(reg.profiles['alpha']).toBeUndefined();
    expect(reg.active).toBeNull();
    expect(await readProfileKey('alpha')).toBeNull();
  });

  it('clears active only when removing the active profile', async () => {
    await cmdProfileAdd({ name: 'alpha', apiKey: KEY_A });
    await cmdProfileAdd({ name: 'beta', apiKey: KEY_B });
    // alpha is active (first-added); remove beta.
    await cmdProfileRm('beta');
    const reg = await loadRegistry();
    expect(reg.active).toBe('alpha');
  });

  it('errors on unknown profile', async () => {
    const r = await cmdProfileRm('ghost');
    expect(r.exitCode).toBe(2);
    expect(r.stderr.join('\n')).toMatch(/not found/);
  });
});
