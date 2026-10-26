import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanMarkdownDir } from './markdown-dir';
import { loadPlanDocument } from './document';
import { batches, runPlanCommand } from './command';
import type { ManifestAnswer } from './output';
import { EXIT } from '../exit-codes';

/**
 * `forumulate plan` / `apply` (DX-D): a Markdown folder becomes page entries
 * with their language twins (both conventions), forumulate.yaml becomes the
 * manifest body, a big apply is split into batches that converge, and the
 * exit codes say what CI needs to know.
 */

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fmu-plan-'));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function write(rel: string, text: string): void {
  const abs = join(root, rel);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, text);
}

describe('scanMarkdownDir', () => {
  it('reads both twin conventions, front matter, order prefixes, folders and drafts', () => {
    write('docs/01-intro.md', '# Welcome\n\nHello.');
    write('docs/01-intro.es.md', '# Bienvenida\n\nHola.');
    write(
      'docs/guides/install.md',
      '---\ntitle: Install\nseoTitle: Install Numestri\ndescription: How to install\ncanonicalUrl: https://numestri.com/docs/install\norder: 3\n---\nRun it.',
    );
    write('docs/es/guides/install.md', '---\ntitle: Instalar\nslug: instalar\n---\nEjecútalo.');
    write('docs/wip.md', '---\ndraft: true\n---\nNot yet.');
    const scan = scanMarkdownDir(join(root, 'docs'), { space: 'docs', locales: ['es'] });
    expect(scan.skipped).toEqual(['wip.md (draft)']);
    const intro = scan.pages.find((p) => p.slug === 'intro')!;
    expect(intro).toMatchObject({ title: 'Welcome', body: 'Hello.', order: 1 });
    expect(intro.translations).toEqual({ es: { title: 'Bienvenida', body: 'Hola.' } });
    const install = scan.pages.find((p) => p.slug === 'install')!;
    expect(install).toMatchObject({
      title: 'Install',
      collection: 'guides',
      order: 3,
      seoTitle: 'Install Numestri',
      seoDescription: 'How to install',
      canonicalUrl: 'https://numestri.com/docs/install',
    });
    // The folder twin names its own slug; the suffix twin kept its source's.
    expect(install.translations!.es).toMatchObject({ title: 'Instalar', slug: 'instalar' });
    expect([...scan.collections]).toEqual([['guides', 'Guides']]);
  });

  it('reads preset, parentSlug and params from the source page, and a twin does not carry them', () => {
    write('docs/setup.md', '---\ntitle: Setup\npreset: howto\nparentSlug: start\nparams:\n  level: easy\n  beta: true\n---\nGo.');
    write('docs/setup.es.md', '---\ntitle: Configurar\npreset: howto\n---\nVe.');
    const scan = scanMarkdownDir(join(root, 'docs'), { space: 'docs', locales: ['es'] });
    const page = scan.pages.find((p) => p.slug === 'setup')!;
    expect(page).toMatchObject({ preset: 'howto', parent: 'start', params: { level: 'easy', beta: true } });
    expect(page.translations!.es).not.toHaveProperty('preset');
    write('docs/bad.md', '---\ntitle: Bad\nparams: nope\n---\nx');
    expect(() => scanMarkdownDir(join(root, 'docs'), { space: 'docs', locales: ['es'] })).toThrow(/params/);
  });

  it('a folder or suffix that is not a declared language is an ordinary name', () => {
    write('docs/v1.2.md', 'Old.');
    write('docs/de/page.md', 'Seite.');
    const scan = scanMarkdownDir(join(root, 'docs'), { space: 'docs', locales: ['es'] });
    expect(scan.pages.map((p) => p.slug).sort()).toEqual(['page', 'v1-2']);
    expect(scan.pages.find((p) => p.slug === 'page')!.collection).toBe('de');
  });

  it('refuses a twin without a source, a key nothing reads, and two files with one slug', () => {
    write('a/orphan.es.md', 'Solo.');
    expect(() => scanMarkdownDir(join(root, 'a'), { space: 'docs', locales: ['es'] })).toThrow(/does not exist/);
    write('b/page.md', '---\nfavouriteColour: blue\n---\nx');
    expect(() => scanMarkdownDir(join(root, 'b'), { space: 'docs' })).toThrow(/favouriteColour/);
    write('c/one.md', '---\nslug: same\n---\nx');
    write('c/two.md', '---\nslug: same\n---\ny');
    expect(() => scanMarkdownDir(join(root, 'c'), { space: 'docs' })).toThrow(/also/);
  });
});

