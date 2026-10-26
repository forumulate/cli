import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApi, SPACE_ID, type FakeApi } from './testing/fake-api';
import { run } from './run';
import { HELP } from './help';
import { COMMAND_HELP } from './help-commands';
import { runWhoami, unknownEnv } from './whoami';
import { exitCodeForError, EXIT } from './exit-codes';
import { globalOut } from './io';
import { mergePurged } from './publish-command';
import { refreshLive, readLive } from './api/live-spec';
import { slim } from './api/slim';

/**
 * FMU round R3, the CLI half: per-command help (B14), the exit codes and the
 * output contract (D05), where the token came from (D06), the live operation
 * list (D13), the cache verb (B04) and the publish purge summary (D04).
 */
let api: FakeApi;
const dir = mkdtempSync(join(tmpdir(), 'fm-r3-'));
const env = { FORUMULATE_ORG: 'acme', FORUMULATE_CONFIG_DIR: join(dir, 'cfg') };

beforeEach(async () => {
  api = await fakeApi();
  api.on('GET /orgs/acme/spaces', {
    body: { spaces: [{ id: SPACE_ID, slug: 'docs', type: 'DOCS', name: 'Docs' }], page: { hasMore: false } },
  });
});
afterEach(() => api.close());

const collect = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
};

describe('every top-level command has its own --help (FMU-B14)', () => {
  const commands = [
    'publish',
    'sync',
    'plan',
    'apply',
    'doctor',
    'dev',
    'login',
    'logout',
    'whoami',
    'auth',
    'cache',
    'snapshot',
    'conformance',
    'content',
    'import',
    'translations',
    'i18n',
  ];
  for (const cmd of commands)
    it(`${cmd} --help`, async () => {
      const c = collect();
      const code = await run([cmd, '--help'], { client: {} as never, ...c.deps });
      const text = c.out.join('\n');
      expect(code).toBe(0);
      expect(text).not.toBe(HELP);
      expect(text).toMatch(/Exit status/);
    });

  it('publish --help names every flag, the manifest keys, the exit codes and an example', () => {
    const h = COMMAND_HELP.publish!;
    for (const f of ['--dry-run', '--prune', '--only', '--force', '--purge', '--no-verify', '--pace', '--manifest', '--diff', '--json', '--out'])
      expect(h).toContain(f);
    expect(h).toMatch(/forumulate\.yaml keys/);
    expect(h).toMatch(/Examples:/);
  });

  it('`help publish` prints the same page', async () => {
    const c = collect();
    await run(['help', 'publish'], { client: {} as never, ...c.deps });
    expect(c.out.join('\n')).toBe(COMMAND_HELP.publish);
  });
});

describe('exit codes (FMU-D05)', () => {
  it('maps API errors to the documented codes', () => {
    expect(exitCodeForError({ status: 401 })).toBe(EXIT.AUTH);
    expect(exitCodeForError({ status: 403 })).toBe(EXIT.AUTH);
    expect(exitCodeForError({ status: 404 })).toBe(EXIT.NOT_FOUND);
    expect(exitCodeForError({ status: 409 })).toBe(EXIT.CONFLICT);
    expect(exitCodeForError({ status: 412 })).toBe(EXIT.CONFLICT);
    expect(exitCodeForError({ status: 422 })).toBe(EXIT.USAGE);
    expect(exitCodeForError(new Error('boom'))).toBe(EXIT.FAILED);
  });

  it('an unknown command is a usage error', async () => {
    const c = collect();
    expect(await run(['frobnicate'], { client: {} as never, ...c.deps })).toBe(EXIT.USAGE);
  });

  it('a 404 from a resource command exits 4', async () => {
    api.on('GET /orgs/acme/spaces/nope', { status: 404, body: { error: { code: 'space.not_found', message: 'No space' } } });
    const r = await api.cli(['spaces', 'get', 'nope'], { env });
    expect(r.code).toBe(EXIT.NOT_FOUND);
  });
});

