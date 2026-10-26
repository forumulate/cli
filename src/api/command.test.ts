import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeApi, type FakeApi } from '../testing/fake-api';
import { retryAfterMs } from './http';
import { parseArgs } from './args';

let api: FakeApi;
beforeEach(async () => {
  api = await fakeApi();
});
afterEach(() => api.close());

describe('forumulate api: parameters', () => {
  it('fills path params positionally and query params from flags', async () => {
    api.on('GET /orgs/acme/spaces', {
      body: { spaces: [{ id: 's1', slug: 'docs', type: 'DOCS', name: 'Docs' }] },
    });
    const r = await api.cli(['api', 'Space_list', 'acme', '--limit', '5']);
    expect(r.code).toBe(0);
    expect(api.seen[0]).toMatchObject({
      method: 'GET',
      path: '/orgs/acme/spaces',
      query: { limit: '5' },
    });
    expect(r.out).toContain('docs');
    expect(r.out).toMatch(/ID\s+SLUG/);
  });

  it('takes --orgId, --org-id, METHOD+template and METHOD+concrete path alike', async () => {
    api.on('GET /orgs/acme/spaces', { body: { spaces: [] } });
    for (const argv of [
      ['api', 'Space_list', '--orgId', 'acme'],
      ['api', 'space_list', '--org-id=acme'],
      ['api', 'GET', '/orgs/{orgId}/spaces', 'acme'],
      ['api', 'GET', '/orgs/acme/spaces'],
    ])
      expect((await api.cli(argv)).code).toBe(0);
    expect(api.seen.map((s) => s.path)).toEqual(Array(4).fill('/orgs/acme/spaces'));
  });

  it('defaults orgId from --org, then FORUMULATE_ORG', async () => {
    api.on('GET /orgs/from-env/webhooks', { body: { webhooks: [] } });
    api.on('GET /orgs/from-flag/webhooks', { body: { webhooks: [] } });
    const env = { FORUMULATE_ORG: 'from-env', FORUMULATE_CONFIG_DIR: '/none' };
    expect((await api.cli(['api', 'Webhook_list'], { env })).code).toBe(0);
    expect((await api.cli(['api', 'Webhook_list', '--org', 'from-flag'], { env })).code).toBe(0);
    expect(api.seen.map((s) => s.path)).toEqual([
      '/orgs/from-env/webhooks',
      '/orgs/from-flag/webhooks',
    ]);
  });

  it('joins a repeated array flag with commas, and sends the version, UA and token', async () => {
    api.on('GET /orgs/o/spaces/s/items', { body: { items: [] } });
    await api.cli(['api', 'Item_list', 'o', 's', '--include', 'sections', '--include', 'body']);
    expect(api.seen[0]!.query.include).toBe('sections,body');
    expect(api.seen[0]!.headers['forumulate-version']).toBe('2026-12-01');
    expect(api.seen[0]!.headers['user-agent']).toBe('cli-test');
    expect(api.seen[0]!.headers.authorization).toBe('Bearer pat_test');
  });

  it('refuses a flag the operation does not declare, and names where to look', async () => {
    const r = await api.cli(['api', 'Space_list', 'acme', '--nope', '1']);
    // FMU-D05: a flag the operation lacks is a usage error, exit 2.
    expect(r.code).toBe(2);
    expect(r.err).toContain('--nope is not a parameter of Space_list');
    expect(r.err).toContain('forumulate api describe Space_list');
    expect(api.seen).toHaveLength(0);
  });

  it('says which path params are missing', async () => {
    const r = await api.cli(['api', 'Space_get', 'acme']);
    // FMU-D05: a missing argument is a usage error, exit 2.
    expect(r.code).toBe(2);
    expect(r.err).toContain('needs <spaceId>');
  });
});