describe('loadPlanDocument', () => {
  it('expands folders, reads about/contactForm files, implies collections, and drops CLI-only keys', () => {
    write('content/about/index.md', '# About\n\nWe count.');
    write('content/about/team/people.md', '# People\n\nUs.');
    write('about.yaml', 'mission: Make numbers legible.\n');
    write(
      'forumulate.yaml',
      [
        'version: 2',
        'org: numestri',
        'spaces:',
        '  - { slug: about, name: About, type: ABOUT, locales: [{ code: es, label: Español }], about: about.yaml }',
        'pages:',
        '  - { dir: content/about, space: about }',
        '  - { space: about, slug: press, title: Press, body: "Kit." }',
      ].join('\n'),
    );
    const doc = loadPlanDocument(join(root, 'forumulate.yaml'));
    expect(doc.org).toBe('numestri');
    expect(doc.body.org).toBeUndefined();
    const spaces = doc.body.spaces as Record<string, unknown>[];
    expect(spaces[0]!.about).toEqual({ mission: 'Make numbers legible.' });
    expect(spaces[0]!.collections).toEqual([{ name: 'Team', slug: 'team' }]);
    expect(doc.implied.get('about')).toEqual(['team']);
    expect((doc.body.pages as { slug: string }[]).map((p) => p.slug)).toEqual(['index', 'people', 'press']);
  });

  it('reads homeDoc from a Markdown file with its .<code>.md twin, and an openapi spec file as text', () => {
    write('intro.md', '# Reference\n\nEvery endpoint.');
    write('intro.es.md', 'Cada endpoint.');
    write('openapi.yaml', 'openapi: 3.0.0\ninfo: { title: Numestri }\n');
    write(
      'forumulate.yaml',
      [
        'version: 2',
        'spaces:',
        '  - { slug: reference, name: Reference, type: DOCS, locales: [{ code: es, label: Español }], homeDoc: intro.md, openapi: { spec: openapi.yaml, collection: API reference } }',
        '  - { slug: api, name: API, type: DOCS, openapi: [{ url: "https://x.dev/o.json", collection: API }] }',
      ].join('\n'),
    );
    const spaces = loadPlanDocument(join(root, 'forumulate.yaml')).body.spaces as Record<string, unknown>[];
    expect(spaces[0]!.homeDoc).toEqual({ body: '# Reference\n\nEvery endpoint.', translations: { es: { body: 'Cada endpoint.' } } });
    expect(spaces[0]!.openapi).toEqual({ spec: 'openapi: 3.0.0\ninfo: { title: Numestri }\n', collection: 'API reference' });
    expect(spaces[1]!.openapi).toEqual([{ url: 'https://x.dev/o.json', collection: 'API' }]);
  });

  it('refuses a document that is not version 2, saying what it looks like', () => {
    write('forumulate.yaml', 'org: acme\nspace: docs\n');
    expect(() => loadPlanDocument(join(root, 'forumulate.yaml'))).toThrow(/forumulate publish/);
  });
});

describe('examples/forumulate.yaml', () => {
  it('is a numestri-like site: eight spaces, English and Spanish pages, About and Contact from files', () => {
    const doc = loadPlanDocument(join(__dirname, '../../../../examples/forumulate.yaml'));
    const spaces = doc.body.spaces as Record<string, unknown>[];
    expect(spaces.map((s) => s.type)).toEqual(['DOCS', 'BLOG', 'CHANGELOG', 'STATUS', 'FORUM', 'LEGAL', 'ABOUT', 'CONTACT']);
    expect(spaces.find((s) => s.slug === 'about')!.about).toMatchObject({ mission: 'Make every number explain itself.' });
    expect(spaces.find((s) => s.slug === 'contact')!.contactForm).toMatchObject({
      translations: { es: { nextSteps: { Documentation: 'Documentación' } } },
    });
    const pages = doc.body.pages as { space: string; slug: string; body?: string; translations?: Record<string, { slug?: string }> }[];
    expect(pages.map((p) => `${p.space}/${p.slug}`).sort()).toEqual([
      'about/story',
      'docs/api-keys',
      'docs/getting-started',
      'legal/privacy',
      'legal/terms',
    ]);
    expect(pages.every((p) => p.translations?.es)).toBe(true);
    expect(pages.find((p) => p.slug === 'api-keys')!.translations!.es!.slug).toBe('claves-de-api');
    // A link to another file became a link to that page.
    expect(pages.find((p) => p.slug === 'getting-started')!.body).toContain('](./api-keys)');
    // The guides folder is a collection the docs space now declares.
    expect(spaces.find((s) => s.slug === 'docs')!.collections).toEqual([{ name: 'Guides', slug: 'guides' }]);
  });
});

const step = (unit: string, ref: string, action: ManifestAnswer['steps'][number]['action']) => ({ unit, ref, action, diff: {} });

