import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { run, VERSION, type RunDeps } from './run';
import { resolveToken } from './credentials';
import type { ForumulateClient } from '@forumulate/sdk';

/** A client whose `auth.me` answers, and whose constructor returns itself —
 *  `login` re-instantiates the client with the token it is testing. */
function okClient(): ForumulateClient {
  const client = {
    auth: { me: async () => ({ user: { id: 'u1', name: 'Ada', email: 'ada@example.com' } }) },
  } as unknown as ForumulateClient;
  (client as { constructor: unknown }).constructor = function () {
    return client;
  } as unknown as ForumulateClient['constructor'];
  return client;
}

function failingClient(): ForumulateClient {
  const client = {
    auth: {
      me: async () => {
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      },
    },
  } as unknown as ForumulateClient;
  (client as { constructor: unknown }).constructor = function () {
    return client;
  } as unknown as ForumulateClient['constructor'];
  return client;
}

/** Records what a directory publish actually wrote, in order. */
function publishClient(): ForumulateClient & { writes: string[] } {
  const writes: string[] = [];
  return {
    writes,
    items: {
      list: async () => ({ items: [{ id: 'existing-1', slug: 'using-it', title: 'Using it' }] }),
      create: async (_o: string, _s: string, input: { slug?: string }) => {
        writes.push(`create:${input.slug}`);
        return { item: { id: `new-${input.slug}` } };
      },
      setContent: async (_o: string, _s: string, itemId: string) => {
        writes.push(`content:${itemId}`);
        return { conformance: {} };
      },
      publish: async (_o: string, _s: string, itemId: string) => {
        writes.push(`publish:${itemId}`);
        return { published: true };
      },
    },
  } as unknown as ForumulateClient & { writes: string[] };
}

function domainClient(): ForumulateClient {
  const domain = {
    id: 'd1',
    hostname: 'docs.acme.test',
    basePath: '',
    verified: false,
    active: false,
    verificationRecord: { name: '_forumulate.docs.acme.test', value: 'abc' },
  };
  return {
    domains: {
      list: async () => ({ domains: [domain] }),
      verify: async () => ({ domain }),
      setup: async () => ({
        mode: 'dns',
        served: false,
        message: 'Add the TXT record, then verify again.',
        dns: { found: [], expected: 'forumulate-site-verification=abc', reachesUs: false },
      }),
    },
  } as unknown as ForumulateClient;
}

/** The deps most of the new cases need: an ok client unless one is given. */
function deps(out: string[], client: ForumulateClient = okClient()): RunDeps {
  return { client, out: (l) => out.push(l), err: (l) => out.push(l) };
}

function harness(client: Partial<ForumulateClient>) {
  const out: string[] = [];
  const err: string[] = [];
  const deps: RunDeps = {
    client: client as ForumulateClient,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
  };
  return { deps, out, err };
}