describe('forumulate api: bodies', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fm-cli-'));

  it('reads --data inline, then --field and body flags on top, typed by the schema', async () => {
    api.on('POST /orgs/acme/spaces', {
      status: 201,
      body: { space: { id: 's1' }, data: { id: 's1', slug: 'docs' } },
    });
    const r = await api.cli([
      'api',
      'Space_create',
      'acme',
      '--data',
      '{"name":"Docs","type":"DOCS"}',
      '--field',
      'seed=false',
      '--slug',
      'docs',
      '-f',
      'settings.overview=Hi',
    ]);
    expect(r.code).toBe(0);
    expect(api.seen[0]!.body).toEqual({
      name: 'Docs',
      type: 'DOCS',
      seed: false,
      slug: 'docs',
      settings: { overview: 'Hi' },
    });
    // An operation that declares Idempotency-Key gets one.
    expect(api.seen[0]!.headers['idempotency-key']).toMatch(/[0-9a-f-]{36}/);
  });

  it('reads --data @file and --data - (stdin)', async () => {
    api.on('POST /orgs/acme/webhooks', {
      status: 201,
      body: { webhook: { id: 'w1' }, secret: 'whsec' },
    });
    const file = join(dir, 'hook.json');
    writeFileSync(file, '{"url":"https://x.test/h","events":["page.published"]}');
    expect((await api.cli(['api', 'Webhook_create', 'acme', '--data', `@${file}`])).code).toBe(0);
    const stdin = await api.cli(['api', 'Webhook_create', 'acme', '--data', '-'], {
      readStdin: async () => '{"url":"https://y.test/h","events":["a"]}',
    });
    expect(stdin.code).toBe(0);
    expect(api.seen.map((s) => (s.body as { url: string }).url)).toEqual([
      'https://x.test/h',
      'https://y.test/h',
    ]);
  });

  it('rejects malformed JSON and mistyped fields before sending anything', async () => {
    expect((await api.cli(['api', 'Space_create', 'acme', '--data', '{nope'])).err).toContain(
      '--data: not valid JSON',
    );
    expect((await api.cli(['api', 'Pat_create', '--expiresInDays', 'soon'])).err).toContain(
      'expects a number',
    );
    expect(api.seen).toHaveLength(0);
  });

  it('--dry-run prints the request and sends nothing', async () => {
    const r = await api.cli([
      'api',
      'Space_create',
      'acme',
      '--name',
      'Docs',
      '--slug',
      'd',
      '--type',
      'DOCS',
      '--dry-run',
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`POST ${api.url}/orgs/acme/spaces`);
    expect(r.out).toContain('Authorization: Bearer ***');
    expect(r.out).toContain('"slug": "d"');
    expect(api.seen).toHaveLength(0);
  });
});

describe('forumulate api: paging and output', () => {
  it('--paginate follows page.nextCursor and merges the rows', async () => {
    api.on('GET /orgs/acme/members', (req) =>
      req.query.cursor === 'c2'
        ? {
            body: {
              members: [{ userId: 'u3' }],
              data: [{ userId: 'u3' }],
              page: { hasMore: false, nextCursor: null },
            },
          }
        : {
            body: {
              members: [{ userId: 'u1' }, { userId: 'u2' }],
              data: [{ userId: 'u1' }, { userId: 'u2' }],
              page: { hasMore: true, nextCursor: 'c2' },
            },
          },
    );
    const r = await api.cli(['api', 'Member_list', 'acme', '--paginate', '--json']);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([{ userId: 'u1' }, { userId: 'u2' }, { userId: 'u3' }]);
    expect(api.seen.map((s) => s.query.cursor ?? '')).toEqual(['', 'c2']);
  });

  it('without --paginate, prints a footer that says how to get the next page', async () => {
    api.on('GET /orgs/acme/members', {
      body: { members: [{ userId: 'u1' }], page: { hasMore: true, nextCursor: 'c2', total: 9 } },
    });
    const r = await api.cli(['api', 'Member_list', 'acme']);
    expect(r.out).toContain('-- 1 shown of 9, more: --cursor c2');
  });

  it('--json prints the body untouched; a resource prints as key/value lines', async () => {
    const body = { space: { id: 's1', slug: 'docs' }, data: { id: 's1', slug: 'docs' } };
    api.on('GET /orgs/acme/spaces/s1', { body });
    expect(JSON.parse((await api.cli(['api', 'Space_get', 'acme', 's1', '--json'])).out)).toEqual(
      body,
    );
    expect((await api.cli(['api', 'Space_get', 'acme', 's1'])).out).toMatch(/slug\s+docs/);
  });
});

