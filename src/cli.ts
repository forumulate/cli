#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { ForumulateClient } from '@forumulate/sdk';
import { resolveToken } from './credentials';
import { run } from './run';
import { apiBaseFromEnv } from './api-base';

/**
 * Read one line the user types, without echoing it.
 *
 * A token pasted into a terminal that echoes it is a token in the scrollback,
 * and on a shared screen that is the whole secret. Falls back to a plain read
 * when stdin is not a TTY (a pipe, CI), where there is nothing to hide it from.
 */
function askSecret(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  return new Promise((resolve) => {
    const stdout = process.stdout as NodeJS.WriteStream & { isTTY?: boolean };
    if (stdout.isTTY) {
      const write = (rl as unknown as { _writeToOutput?: (s: string) => void })._writeToOutput;
      (rl as unknown as { _writeToOutput: (s: string) => void })._writeToOutput = (s: string) => {
        if (s.includes(question)) write?.call(rl, s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (stdout.isTTY) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const baseUrl = apiBaseFromEnv();
  // The environment first, then what `login` stored for THIS API — see
  // `credentials.ts` for why the env var still wins.
  const token = resolveToken(baseUrl);
  const client = new ForumulateClient({ baseUrl, token });
  const code = await run(process.argv.slice(2), {
    client,
    baseUrl,
    prompt: askSecret,
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
  });
  process.exit(code);
}

void main();