describe('forumulate CLI run()', () => {
  it('prints the version', async () => {
    const { deps, out } = harness({});
    expect(await run(['--version'], deps)).toBe(0);
    expect(out.join('\n')).toContain(VERSION);
  });

  it('shows help with no command', async () => {
    const { deps, out } = harness({});
    expect(await run([], deps)).toBe(0);
    expect(out.join('\n')).toContain('Usage:');
    expect(out.join('\n')).toContain('whoami');
  });

  it('whoami calls auth.me and formats it', async () => {
    const { deps, out } = harness({
      auth: {
        me: async () => ({ user: { id: 'u1', email: 'a@b.co', name: 'Ada' } }),
      } as ForumulateClient['auth'],
    });
    expect(await run(['whoami'], deps)).toBe(0);
    expect(out.join('\n')).toBe('Ada <a@b.co> (u1)');
  });

  it('whoami --json emits raw JSON', async () => {
    const { deps, out } = harness({
      auth: {
        me: async () => ({ user: { id: 'u1', email: 'a@b.co', name: 'Ada' } }),
      } as ForumulateClient['auth'],
    });
    await run(['whoami', '--json'], deps);
    expect(JSON.parse(out.join('\n'))).toEqual({ id: 'u1', email: 'a@b.co', name: 'Ada' });
  });

  it('spaces lists an org’s spaces', async () => {
    const { deps, out } = harness({
      spaces: {
        list: async () => ({ spaces: [{ id: 's1', slug: 'docs', type: 'DOCS', name: 'Docs' }] }),
      } as unknown as ForumulateClient['spaces'],
    });
    expect(await run(['spaces', 'org1'], deps)).toBe(0);
    expect(out.join('\n')).toContain('s1  docs  [DOCS]  Docs');
  });

  it('spaces without an orgId prints usage + exits 1', async () => {
    const { deps, err } = harness({});
    expect(await run(['spaces'], deps)).toBe(1);
    expect(err.join('\n')).toContain('Usage: forumulate spaces <orgId>');
  });

  it('search joins the query and lists hits', async () => {
    const { deps, out } = harness({
      search: {
        unified: async (_org: string, q: string) => {
          expect(q).toBe('how to deploy');
          return { hits: [{ sourceType: 'docs', title: 'Deploy', url: '/x' }] as never };
        },
      } as unknown as ForumulateClient['search'],
    });
    await run(['search', 'org1', 'how', 'to', 'deploy'], deps);
    expect(out.join('\n')).toContain('[docs] Deploy  /x');
  });

  it('publish calls publishPage', async () => {
    let called = '';
    const { deps, out } = harness({
      spaces: {
        publishPage: async (_o: string, _s: string, pageId: string) => {
          called = pageId;
          return { page: {} as never };
        },
      } as unknown as ForumulateClient['spaces'],
    });
    expect(await run(['publish', 'o', 's', 'p1'], deps)).toBe(0);
    expect(called).toBe('p1');
    expect(out.join('\n')).toContain('Published p1');
  });

  it('surfaces API errors as a non-zero exit', async () => {
    const { deps, err } = harness({
      auth: {
        me: async () => {
          throw { status: 401, code: 'auth.unauthenticated', message: 'no token' };
        },
      } as ForumulateClient['auth'],
    });
    expect(await run(['whoami'], deps)).toBe(1);
    expect(err.join('\n')).toContain('Error 401 (auth.unauthenticated): no token');
  });

  it('rejects an unknown command', async () => {
    const { deps, err } = harness({});
    expect(await run(['frobnicate'], deps)).toBe(1);
    expect(err.join('\n')).toContain('Unknown command: frobnicate');
  });
});

/**
 * `items` exists because `spaces` could say a space holds 1,226 pieces and
 * nothing could walk them — and because the walk has a trap in it. `sections`
 * is filled only for a piece written against a shape, so asking for it alone
 * returns empty objects for a space of free-form pages and a sync reports
 * success having carried nothing. The command asks for `body` too and prints
 * `contentIn`, so the distinction is visible from a terminal.
 */
describe('items', () => {
  it('asks for body as well as sections, and shows where content lives', async () => {
    const calls: unknown[] = [];
    const out: string[] = [];
    const client = {
      items: {
        list: (orgId: string, spaceId: string, opts: unknown) => {
          calls.push({ orgId, spaceId, opts });
          return Promise.resolve({
            items: [
              { id: 'i1', title: 'Shaped', contentIn: 'sections' },
              { id: 'i2', title: 'Free-form', contentIn: 'markdown' },
            ],
            page: { has_more: true, next_cursor: 'c1_x', total: 1226 },
          });
        },
      },
    };
    const code = await run(['items', 'o1', 's1'], {
      client: client as never,
      out: (l) => out.push(l),
      err: () => {},
    });
    expect(code).toBe(0);
    // The whole point: never `sections` alone.
    expect(calls[0]).toMatchObject({ opts: { include: ['sections', 'body'] } });
    expect(out[0]).toContain('[sections]');
    expect(out[1]).toContain('[markdown]');
    // The shortfall check a sync should be making, surfaced for a human.
    expect(out[2]).toContain('2 shown of 1226');
    expect(out[2]).toContain('more available');
  });

  it('refuses without a spaceId rather than guessing one', async () => {
    const err: string[] = [];
    const code = await run(['items', 'o1'], {
      client: {} as never,
      out: () => {},
      err: (l) => err.push(l),
    });
    expect(code).not.toBe(0);
    expect(err.join(' ')).toContain('items <orgId> <spaceId>');
  });
});