describe('forumulate api: errors and retries', () => {
  // FMU-D05: a 422 is the caller's input, so the usage exit, 2.
  it('prints the error envelope and its field problems, exit 2', async () => {
    api.on('POST /orgs/acme/spaces', {
      status: 422,
      body: {
        error: { code: 'validation.failed', message: 'Invalid body', details: { slug: ['taken'] } },
      },
    });
    const r = await api.cli([
      'api',
      'Space_create',
      'acme',
      '--name',
      'D',
      '--slug',
      'd',
      '--type',
      'DOCS',
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('Error 422 (validation.failed): Invalid body');
    expect(r.err).toContain('slug: taken');
  });

  it('retries a 429 after Retry-After with the same Idempotency-Key', async () => {
    let n = 0;
    api.on('POST /orgs/acme/webhooks', () =>
      ++n === 1
        ? {
            status: 429,
            headers: { 'retry-after': '2' },
            body: { error: { code: 'rate_limited', message: 'slow' } },
          }
        : { status: 201, body: { webhook: { id: 'w' } } },
    );
    const r = await api.cli([
      'api',
      'Webhook_create',
      'acme',
      '--url',
      'https://x.test',
      '--events',
      'a',
    ]);
    expect(r.code).toBe(0);
    expect(r.err).toContain('HTTP 429; retrying in 2s');
    expect(api.seen).toHaveLength(2);
    expect(api.seen[0]!.headers['idempotency-key']).toBe(api.seen[1]!.headers['idempotency-key']);
  });

  it('does not retry a 503 on a POST that carries no idempotency key', async () => {
    api.on('POST /not-in-the-spec', {
      status: 503,
      body: { error: { code: 'unavailable', message: 'deploying' } },
    });
    const r = await api.cli(['api', 'POST', '/not-in-the-spec', '--data', '{}']);
    expect(r.err).toContain('not in this CLI');
    expect(api.seen).toHaveLength(1);
    expect(r.code).toBe(1);
  });

  it('retries a 503 on a GET, then succeeds', async () => {
    let n = 0;
    api.on('GET /orgs', () =>
      ++n < 3
        ? { status: 503, body: { error: { code: 'x', message: 'y' } } }
        : { body: { orgs: [] } },
    );
    expect((await api.cli(['api', 'Org_list'])).code).toBe(0);
    expect(api.seen).toHaveLength(3);
  });

  it('names the edge when the answer is a block page, not JSON', async () => {
    api.on('GET /orgs', { status: 403, body: '<html>Cloudflare error code: 1010</html>' });
    const r = await api.cli(['api', 'Org_list']);
    expect(r.code).toBe(1);
    expect(r.err).toContain('edge.blocked');
  });

  it('reads Retry-After as seconds or a date', () => {
    expect(retryAfterMs('3')).toBe(3000);
    expect(retryAfterMs(new Date(Date.now() + 5000).toUTCString())).toBeGreaterThan(3000);
    expect(retryAfterMs('9999')).toBe(60_000);
    expect(retryAfterMs(null)).toBeUndefined();
  });
});

describe('forumulate api list / describe', () => {
  it('lists operations filtered by tag and search', async () => {
    const r = await api.cli(['api', 'list', '--tag', 'Webhook', '--search', 'replay']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Webhook_replay');
    expect(r.out).not.toContain('Webhook_create');
  });

  it('describes params as flags and the body as fields', async () => {
    const r = await api.cli(['api', 'describe', 'Space_create']);
    expect(r.out).toContain('POST /orgs/{orgId}/spaces');
    expect(r.out).toContain('--orgId*');
    expect(r.out).toMatch(/name\*\s+string/);
    expect(r.out).toContain('"DOCS"');
  });

  it('parses switches, --x=y, -f and a lone - as values', () => {
    const p = parseArgs(['a', '--json', '--x=1', '-f', 'k=v', '--data', '-', '--no-seed']);
    expect(p.positionals).toEqual(['a']);
    expect(Object.fromEntries(p.flags)).toEqual({
      json: ['true'],
      x: ['1'],
      field: ['k=v'],
      data: ['-'],
      seed: ['false'],
    });
  });
});
