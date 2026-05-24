/**
 * Test fixture — give each test an isolated `~/.unblock` directory.
 *
 * Sets UNBLOCK_HOME to a unique tmp dir per test, restores on dispose.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface TmpHome {
  readonly home: string;
  dispose(): Promise<void>;
}

export async function makeTmpHome(): Promise<TmpHome> {
  const dir = await mkdtemp(path.join(tmpdir(), 'unblock-cli-test-'));
  const prev = process.env['UNBLOCK_HOME'];
  process.env['UNBLOCK_HOME'] = dir;
  return {
    home: dir,
    dispose: async (): Promise<void> => {
      if (prev === undefined) delete process.env['UNBLOCK_HOME'];
      else process.env['UNBLOCK_HOME'] = prev;
      await rm(dir, { recursive: true, force: true });
    },
  };
}