describe('--out and --jsonl (FMU-D05)', () => {
  it('--out is a stdout redirect except where a command owns it', () => {
    expect(globalOut(['items', 'list', '--out', 'x.json'])).toBe('x.json');
    expect(globalOut(['api', 'Space_list', '--out=y.json'])).toBe('y.json');
    expect(globalOut(['content', 'types', '--out', 'f.d.ts'])).toBeUndefined();
    expect(globalOut(['translations', 'pull', '--out', 'dir'])).toBeUndefined();
  });

  it('--paginate --jsonl prints one row per line, every page', async () => {
    api.on('GET /orgs/acme/spaces/' + SPACE_ID + '/pages', (req) =>
      req.query.cursor
        ? { body: { pages: [{ id: 'p3' }], page: { hasMore: false } } }
        : { body: { pages: [{ id: 'p1' }, { id: 'p2' }], page: { hasMore: true, nextCursor: 'c2' } } },
    );
    const r = await api.cli(['api', 'GET', `/orgs/acme/spaces/${SPACE_ID}/pages`, '--paginate', '--jsonl'], { env });
    expect(r.out.split('\n').map((l) => JSON.parse(l).id)).toEqual(['p1', 'p2', 'p3']);
  });
});

describe('whoami / auth status (FMU-D06)', () => {
  it('names unknown FORUMULATE_* variables with what they probably meant', () => {
    expect(unknownEnv({ FORUMULATE_BASE: 'x', FORUMULATE_URL: 'y' })).toEqual([
      { name: 'FORUMULATE_BASE', didYouMean: 'FORUMULATE_URL' },
    ]);
    expect(unknownEnv({ FORUMULATE_TOKN: 'x' })[0]!.didYouMean).toBe('FORUMULATE_TOKEN');
  });

  it('reports the token source, the PAT and the API base as JSON', async () => {
    const c = collect();
    const code = await runWhoami(true, {
      ...c.deps,
      env: { FORUMULATE_TOKEN: 'cft_abcd1234', FORUMULATE_BASE: 'https://x', FORUMULATE_CONFIG_DIR: join(dir, 'none') },
      baseUrl: 'https://forumulate.com/api',
      me: async () => ({
        user: { id: 'u1', name: 'Ada', email: 'ada@example.com' },
        token: { id: 'pat1', name: 'ci-deploy', last4: '1234', expiresAt: null, scopes: ['write'] },
      }),
    });
    const r = JSON.parse(c.out.join('\n'));
    expect(code).toBe(0);
    expect(r.tokenSource).toBe('env');
    expect(r.apiBase).toBe('https://forumulate.com/api');
    expect(r.token).toMatchObject({ id: 'pat1', name: 'ci-deploy', last4: '1234' });
    expect(r.warnings).toEqual([{ name: 'FORUMULATE_BASE', didYouMean: 'FORUMULATE_URL' }]);
  });

  it('--token beats the environment; no token at all exits 3', async () => {
    const c = collect();
    await runWhoami(true, {
      ...c.deps,
      env: { FORUMULATE_TOKEN: 'cft_env' },
      flagToken: 'cft_flag',
      me: async () => ({ user: { id: 'u', name: 'n', email: 'e' } }),
    });
    expect(JSON.parse(c.out.join('\n')).tokenSource).toBe('flag');
    const d = collect();
    const code = await runWhoami(false, {
      ...d.deps,
      env: { FORUMULATE_CONFIG_DIR: join(dir, 'empty') },
      me: async () => ({ user: { id: 'u', name: 'n', email: 'e' } }),
    });
    expect(code).toBe(EXIT.AUTH);
  });
});

