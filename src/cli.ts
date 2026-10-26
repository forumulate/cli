#!/usr/bin/env node
import { createInterface } from 'node:readline';
import { ForumulateClient } from '@forumulate/sdk';
import { resolveTokenSource, takeTokenFlag } from './credentials';
import { EXIT } from './exit-codes';
import { envWarnings } from './whoami';
import { run, VERSION } from './run';
import { apiBaseFromEnv } from './api-base';
import { fileSink, globalOut, streamSink } from './io';

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
  // `--token` first, then the environment, then what `login` stored for THIS
  // API — see `credentials.ts` for why the env var beats the file (FMU-D06).
  // The flag is global (FMU-DOC01): `run()` takes it out of the arguments the
  // same way and hands it to every transport it builds.
  const flagToken = takeTokenFlag(process.argv.slice(2)).token;
  const token = resolveTokenSource(baseUrl, process.env, flagToken).token;
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
  const argv = process.argv.slice(2);
  // FMU-B02/D05: stdout through a sink that is flushed before we exit, into
  // `--out <file>` when given (commands that own `--out` keep their meaning).
  const outPath = globalOut(argv);
  const stdout = outPath ? fileSink(outPath) : streamSink(process.stdout);
  const stderr = streamSink(process.stderr);
  const code = await run(argv, {
    client,
    baseUrl,
    authed: Boolean(token),
    upload,
    prompt: askSecret,
    // A push in CI has no one to ask: it needs --yes, rather than hanging on stdin.
    ask: process.stdin.isTTY ? ask : undefined,
    out: (l) => stdout.line(l),
    err: (l) => stderr.line(l),
  });
  /*
   * `process.exitCode`, then wait for every byte, then exit.
   *
   * `process.exit(code)` here is what cut piped output at 64 KiB. Exiting at
   * all is still needed — fetch's keep-alive sockets would hold the process
   * open for seconds — but only once both streams report everything flushed.
   * A write the OS refused is a failure, whatever the command thought.
   */
  // A refused token is the moment a misspelt variable matters (FMU-D06).
  if (code === EXIT.AUTH) for (const w of envWarnings(process.env)) stderr.line(w);
  process.exitCode = code;
  const outError = await stdout.finish();
  const errError = await stderr.finish();
  if (outError) {
    const pipeClosed = (outError as NodeJS.ErrnoException).code === 'EPIPE';
    if (!pipeClosed)
      process.stderr.write(`forumulate: could not write output: ${outError.message}\n`);
    process.exitCode = code || 1;
  } else if (errError && !code) process.exitCode = 1;
  process.exit(process.exitCode);
}

void main();
