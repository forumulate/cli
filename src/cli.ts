#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { ForumulateClient } from '@forumulate/sdk';
import { resolveToken } from './credentials';
import { run, VERSION } from './run';
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

/** A visible question, for a y/N; no answer where nobody can type one. */
function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

async function main(): Promise<void> {
  const baseUrl = apiBaseFromEnv();
  // The environment first, then what `login` stored for THIS API — see
  // `credentials.ts` for why the env var still wins.
  const token = resolveToken(baseUrl);
  /*
   * Named, because the edge in front of the hosted API answers a default
   * library User-Agent with a block page (Cloudflare 1010) rather than JSON —
   * and our own scripts each learned that separately.
   */
  const userAgent = `@forumulate/cli/${VERSION}`;
  const client = new ForumulateClient({ baseUrl, token, headers: { 'User-Agent': userAgent } });
  /** Multipart for asset uploads: the SDK's `request` always sends JSON. */
  const upload = async (path: string, form: FormData): Promise<unknown> => {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: { 'User-Agent': userAgent, ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: form,
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as { error?: { code?: string; message?: string } }) : {};
    if (!res.ok)
      throw Object.assign(new Error(json.error?.message ?? res.statusText), {
        status: res.status,
        code: json.error?.code,
      });
    return json;
  };
  const code = await run(process.argv.slice(2), {
    client,
    baseUrl,
    authed: Boolean(token),
    upload,
    prompt: askSecret,
    // A push in CI has no one to ask: it needs --yes, rather than hanging on stdin.
    ask: process.stdin.isTTY ? ask : undefined,
    out: (l) => process.stdout.write(l + '\n'),
    err: (l) => process.stderr.write(l + '\n'),
  });
  process.exit(code);
}

void main();