/**
 * The three gaps a developer hit on day one (a customer DX report): no `login`, no way
 * to publish a DIRECTORY, and no way to ask a domain why it is not live.
 */
describe('login and logout', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fcli-'));
  const env = { FORUMULATE_CONFIG_DIR: dir } as NodeJS.ProcessEnv;

  it('verifies the token before storing it, and stores it per API', async () => {
    const out: string[] = [];
    const code = await run(['login', '--token', 'pat_abc'], {
      ...deps(out),
      baseUrl: 'https://api.example.com',
      env,
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('Signed in as');
    expect(resolveToken('https://api.example.com', env)).toBe('pat_abc');
    // …and a different API does not get it.
    expect(resolveToken('https://other.example.com', env)).toBeUndefined();
  });

  it('forgets it again', async () => {
    const out: string[] = [];
    await run(['logout'], { ...deps(out), baseUrl: 'https://api.example.com', env });
    expect(resolveToken('https://api.example.com', env)).toBeUndefined();
  });

  it('refuses to store a token the API will not accept', async () => {
    const out: string[] = [];
    const errs: string[] = [];
    const code = await run(['login', '--token', 'nope'], {
      client: failingClient(),
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
      baseUrl: 'https://api.example.com',
      env,
    });
    expect(code).toBe(1);
    expect(resolveToken('https://api.example.com', env)).toBeUndefined();
  });
});

describe('publishing a directory', () => {
  it('plans without writing under --dry-run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdocs-'));
    writeFileSync(join(dir, '01-intro.md'), '# Intro\n\nHello.\n');
    writeFileSync(join(dir, 'guide.md'), '---\nslug: using-it\ntitle: Using it\n---\n\nBody.\n');
    const out: string[] = [];
    const client = publishClient();
    const code = await run(['publish', 'o1', 's1', dir, '--dry-run'], deps(out, client));
    expect(code).toBe(0);
    const text = out.join('\n');
    expect(text).toContain('create  intro');
    expect(text).toContain('update  using-it');
    expect(text).toContain('nothing was written');
    expect(client.writes).toEqual([]);
  });

  it('creates, updates and publishes without it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fdocs-'));
    writeFileSync(join(dir, '01-intro.md'), '# Intro\n\nHello.\n');
    writeFileSync(join(dir, 'guide.md'), '---\nslug: using-it\n---\n\n# Using it\n\nBody.\n');
    const out: string[] = [];
    const client = publishClient();
    expect(await run(['publish', 'o1', 's1', dir], deps(out, client))).toBe(0);
    expect(client.writes).toEqual([
      'create:intro',
      'publish:new-intro',
      'content:existing-1',
      'publish:existing-1',
    ]);
  });
});

describe('domains', () => {
  it('lists them with a state a person can scan', async () => {
    const out: string[] = [];
    expect(await run(['domains', 'o1', 's1'], deps(out, domainClient()))).toBe(0);
    expect(out.join('\n')).toContain('unverified  docs.acme.test');
  });

  it('verifies, prints what is missing, and exits non-zero while it fails', async () => {
    const out: string[] = [];
    const code = await run(
      ['domains', 'verify', 'o1', 's1', 'docs.acme.test'],
      deps(out, domainClient()),
    );
    expect(code).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('state: dns');
    expect(text).toContain('TXT');
  });
});