describe('batches', () => {
  const pages = Array.from({ length: 5 }, (_, i) => ({ space: 'docs', slug: `p${i}`, title: `P${i}` }));
  const body = { version: 2, prune: true, pages };
  const plan: ManifestAnswer = {
    dryRun: true,
    ok: true,
    steps: [
      step('pages', 'docs/p0', 'unchanged'),
      ...[1, 2, 3, 4].map((i) => step('pages', `docs/p${i}`, 'create')),
      step('pages', 'docs/p1@es', 'create'),
    ],
  };

  it('sends changed pages a batch at a time; only the last request is whole and may prune', () => {
    const out = batches(body, plan, 2);
    expect(out.map((b) => (b.pages as { slug: string }[]).map((p) => p.slug))).toEqual([
      ['p0', 'p1', 'p2'],
      ['p0', 'p1', 'p2', 'p3', 'p4'],
    ]);
    expect(out[0]!.prune).toBe(false);
    expect(out[out.length - 1]).toBe(body);
  });

  it('is one request when the change fits', () => {
    expect(batches(body, plan, 20)).toEqual([body]);
  });
});

function fakeClient(answers: { plan: ManifestAnswer; apply?: ManifestAnswer }) {
  const calls: { method: string; path: string; query?: unknown; body?: unknown }[] = [];
  return {
    calls,
    client: {
      async request<T>(method: string, path: string, opts: { body?: unknown; query?: Record<string, unknown> } = {}): Promise<T> {
        calls.push({ method, path, query: opts.query, body: opts.body });
        if (method === 'GET' && path.endsWith('/spaces')) return { spaces: [{ id: 'sp1', slug: 'docs' }] } as T;
        if (method === 'GET' && path.endsWith('/collections')) return { collections: [] } as T;
        if (method === 'PUT' && path.endsWith('/manifest'))
          return (opts.query?.apply ? (answers.apply ?? answers.plan) : answers.plan) as T;
        throw Object.assign(new Error(`unexpected ${method} ${path}`), { status: 404 });
      },
    },
  };
}

describe('runPlanCommand', () => {
  const plan: ManifestAnswer = {
    dryRun: true,
    ok: true,
    steps: [step('pages', 'docs/intro', 'create'), step('seo', 'docs', 'unchanged')],
    extras: [],
    manual: [],
  };

  beforeEach(() => {
    write('content/intro.md', '# Intro\n\nHi.');
    write('forumulate.yaml', 'version: 2\norg: acme\npages:\n  - { dir: content, space: docs }\n');
  });

  const run = async (command: 'plan' | 'apply', client: ReturnType<typeof fakeClient>, extra: Partial<Parameters<typeof runPlanCommand>[0]> = {}) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runPlanCommand(
      { command, prune: false, json: false, diff: false, check: false, verbose: false, batch: 20, file: join(root, 'forumulate.yaml'), ...extra },
      { client: client.client, out: (l) => out.push(l), err: (l) => err.push(l), env: {} },
    );
    return { code, out, err };
  };

  it('plan prints only what moves and writes nothing; --check fails on a non-empty plan', async () => {
    const c = fakeClient({ plan });
    const r = await run('plan', c);
    expect(r.code).toBe(EXIT.OK);
    expect(r.out).toContain('+ create    pages        docs/intro');
    expect(r.out[r.out.length - 1]).toBe('Plan: 1 to create, 0 to update, 0 to delete, 1 unchanged.');
    expect(c.calls.filter((x) => x.method === 'PUT').every((x) => !x.query)).toBe(true);
    expect((await run('plan', fakeClient({ plan }), { check: true })).code).toBe(EXIT.FAILED);
  });

  it('an empty plan passes --check', async () => {
    const empty = { ...plan, steps: [step('pages', 'docs/intro', 'unchanged')] };
    const r = await run('plan', fakeClient({ plan: empty }), { check: true });
    expect(r.code).toBe(EXIT.OK);
    expect(r.out[r.out.length - 1]).toBe('No changes. 1 unchanged.');
  });

  it('apply writes with ?apply=true and fails when a write did not read back', async () => {
    const applied: ManifestAnswer = {
      dryRun: false,
      ok: true,
      steps: [{ unit: 'pages', ref: 'docs/intro', action: 'create', status: 'applied', readBack: 'mismatch', id: 'p1' }],
    };
    const c = fakeClient({ plan, apply: applied });
    const r = await run('apply', c);
    expect(c.calls.some((x) => x.method === 'PUT' && (x.query as { apply?: boolean })?.apply === true)).toBe(true);
    expect(r.code).toBe(EXIT.FAILED);
    expect(r.out.join('\n')).toMatch(/READ BACK DIFFERS/);
  });

  it('sends the pages it read, with the org from the file and nothing CLI-only', async () => {
    const c = fakeClient({ plan });
    await run('plan', c);
    const put = c.calls.find((x) => x.method === 'PUT')!;
    expect(put.path).toBe('/orgs/acme/manifest');
    expect(put.body).toEqual({ version: 2, pages: [{ space: 'docs', slug: 'intro', title: 'Intro', body: 'Hi.' }] });
  });

  it('a missing org is a usage error', async () => {
    write('forumulate.yaml', 'version: 2\n');
    expect((await run('plan', fakeClient({ plan }))).code).toBe(EXIT.USAGE);
  });
});
