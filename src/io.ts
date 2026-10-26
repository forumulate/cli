import { createWriteStream, type WriteStream } from 'node:fs';
import type { Writable } from 'node:stream';

/**
 * Where a command's output goes, and the promise that it got there (FMU-B02/D05).
 *
 * `--json` piped into another program stopped at exactly 65,536 or 131,072
 * bytes: the CLI called `process.exit()` the moment the command returned, and
 * on a pipe Node writes stdout asynchronously, so whatever was still queued
 * was thrown away — `items list --json | wc -c` said 65536 while the same
 * command into a file wrote 8 MB. A sink buffers nothing of its own; it writes
 * through, counts what the stream has not yet flushed, and `finish()` waits for
 * the stream to say every byte is handed to the OS before the process ends.
 * A write the OS refuses (a closed pipe, a full disk) is remembered and turns
 * into a non-zero exit, rather than a truncated file and an exit 0.
 */
export interface Sink {
  line(text: string): void;
  /** Resolves once everything written is flushed; the first write error, if any. */
  finish(): Promise<Error | undefined>;
}

export function streamSink(stream: Writable, opts: { closeOnFinish?: boolean } = {}): Sink {
  let failed: Error | undefined;
  stream.on('error', (e: Error) => {
    failed ??= e;
  });
  return {
    line(text: string) {
      if (failed) return;
      try {
        stream.write(`${text}\n`);
      } catch (e) {
        failed ??= e as Error;
      }
    },
    finish() {
      return new Promise((resolve) => {
        let settled = false;
        const done = (e?: Error | null) => {
          if (settled) return;
          settled = true;
          resolve(failed ?? e ?? undefined);
        };
        if (failed) return done();
        // A stream that errors never finishes: listen for both.
        stream.once('error', (e: Error) => done(e));
        // `end`'s callback carries the error, and Node runs it BEFORE the
        // 'error' event: dropping its argument resolved "no error" for an
        // `--out` into a missing directory, and the CLI exited 0 having
        // written nothing.
        if (opts.closeOnFinish)
          (stream as WriteStream).end((e?: Error | null) => done(e ?? undefined));
        // An empty write's callback runs after every earlier write has flushed.
        else stream.write('', (e) => done(e ?? undefined));
      });
    },
  };
}

/**
 * `--out <file>`: stdout into a file, opened on the first line so a command
 * that prints nothing leaves no empty file behind. The write errors (no such
 * directory, permission) surface on `finish()` like a pipe's.
 */
export function fileSink(path: string): Sink {
  let inner: Sink | undefined;
  return {
    line(text: string) {
      inner ??= streamSink(createWriteStream(path), { closeOnFinish: true });
      inner.line(text);
    },
    finish() {
      return inner ? inner.finish() : Promise.resolve(undefined);
    },
  };
}

/** Commands whose own `--out` means "the file this command writes", not "my stdout". */
export const OWNS_OUT = new Set(['content', 'translations', 'i18n']);

/** The `--out` value a global redirect should use, or undefined. */
export function globalOut(argv: string[]): string | undefined {
  const cmd = argv.find((a) => !a.startsWith('-'));
  if (cmd && OWNS_OUT.has(cmd)) return undefined;
  const inline = argv.find((a) => a.startsWith('--out='));
  if (inline) return inline.slice(6) || undefined;
  const at = argv.indexOf('--out');
  const v = at >= 0 ? argv[at + 1] : undefined;
  return v && !v.startsWith('--') ? v : undefined;
}
