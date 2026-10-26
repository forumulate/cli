#!/usr/bin/env node
/**
 * The pipe-output contract (FMU-B02) for ONE Node binary, without vitest.
 *
 *   node packages/cli/scripts/pipe-check.mjs [--node /path/to/node] [--mb 12]
 *
 * `src/pipe-output.test.ts` proves it under whichever Node runs the test lane.
 * The report's acceptance is wider — macOS and Linux, Node 20, 22 and 24 — and
 * the truncation it described is a property of the RUNTIME (when a pipe write
 * is asynchronous, and what `process.exit()` does to it), so it has to be run
 * once per runtime. `scripts/cli-pipe-matrix.sh` calls this with each Node.
 *
 * Serves a ≥10 MB JSON answer from this process, runs the built CLI under
 * `--node` three ways — into `| cat | sha256sum` through /bin/sh, through a
 * plain OS pipe read here, and with `--out <file>` — and requires the same
 * bytes from all three. Then a write that cannot succeed (`--out` into a
 * missing directory) must exit non-zero. Exit 0 when every check holds.
 */
import { spawn, exec } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const argv = process.argv.slice(2);
const flag = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : dflt;
};
const NODE = flag('--node', process.execPath);
const MB = Number(flag('--mb', '12'));
const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');
if (!existsSync(CLI)) {
  console.error(`pipe-check: no ${CLI} — run pnpm --filter @forumulate/cli build first`);
  process.exit(2);
}

const version = await new Promise((resolve, reject) => {
  const p = spawn(NODE, ['-p', 'process.version'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  p.stdout.on('data', (c) => (out += c));
  p.on('close', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`${NODE}: exit ${code}`))));
  p.on('error', reject);
});

// Rows until the payload is past both cut points the report measured (64/128 KiB) many times over.
const rows = [];
let size = 0;
for (let i = 0; size < MB * 1024 * 1024; i += 1) {
  const row = { id: `row-${i}`, title: `Row ${i} `.repeat(12), body: 'x'.repeat(80) };
  size += JSON.stringify(row).length + 1;
  rows.push(row);
}
const payload = JSON.stringify({ rows });
const server = createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(payload);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const dir = mkdtempSync(join(tmpdir(), 'fm-pipe-'));
const env = {
  ...process.env,
  FORUMULATE_API_URL: base,
  FORUMULATE_TOKEN: 'cft_test',
  FORUMULATE_CONFIG_DIR: dir,
};
const args = ['api', 'GET', '/big', '--json'];
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

/** stdout into an OS pipe this process reads — the child never sees a file or a TTY. */
const piped = () =>
  new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    const hash = createHash('sha256');
    let bytes = 0;
    child.stdout.on('data', (c) => {
      hash.update(c);
      bytes += c.length;
    });
    child.on('close', (code) => resolve({ code, bytes, hash: hash.digest('hex') }));
    child.on('error', reject);
  });

/** The CLI as a child, awaited (the fake API answers from THIS loop, so never a sync spawn). */
const run = (extra) =>
  new Promise((resolve, reject) => {
    const child = spawn(NODE, [CLI, ...args, ...extra], { env, stdio: 'ignore' });
    child.on('close', (code) => resolve(code));
    child.on('error', reject);
  });

const failures = [];
const check = (ok, what) => {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${what}`);
  if (!ok) failures.push(what);
};

try {
  console.log(`pipe-check: node ${version} (${process.platform}/${process.arch}), ${(payload.length / 1048576).toFixed(1)} MB`);
  const outFile = join(dir, 'big.json');
  const outCode = await run(['--out', outFile]);
  const file = existsSync(outFile) ? readFileSync(outFile) : Buffer.alloc(0);
  check(outCode === 0, `--out exits 0 (got ${outCode})`);
  check(file.length > 10 * 1024 * 1024, `--out wrote ${file.length} bytes (> 10 MB)`);

  const p = await piped();
  check(p.code === 0, `piped exits 0 (got ${p.code})`);
  check(p.bytes === file.length, `piped carries ${p.bytes} bytes = --out's ${file.length}`);
  check(p.hash === sha(file), 'piped sha256 = --out sha256');

  // The literal shape of the report: `| cat | sha256sum`, through a POSIX shell.
  if (process.platform !== 'win32') {
    const sum = await new Promise((resolve) =>
      exec(
        `${JSON.stringify(NODE)} ${JSON.stringify(CLI)} ${args.join(' ')} | cat | (sha256sum 2>/dev/null || shasum -a 256)`,
        { env, shell: '/bin/sh', maxBuffer: 1 << 20 },
        (err, stdout) => resolve(err ? `error: ${err.message}` : stdout.split(/\s+/)[0]),
      ),
    );
    check(sum === sha(file), `| cat | sha256sum = --out sha256 (${String(sum).slice(0, 16)}…)`);
  }

  const badCode = await run(['--out', join(dir, 'no-such-dir', 'x.json')]);
  check(badCode !== 0, `a write that cannot land exits non-zero (got ${badCode})`);
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
console.log(`pipe-check: node ${version} ${failures.length ? `FAILED ${failures.length}` : 'ok'}`);
process.exit(failures.length ? 1 : 0);
