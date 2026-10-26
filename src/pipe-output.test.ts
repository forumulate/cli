import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { exec, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The output contract, end to end, through a real pipe (FMU-B02).
 *
 * `forumulate items list --json | wc -c` said 65536 while the same command into
 * a file wrote 8 MB: `process.exit()` ran before Node had flushed a pipe it
 * writes asynchronously. Only the built binary, in a child process, writing
 * into an OS pipe can show that — an in-process test captures lines in an
 * array and could never have failed. So this serves a 12 MB answer, runs the
 * CLI twice (into `| cat | sha256sum`, and with `--out`), and requires the
 * same bytes both ways. Runs on the desk after `pnpm --filter @forumulate/cli
 * build`; without a build there is no binary to test, and it says so.
 */
const CLI = join(__dirname, '..', 'dist', 'cli.js');
const built = existsSync(CLI);
let server: Server;
let base = '';

beforeAll(async () => {
  // ~12 MB of rows, so the answer is far past both observed cut points.
  const rows = Array.from({ length: 60_000 }, (_, i) => ({
    id: `row-${i}`,
    title: `Row ${i} `.repeat(12),
    body: 'x'.repeat(80),
  }));
  const payload = JSON.stringify({ rows });
  server = createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(payload);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** Run the CLI with stdout into a real OS pipe, through a `cat` process, and hash what arrives. */
function pipedHash(args: string[], env: NodeJS.ProcessEnv): Promise<{ hash: string; code: number }> {
  return new Promise((resolve, reject) => {
    const cli = spawn(process.execPath, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    // `cat` written in node, so the test is the same on Windows, macOS and Linux.
    const cat = spawn(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    cli.stdout.pipe(cat.stdin);
    const hash = createHash('sha256');
    cat.stdout.on('data', (c: Buffer) => hash.update(c));
    let code = -1;
    cli.on('exit', (c) => (code = c ?? -1));
    cat.on('close', () => resolve({ hash: hash.digest('hex'), code }));
    cli.on('error', reject);
    cat.on('error', reject);
  });
}

/**
 * The CLI as a child, awaited. Never `execFileSync`: the fake API answers from
 * THIS process, and a synchronous child would block the loop it answers on.
 */
function runCli(args: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], { env, stdio: 'ignore' });
    child.on('exit', (c) => resolve(c ?? -1));
    child.on('error', reject);
  });
}

describe.skipIf(!built)('piped --json is never truncated', () => {
  it('pipe and --out carry the same ≥10 MB, byte for byte', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-pipe-'));
    const env = {
      ...process.env,
      FORUMULATE_API_URL: base,
      FORUMULATE_TOKEN: 'cft_test',
      FORUMULATE_CONFIG_DIR: dir,
    };
    const args = ['api', 'GET', '/big', '--json'];
    const piped = await pipedHash(args, env);
    const outFile = join(dir, 'big.json');
    expect(await runCli([...args, '--out', outFile], env)).toBe(0);
    const bytes = readFileSync(outFile);
    expect(bytes.length).toBeGreaterThan(10 * 1024 * 1024);
    expect(piped.code).toBe(0);
    expect(piped.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    // And the literal `| cat | sha256sum` the report used, where there is a POSIX shell.
    if (process.platform !== 'win32') {
      const { stdout } = await promisify(exec)(
        `node ${JSON.stringify(CLI)} ${args.join(' ')} | cat | (sha256sum 2>/dev/null || shasum -a 256)`,
        { env, shell: '/bin/sh' },
      );
      const sh = stdout.split(/\s+/)[0];
      expect(sh).toBe(piped.hash);
    }
  }, 120_000);

  it('a failed write is a non-zero exit, not a silent truncation', async () => {
    const env = { ...process.env, FORUMULATE_API_URL: base, FORUMULATE_TOKEN: 'cft_test' };
    const code = await runCli(
      ['api', 'GET', '/big', '--json', '--out', join(tmpdir(), 'no-such-dir-fm', 'x.json')],
      env,
    );
    expect(code).not.toBe(0);
  }, 60_000);
});

describe.skipIf(built)('without a build', () => {
  it('has no binary to pipe (build packages/cli first)', () => {
    expect(built).toBe(false);
  });
});