describe('cache purge (FMU-B04)', () => {
  it('purges a page by slug through Cache_purgePage and reports the edge', async () => {
    api.on(`GET /orgs/acme/spaces/${SPACE_ID}/pages`, { body: { pages: [{ id: 'aaaaaaaa-2222-4333-8444-555555555555', slug: 'intro' }] } });
    api.on(`POST /orgs/acme/spaces/${SPACE_ID}/pages/aaaaaaaa-2222-4333-8444-555555555555/cache/purge`, {
      status: 202,
      body: { purged: 'page', urls: ['https://docs.acme.com/intro'], urlCount: 1, edge: 'fastly', edges: [{ name: 'fastly', account: 'org', urls: 1, ok: true }], webTier: true },
    });
    const r = await api.cli(['cache', 'purge', '--space', 'docs', '--page', 'intro'], { env });
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/edge fastly/);
  });

  it('says so when no CDN fronts the addresses', async () => {
    api.on(`POST /orgs/acme/spaces/${SPACE_ID}/cache/purge`, {
      status: 202,
      body: { purged: 'space', urls: [], urlCount: 0, edge: 'none', edges: [], webTier: true },
    });
    const r = await api.cli(['cache', 'purge', '--space', 'docs'], { env });
    expect(r.err).toMatch(/No CDN fronts these addresses/);
  });
});

describe('publish summary (FMU-D04/D16)', () => {
  it('merges per-batch purge answers into one, naming the edge honestly', () => {
    expect(mergePurged([])).toBeNull();
    const m = mergePurged([
      { scope: 'page', urls: ['a'], urlCount: 1, edges: [{ name: 'cloudflare' }] },
      { scope: 'page', urls: ['b'], urlCount: 1, edges: [{ name: 'fastly' }] },
    ])!;
    expect(m.urlCount).toBe(2);
    expect(m.edge).toBe('multiple');
    expect(mergePurged([{ scope: 'page', urls: [], urlCount: 0, edges: [] }])!.edge).toBe('none');
  });
});

describe('api list --refresh (FMU-D13)', () => {
  const spec = (n: number) => ({
    openapi: '3.1.0',
    info: { title: 'T', version: '1' },
    paths: Object.fromEntries(
      Array.from({ length: n }, (_, i) => [`/x${i}`, { get: { operationId: `X_${i}`, summary: `X ${i}.` } }]),
    ),
  });
  it('fetches, caches by ETag, and revalidates with a 304', async () => {
    const cfg = { FORUMULATE_CONFIG_DIR: mkdtempSync(join(tmpdir(), 'fm-live-')) };
    const seen: Record<string, string>[] = [];
    const fetchImpl = async (_u: string, init: { headers: Record<string, string> }) => {
      seen.push(init.headers);
      if (init.headers['if-none-match'] === 'W/"e1"')
        return { status: 304, headers: { get: () => null }, text: async () => '' };
      return { status: 200, headers: { get: (n: string) => (n === 'etag' ? 'W/"e1"' : null) }, text: async () => JSON.stringify(spec(3)) };
    };
    const first = await refreshLive('https://x.test/api', { env: cfg, fetchImpl });
    expect(first).toMatchObject({ changed: true, meta: { ops: 3, etag: 'W/"e1"' } });
    const again = await refreshLive('https://x.test/api', { env: cfg, fetchImpl });
    expect(again.changed).toBe(false);
    expect(seen[1]!['if-none-match']).toBe('W/"e1"');
    expect(readLive('https://x.test/api', cfg)!.index.ops.map((o) => o.id)).toEqual(['X_0', 'X_1', 'X_2']);
  });

  it('cuts the same index as the build script (slim.ts == slim-spec.mjs)', async () => {
    const full = JSON.parse(readFileSync(join(__dirname, '..', '..', 'sdk', 'openapi.json'), 'utf8'));
    // @ts-expect-error — an .mjs script with no declaration file
    const { render } = (await import('../scripts/slim-spec.mjs')) as { render: (s: unknown) => string };
    expect(`${JSON.stringify(slim(full))}\n` === render(full)).toBe(true);
  });
});
