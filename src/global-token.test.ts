import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveToken, resolveTokenSource, storeToken, takeTokenFlag } from './credentials';
import { fakeApi, SPACE_ID, type FakeApi } from './testing/fake-api';
import { run } from './run';

/**
 * FMU-DOC01: `--token` is a global flag with one precedence, `--token` >
 * `FORUMULATE_TOKEN` > credentials.json, on every command. It used to reach
 * the SDK client only, so `whoami --token x` used x while `items list --token
 * x` sent whatever was in the environment.
 */
describe('takeTokenFlag', () => {
  it('takes both spellings out and leaves everything else in order', () => {
    expect(takeTokenFlag(['items', 'list', '--token', 'pat_a', '--json'])).toEqual({
      argv: ['items', 'list', '--json'],
      token: 'pat_a',
    });
    expect(takeTokenFlag(['--token=pat_b', 'orgs'])).toEqual({ argv: ['orgs'], token: 'pat_b' });
  });

  it('the last one wins; a missing value is no token, not the next flag', () => {
    expect(takeTokenFlag(['--token', 'a', '--token', 'b']).token).toBe('b');
    expect(takeTokenFlag(['whoami', '--token', '--json'])).toEqual({
      argv: ['whoami', '--json'],
      token: undefined,
    });
    expect(takeTokenFlag(['whoami', '--token=  ']).token).toBeUndefined();
  });

  it('leaves everything after -- alone', () => {
    expect(takeTokenFlag(['api', 'x', '--', '--token', 'v'])).toEqual({
      argv: ['api', 'x', '--', '--token', 'v'],
      token: undefined,
    });
  });
});

describe('precedence', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fcli-token-'));
  const base = 'https://api.example.com';
  const env = { FORUMULATE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;
  storeToken(base, 'pat_file', env);

  it('--token beats FORUMULATE_TOKEN beats credentials.json', () => {
    const withEnv = { ...env, FORUMULATE_TOKEN: 'pat_env' };
    expect(resolveTokenSource(base, withEnv, 'pat_flag')).toEqual({ token: 'pat_flag', source: 'flag' });
    expect(resolveTokenSource(base, withEnv)).toEqual({ token: 'pat_env', source: 'env' });
    expect(resolveTokenSource(base, env)).toMatchObject({ token: 'pat_file', source: 'credentials' });
    expect(resolveTokenSource('https://other.example.com', env)).toEqual({ source: 'none' });
  });

  it('resolveToken, which every transport builds from, follows the same order', () => {
    const withEnv = { ...env, FORUMULATE_TOKEN: 'pat_env' };
    expect(resolveToken(base, withEnv, 'pat_flag')).toBe('pat_flag');
    expect(resolveToken(base, withEnv)).toBe('pat_env');
    expect(resolveToken(base, env)).toBe('pat_file');
    // A blank flag is no flag.
    expect(resolveToken(base, env, '  ')).toBe('pat_file');
  });
});

describe('whoami through run()', () => {
  it('reports the flag as the source, and never prints the token', async () => {
    const out: string[] = [];
    const code = await run(['whoami', '--json', '--token', 'cft_flag_secret'], {
      client: { auth: { me: async () => ({ user: { id: 'u', name: 'n', email: 'e' } }) } } as never,
      out: (l) => out.push(l),
      err: () => {},
      baseUrl: 'https://api.example.com',
      env: { FORUMULATE_TOKEN: 'cft_env', FORUMULATE_CONFIG_DIR: '/nonexistent-forumulate-test' },
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n')).tokenSource).toBe('flag');
    expect(out.join('\n')).not.toContain('cft_flag_secret');
  });
});

describe('every command sends the --token bearer', () => {
  let api: FakeApi;
  const env = { FORUMULATE_ORG: 'acme', FORUMULATE_CONFIG_DIR: '/nonexistent-forumulate-test' };
  beforeEach(async () => {
    api = await fakeApi();
    api.on('GET /orgs/acme/spaces', {
      body: {
        spaces: [{ id: SPACE_ID, slug: 'docs', type: 'DOCS', name: 'Docs' }],
        page: { hasMore: false },
      },
    });
  });
  afterEach(() => api.close());

  it('items list: the flag is the bearer, and never a query parameter', async () => {
    api.on(`GET /orgs/acme/spaces/${SPACE_ID}/items`, { body: { items: [] } });
    // The fake transport carries `pat_test`, standing in for FORUMULATE_TOKEN.
    const r = await api.cli(['items', 'list', '--space', 'docs', '--token', 'pat_flag'], { env });
    expect(r.code).toBe(0);
    const seen = api.seen.filter((s) => s.path.endsWith('/items'));
    expect(seen).toHaveLength(1);
    for (const s of api.seen) expect(s.headers.authorization).toBe('Bearer pat_flag');
    expect(seen[0]!.query.token).toBeUndefined();
  });

  it('without the flag, the transport keeps its own token', async () => {
    api.on(`GET /orgs/acme/spaces/${SPACE_ID}/items`, { body: { items: [] } });
    await api.cli(['items', 'list', '--space', 'docs'], { env });
    expect(api.seen.at(-1)!.headers.authorization).toBe('Bearer pat_test');
  });

  it('api with a path the bundled spec lacks: bearer, not ?token=', async () => {
    api.on('GET /orgs/acme/brand-new', { body: { ok: true } });
    const r = await api.cli(['api', 'GET', '/orgs/acme/brand-new', '--token=pat_flag'], { env });
    expect(r.code).toBe(0);
    expect(api.seen.at(-1)!.headers.authorization).toBe('Bearer pat_flag');
    expect(api.seen.at(-1)!.query.token).toBeUndefined();
  });

  it('an operation with a `token` of its own keeps the flag as that field', async () => {
    api.on('PUT /orgs/acme/sdk/registries/npm', { body: { registry: { registry: 'npm' } } });
    const r = await api.cli(['sdks', 'registries', 'set', 'npm', '--token', 'npm_secret'], { env });
    expect(r.code).toBe(0);
    const put = api.seen.find((s) => s.method === 'PUT')!;
    expect((put.body as { token?: string }).token).toBe('npm_secret');
    // …and the PAT is the ordinary one, not the registry's secret.
    expect(put.headers.authorization).toBe('Bearer pat_test');
  });
});
