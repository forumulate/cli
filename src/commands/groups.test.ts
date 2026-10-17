import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApi, ITEM_ID, SPACE_ID, type FakeApi } from '../testing/fake-api';
import { complete, completionScript } from './completion';

let api: FakeApi;
const dir = mkdtempSync(join(tmpdir(), 'fm-groups-'));
const env = { FORUMULATE_ORG: 'acme', FORUMULATE_CONFIG_DIR: join(dir, 'cfg') };
const S = `/orgs/acme/spaces/${SPACE_ID}`;

beforeEach(async () => {
  api = await fakeApi();
  // `--space docs` resolves through the space list.
  api.on('GET /orgs/acme/spaces', {
    body: {
      spaces: [{ id: SPACE_ID, slug: 'docs', type: 'DOCS', name: 'Docs' }],
      page: { hasMore: false },
    },
  });
});
afterEach(() => api.close());

const cli = (argv: string[], extra = {}) => api.cli(argv, { env, ...extra });

describe('orgs and spaces', () => {
  it('orgs list / get', async () => {
    api.on('GET /orgs', { body: { orgs: [{ id: 'o1', slug: 'acme', name: 'Acme' }] } });
    api.on('GET /orgs/acme', { body: { org: { id: 'o1', slug: 'acme' } } });
    expect((await cli(['orgs', 'list'])).out).toMatch(/o1\s+acme\s+Acme/);
    expect((await cli(['orgs', 'get', 'acme'])).out).toMatch(/slug\s+acme/);
  });

  it('spaces list uses the default org; create maps the positional to the name', async () => {
    api.on('POST /orgs/acme/spaces', {
      status: 201,
      body: { space: { id: 's2' }, data: { id: 's2', slug: 'guides' } },
    });
    expect((await cli(['spaces'])).out).toMatch(/docs\s+DOCS\s+Docs/);
    const r = await cli([
      'spaces',
      'create',
      'Guides',
      '--slug',
      'guides',
      '--type',
      'DOCS',
      '--visibility',
      'PUBLIC',
    ]);
    expect(r.code).toBe(0);
    expect(api.seen.at(-1)!.body).toEqual({
      name: 'Guides',
      slug: 'guides',
      type: 'DOCS',
      visibility: 'PUBLIC',
    });
  });

  it('spaces get/update take a slug; delete asks first and needs --yes without a terminal', async () => {
    api.on(`GET ${S}`, { body: { space: { id: SPACE_ID, slug: 'docs' } } });
    api.on(`PATCH ${S}`, { body: { space: { id: SPACE_ID, name: 'New' } } });
    api.on(`DELETE ${S}`, { body: { ok: true } });
    expect((await cli(['spaces', 'get', 'docs'])).code).toBe(0);
    expect((await cli(['spaces', 'update', 'docs', '--name', 'New'])).code).toBe(0);
    expect(api.seen.at(-1)!.body).toEqual({ name: 'New' });
    const refused = await cli(['spaces', 'delete', 'docs']);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--yes');
    expect(api.seen.some((s) => s.method === 'DELETE')).toBe(false);
    expect((await cli(['spaces', 'delete', 'docs'], { ask: async () => 'y' })).code).toBe(0);
    expect(api.seen.at(-1)!.method).toBe('DELETE');
  });

  it('keeps the older positional forms', async () => {
    const r = await cli(['spaces', 'nope-not-a-verb'], {
      client: { spaces: { list: async () => ({ spaces: [] }) } },
    });
    expect(r.code).toBe(0);
    expect(api.seen.filter((s) => s.path.startsWith('/orgs/nope'))).toHaveLength(0);
  });

  it('an unknown space slug names the ones that exist', async () => {
    const r = await cli(['items', 'list', '--space', 'nope']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('No space "nope" in acme (it has: docs)');
  });
});

describe('items / pages', () => {
  const md = join(dir, 'page.md');
  writeFileSync(md, '---\ntitle: Getting started\nslug: getting-started\n---\n# Hello\n\nBody.\n');

  it('list asks for sections AND body', async () => {
    api.on(`GET ${S}/items`, {
      body: { items: [{ id: ITEM_ID, title: 'A', contentIn: 'markdown' }] },
    });
    const r = await cli(['pages', 'list', '--space', 'docs']);
    expect(r.code).toBe(0);
    expect(api.seen.at(-1)!.query.include).toBe('sections,body');
  });

  it('create --file takes title/slug from front matter, the rest as body, then --publish', async () => {
    api.on(`POST ${S}/items`, {
      status: 201,
      body: { item: { id: ITEM_ID }, data: { id: ITEM_ID } },
    });
    api.on(`POST ${S}/items/${ITEM_ID}/publish`, { body: { published: true } });
    const r = await cli(['items', 'create', '--space', 'docs', '--file', md, '--publish']);
    expect(r.code).toBe(0);
    const create = api.seen.find((s) => s.method === 'POST' && s.path.endsWith('/items'))!;
    expect(create.body).toEqual({
      title: 'Getting started',
      slug: 'getting-started',
      body: '# Hello\n\nBody.\n',
    });
    expect(api.seen.at(-1)!.path).toBe(`${S}/items/${ITEM_ID}/publish`);
    expect(r.out).toContain(`Published ${ITEM_ID}`);
  });

  it('update --file replaces the content through PUT …/content', async () => {
    api.on(`PUT ${S}/items/${ITEM_ID}/content`, { body: { warnings: [] } });
    api.on(`PATCH ${S}/items/${ITEM_ID}`, { body: { item: { id: ITEM_ID } } });
    expect((await cli(['items', 'update', ITEM_ID, '--space', 'docs', '--file', md])).code).toBe(0);
    const writes = api.seen.filter((s) => s.method !== 'GET');
    expect(writes[0]).toMatchObject({ method: 'PUT', body: { body: '# Hello\n\nBody.\n' } });
    // Front matter title/slug are metadata: they go through the PATCH.
    expect(writes[1]).toMatchObject({
      method: 'PATCH',
      body: { title: 'Getting started', slug: 'getting-started' },
    });
  });
});

describe('blog, forum, changelog, status', () => {
  it('blog create --file sends markdown; forum and changelog list', async () => {
    const post = join(dir, 'post.md');
    writeFileSync(post, '---\ntitle: Launch\n---\nWe shipped.\n');
    api.on(`POST ${S}/blog`, { status: 201, body: { article: { id: 't1' }, data: { id: 't1' } } });
    api.on(`GET ${S}/forum`, {
      body: { topics: [{ id: 't2', title: 'Q' }], page: { hasMore: false } },
    });
    api.on(`GET ${S}/changelog`, { body: { releases: [{ id: 'r1', title: 'v1' }] } });
    expect((await cli(['blog', 'create', '--space', 'docs', '--file', post])).code).toBe(0);
    expect(api.seen.at(-1)!.body).toEqual({ title: 'Launch', markdown: 'We shipped.\n' });
    expect((await cli(['forum', 'list', '--space', 'docs'])).out).toContain('t2');
    expect((await cli(['changelog', '--space', 'docs'])).out).toContain('v1');
  });

  it('status incidents list picks the incidents off the board; create opens one', async () => {
    api.on(`GET ${S}/status/board`, {
      body: {
        overall: 'ok',
        groups: [{ id: 'g' }],
        incidents: [{ id: 'i1', title: 'Outage', state: 'investigating' }],
      },
    });
    api.on(`POST ${S}/status/incidents`, {
      status: 201,
      body: { incident: { id: 'i2' }, data: { id: 'i2' } },
    });
    const r = await cli(['status', 'incidents', 'list', '--space', 'docs']);
    expect(r.out).toMatch(/i1\s+Outage\s+investigating/);
    expect(
      (
        await cli([
          'status',
          'incidents',
          'create',
          'DB down',
          '--space',
          'docs',
          '--severity',
          'major',
        ])
      ).code,
    ).toBe(0);
    expect(api.seen.at(-1)!.body).toEqual({ title: 'DB down', severity: 'major' });
  });
});

describe('members, invites, webhooks, tokens, domains, libraries, search', () => {
  it('invites create / members list', async () => {
    api.on('POST /orgs/acme/members', {
      status: 201,
      body: { invite: { id: 'inv' }, data: { id: 'inv' } },
    });
    api.on('GET /orgs/acme/members', {
      body: { members: [{ userId: 'u1', email: 'a@x.test', role: 'ADMIN' }] },
    });
    expect((await cli(['invites', 'create', 'b@x.test', '--role', 'EDITOR'])).code).toBe(0);
    expect(api.seen.at(-1)!.body).toEqual({ email: 'b@x.test', role: 'EDITOR' });
    expect((await cli(['members'])).out).toContain('a@x.test');
  });

  it('webhooks create (space as a body field), test, deliveries, replay', async () => {
    api.on('POST /orgs/acme/webhooks', {
      status: 201,
      body: { secret: 'whsec_1', webhook: { id: 'w1' }, data: { id: 'w1' } },
    });
    api.on('POST /orgs/acme/webhooks/w1/ping', { body: { ok: true } });
    api.on('GET /orgs/acme/webhooks/w1/deliveries', {
      body: { deliveries: [{ id: 'd1', event: 'page.published', status: 500 }] },
    });
    api.on('POST /orgs/acme/webhooks/w1/deliveries/d1/replay', { body: { ok: true } });
    const made = await cli([
      'webhooks',
      'create',
      'https://h.test',
      '--events',
      'page.published,post.created',
      '--space',
      'docs',
    ]);
    expect(made.out).toContain('secret  whsec_1');
    expect(api.seen.at(-1)!.body).toEqual({
      url: 'https://h.test',
      events: ['page.published', 'post.created'],
      spaceId: SPACE_ID,
    });
    expect((await cli(['webhooks', 'test', 'w1'])).code).toBe(0);
    expect((await cli(['webhooks', 'deliveries', 'w1'])).out).toContain('d1');
    expect((await cli(['webhooks', 'replay', 'w1', 'd1'])).code).toBe(0);
  });

  it('tokens rotate / revoke by name', async () => {
    api.on('GET /pats', {
      body: {
        pats: [
          { id: 'p1', name: 'ci-deploy' },
          { id: 'p2', name: 'laptop' },
        ],
      },
    });
    api.on('POST /pats/p1/rotate', { status: 201, body: { token: 'fm_new', pat: { id: 'p1' } } });
    api.on('DELETE /pats/p2', { body: { ok: true } });
    const r = await cli(['tokens', 'rotate', 'ci-deploy', '--graceMinutes', '10']);
    expect(r.code).toBe(0);
    expect(api.seen.at(-1)!.body).toEqual({ graceMinutes: 10 });
    expect((await cli(['pats', 'revoke', 'laptop', '--yes'])).code).toBe(0);
    expect(api.seen.at(-1)).toMatchObject({ method: 'DELETE', path: '/pats/p2' });
  });

  it('domains add / verify by hostname', async () => {
    api.on(`POST ${S}/domains`, {
      status: 201,
      body: { domain: { id: 'd1', hostname: 'docs.acme.test' } },
    });
    api.on(`GET ${S}/domains`, {
      body: { domains: [{ id: 'dom-1', hostname: 'docs.acme.test' }] },
    });
    api.on(`POST ${S}/domains/dom-1/verify`, { body: { domain: { id: 'dom-1', verified: true } } });
    expect((await cli(['domains', 'add', 'docs.acme.test', '--space', 'docs'])).code).toBe(0);
    expect((await cli(['domains', 'verify', 'docs.acme.test', '--space', 'docs'])).code).toBe(0);
    expect(api.seen.at(-1)!.path).toBe(`${S}/domains/dom-1/verify`);
  });

  it('libraries create and keys list resolve the library slug', async () => {
    const L = '22222222-2222-4333-8444-555555555555';
    api.on('GET /orgs/acme/content/libraries', { body: { libraries: [{ id: L, slug: 'site' }] } });
    api.on('POST /orgs/acme/content/libraries', {
      status: 201,
      body: { library: { id: L }, data: { id: L } },
    });
    api.on(`GET /orgs/acme/content/libraries/${L}/keys`, {
      body: { keys: [{ id: 'k1', name: 'web', kind: 'delivery' }] },
    });
    expect((await cli(['libraries', 'create', 'Site', '--slug', 'site'])).code).toBe(0);
    expect((await cli(['libraries', 'keys', 'list', '--library', 'site'])).out).toMatch(
      /k1\s+web\s+delivery/,
    );
  });

  it('search joins the words into q', async () => {
    api.on('GET /orgs/acme/search', {
      body: { hits: [{ sourceType: 'docs', title: 'Rate limits', url: '/r' }], total: 1 },
    });
    const r = await cli(['search', 'rate', 'limits']);
    expect(api.seen.at(-1)!.query.q).toBe('rate limits');
    expect(r.out).toMatch(/docs\s+Rate limits\s+\/r/);
  });

  it('--org is required when nothing supplies a default', async () => {
    const r = await api.cli(['webhooks', 'list'], {
      env: { FORUMULATE_CONFIG_DIR: join(dir, 'empty') },
    });
    expect(r.code).toBe(1);
    expect(r.err).toContain('needs --org');
  });
});

describe('config and completion', () => {
  it('config set org is the default for every command; a flag still wins', async () => {
    const cfgEnv = { FORUMULATE_CONFIG_DIR: join(dir, 'cfg2') };
    expect((await api.cli(['config', 'set', 'org', 'beta'], { env: cfgEnv })).code).toBe(0);
    expect((await api.cli(['config', 'get', 'org'], { env: cfgEnv })).out).toBe('beta');
    api.on('GET /orgs/beta/webhooks', { body: { webhooks: [] } });
    api.on('GET /orgs/gamma/webhooks', { body: { webhooks: [] } });
    await api.cli(['webhooks', 'list'], { env: cfgEnv });
    await api.cli(['webhooks', 'list', '--org', 'gamma'], { env: cfgEnv });
    expect(api.seen.map((s) => s.path)).toEqual(['/orgs/beta/webhooks', '/orgs/gamma/webhooks']);
    expect((await api.cli(['config', 'set', 'colour', 'x'], { env: cfgEnv })).code).toBe(1);
  });

  it('completes commands, verbs, sub-verbs, operationIds and flags', () => {
    expect(complete(['web'])).toEqual(['webhooks']);
    expect(complete(['webhooks', ''])).toContain('deliveries');
    expect(complete(['status', 'incidents', ''])).toEqual(['list', 'create', 'update', 'post']);
    expect(complete(['api', 'Space_cr'])).toContain('Space_create');
    expect(complete(['api', 'Space_list', '--li'])).toContain('--limit');
    for (const shell of ['bash', 'zsh', 'fish'])
      expect(completionScript(shell)).toContain('__complete');
  });
});
