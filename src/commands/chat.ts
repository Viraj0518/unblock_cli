/**
 * `unblock chat` — interactive REPL entry. Thin wrapper that wires stdin
 * → async line iterator and stdout → out sink, then hands off to
 * `runChatRepl`.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import type { CommsFactory } from '../sdk/types.js';
import { runChatRepl } from '../interactive/chat-repl.js';
import type { ConfigOverrides } from '../config.js';

export interface ChatDeps {
  readonly commsFactory: CommsFactory;
}

export async function runChat(deps: ChatDeps, opts: ConfigOverrides = {}): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout, terminal: stdin.isTTY === true });
  const linesIn: AsyncIterable<string> = {
    [Symbol.asyncIterator]: () => rl[Symbol.asyncIterator](),
  };
  try {
    await runChatRepl(
      {
        commsFactory: deps.commsFactory,
        linesIn,
        out: (line) => {
          stdout.write(`${line}\n`);
        },
      },
      opts,
    );
  } finally {
    rl.close();
  }
}
