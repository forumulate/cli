import { describe, expect, it } from 'vitest';
import { ForumulateClient } from '@forumulate/sdk';
import { run } from '../run';
import { readTranslationFile, writeTranslationFile } from './files';
import { fromXliff, toXliff } from './xliff';

/*
 * `forumulate translations` against a fake API: the real SDK client over a
 * fetch that answers from a route table, so the CLI is tested through the same
 * routing a live run takes, and files live in a map.
 */

const ORG = '11111111-1111-4111-8111-111111111111';
const SP = `/orgs/${ORG}/spaces/s1`;

function harness(routes: Record<string, unknown>, files: Record<string, string> = {}) {
  const calls: { method: string; path: string; body?: unknown }[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const u = new URL(url);
    const path = u.pathname.replace(/^\/api/, '') + u.search;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path, body });
    const hit = routes[`${init.method} ${path}`];
    if (typeof hit === 'function') {
      const [status, json] = (hit as (b: unknown) => [number, unknown])(body);
      return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } });
    }
    if (hit === undefined)
      return new Response(JSON.stringify({ error: { code: 'not_found', message: `no route ${init.method} ${path}` } }), { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify(hit), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof globalThis.fetch;
  const client = new ForumulateClient({ baseUrl: 'https://x.test/api', token: 't', fetch });
  const out: string[] = [];
  const err: string[] = [];
  const deps = {
    client,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    env: {},
    translationFiles: {
      read: (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p]!;
      },
      write: (p: string, t: string) => void (files[p] = t),
      exists: (p: string) => p in files,
      list: (dir: string) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)),
    },
  };
  return { deps, calls, out, err, files };
}

const BASE = {
  'GET /orgs': { orgs: [{ id: ORG, slug: 'acme', name: 'Acme' }] },
  [`GET /orgs/${ORG}/spaces`]: { spaces: [{ id: 's1', slug: 'docs', name: 'Docs', type: 'DOCS' }] },
};

const cell = (state: string, id: string | null = null) => ({ state, id, origin: 'human', updatedAt: null });
const COVERAGE = {
  spaceId: 's1',
  spaceType: 'DOCS',
  kind: 'page',
  locales: [{ code: 'es', label: 'Español' }, { code: 'fr', label: 'Français' }],
  items: [
    { id: 'p1', title: 'Start', slug: 'start', kind: 'page', locales: { es: cell('published', 't1'), fr: cell('missing') } },
    { id: 'p2', title: 'Guide', slug: 'guide', kind: 'page', locales: { es: cell('outdated', 't2'), fr: cell('published', 't3') } },
  ],
  totals: { es: { missing: 0, draft: 0, published: 1, outdated: 1 }, fr: { missing: 1, draft: 0, published: 1, outdated: 0 } },
  truncated: false,
};

describe('forumulate translations status', () => {
  it('prints the totals and exits 0 with no gate', async () => {
    const h = harness({ ...BASE, [`GET ${SP}/translations`]: COVERAGE });
    expect(await run(['translations', 'status', '--space', 'docs'], h.deps)).toBe(0);
    expect(h.out[0]).toContain('2 page(s)');
    expect(h.out.some((l) => /^outdated\s+1\s+0/.test(l))).toBe(true);
    expect(h.out.some((l) => l.includes('fr') && l.includes('missing') && l.includes('start'))).toBe(true);
  });

  it('fails a CI gate on the states it names, for the languages it names', async () => {
    const h = harness({ ...BASE, [`GET ${SP}/translations`]: COVERAGE });
    expect(await run(['i18n', 'status', '--space', 'docs', '--fail-on', 'missing,outdated'], h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/FAIL: 2 translation/);
    const only = harness({ ...BASE, [`GET ${SP}/translations`]: COVERAGE });
    expect(await run(['translations', 'status', '--space', 'docs', '--locale', 'fr', '--fail-on', 'outdated'], only.deps)).toBe(0);
  });

  it('refuses a state that does not exist', async () => {
    const h = harness({ ...BASE, [`GET ${SP}/translations`]: COVERAGE });
    expect(await run(['translations', 'status', '--space', 'docs', '--fail-on', 'stale'], h.deps)).toBe(1);
    expect(h.err[0]).toContain('missing,draft,published,outdated');
  });
});

describe('forumulate translations locales', () => {
  const locales = { locales: [{ code: 'default', label: 'Original', isDefault: true }, { code: 'es', label: 'Español', isDefault: false }] };
  it('adds a language, naming it in its own words when no label is given', async () => {
    const h = harness({ ...BASE, [`POST ${SP}/docs/locales`]: locales });
    expect(await run(['translations', 'locales', 'add', 'es', '--space', 'docs'], h.deps)).toBe(0);
    expect(h.calls.at(-1)!.body).toEqual({ code: 'es', label: 'español' });
  });

  it('will not remove a language without --yes where nobody can answer', async () => {
    const h = harness({ ...BASE, [`DELETE ${SP}/docs/locales/es`]: locales });
    expect(await run(['translations', 'locales', 'remove', 'es', '--space', 'docs'], h.deps)).toBe(1);
    expect(h.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(await run(['translations', 'locales', 'remove', 'es', '--space', 'docs', '--yes'], h.deps)).toBe(0);
  });

  it('addresses a library with --library', async () => {
    const h = harness({
      ...BASE,
      [`GET /orgs/${ORG}/content/libraries`]: { libraries: [{ id: 'l1', slug: 'site', name: 'Site' }] },
      [`GET /orgs/${ORG}/content/libraries/l1/locales`]: { sourceLocale: 'en', locales: [{ code: 'en', label: 'English', source: true }] },
    });
    expect(await run(['translations', 'locales', 'list', '--library', 'site'], h.deps)).toBe(0);
    expect(h.out).toEqual(['en  English  (source)']);
  });
});

describe('forumulate translations auto', () => {
  it('says plainly that there is no key, before translating anything', async () => {
    const h = harness({ ...BASE, [`GET /orgs/${ORG}/deepl`]: { configured: false } });
    expect(await run(['translations', 'auto', '--space', 'docs', '--locale', 'es'], h.deps)).toBe(1);
    expect(h.err[0]).toMatch(/no translation provider connected.*DeepL key/);
    expect(h.calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('translates only the cells in the asked states', async () => {
    const h = harness({
      ...BASE,
      [`GET /orgs/${ORG}/deepl`]: { configured: true },
      [`GET ${SP}/translations`]: COVERAGE,
      [`POST ${SP}/pages/p2/translations/es/auto`]: { translation: {} },
      [`POST ${SP}/pages/p1/translations/fr/auto`]: { translation: {} },
    });
    expect(await run(['translations', 'auto', '--space', 'docs', '--locale', 'es,fr'], h.deps)).toBe(0);
    const posts = h.calls.filter((c) => c.method === 'POST').map((c) => c.path);
    expect(posts.sort()).toEqual([`${SP}/pages/p1/translations/fr/auto`, `${SP}/pages/p2/translations/es/auto`]);
  });
});

describe('forumulate translations pull / push', () => {
  const routes = {
    ...BASE,
    [`GET ${SP}`]: { space: { type: 'DOCS' } },
    [`GET ${SP}/translations`]: COVERAGE,
    [`GET ${SP}/pages/p1/translations`]: { translations: [{ code: 'es', label: 'Español', ...cell('published', 't1') }, { code: 'fr', label: 'Français', ...cell('missing') }] },
    [`GET ${SP}/pages/p2/translations`]: { translations: [{ code: 'es', label: 'Español', ...cell('outdated', 't2') }, { code: 'fr', label: 'Français', ...cell('published', 't3') }] },
    [`GET ${SP}/items/t1`]: { item: { title: 'Inicio', markdown: 'Hola' } },
    [`GET ${SP}/items/t2`]: { item: { title: 'Guía', markdown: 'Vieja' } },
    [`GET ${SP}/items/t3`]: { item: { title: 'Guide FR', markdown: 'Bonjour' } },
    [`GET ${SP}/items/p1`]: { item: { title: 'Start', markdown: 'Hello' } },
    [`PUT ${SP}/items/t2/content`]: { conformance: {} },
    // A published twin's edit is a draft until published: `published: true` in the file says to.
    [`POST ${SP}/items/t2/publish`]: { published: true },
  };

  it('writes one file per piece per language, stubs only when asked', async () => {
    const h = harness(routes);
    expect(await run(['translations', 'pull', '--space', 'docs'], h.deps)).toBe(0);
    expect(Object.keys(h.files).sort()).toEqual(['translations/es/guide.md', 'translations/es/start.md', 'translations/fr/guide.md']);
    expect(readTranslationFile(h.files['translations/es/start.md']!)).toMatchObject({ piece: 'p1', locale: 'es', title: 'Inicio', markdown: 'Hola' });
    const stubs = harness(routes);
    await run(['translations', 'pull', '--space', 'docs', '--include-missing'], stubs.deps);
    expect(readTranslationFile(stubs.files['translations/fr/start.md']!)).toMatchObject({ state: 'missing', markdown: 'Hello' });
  });

  it('pushes only what changed, skips untouched stubs, and is idempotent', async () => {
    const h = harness(routes);
    await run(['translations', 'pull', '--space', 'docs', '--include-missing'], h.deps);
    h.files['translations/es/guide.md'] = h.files['translations/es/guide.md']!.replace('Vieja', 'Nueva');
    expect(await run(['translations', 'push', '--space', 'docs', '--dry-run'], h.deps)).toBe(0);
    expect(h.calls.some((c) => c.method === 'PUT')).toBe(false);
    expect(h.out.some((l) => l.includes('would write') && l.includes('es/guide.md'))).toBe(true);
    expect(h.out.some((l) => l.includes('fr/start.md') && l.includes("original's words"))).toBe(true);
    expect(await run(['translations', 'push', '--space', 'docs'], h.deps)).toBe(0);
    expect(h.calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.path}`)).toEqual([
      `PUT ${SP}/items/t2/content`,
      `POST ${SP}/items/t2/publish`,
    ]);
    expect(h.calls.find((c) => c.method === 'PUT')!.body).toEqual({ body: 'Nueva' });
  });
});

describe('forumulate translations labels / overrides', () => {
  it('round-trips the chrome dictionary through XLIFF, sending only changed words', async () => {
    const h = harness({
      ...BASE,
      [`GET ${SP}/i18n/strings`]: {
        languages: ['es'],
        labels: { es: { Docs: 'Documentos' } },
        strings: [{ text: 'Docs', dictionary: { es: 'Documentos' } }, { text: 'Pricing', dictionary: {} }],
        coverage: {},
      },
      [`PATCH ${SP}/i18n/labels`]: { labels: {} },
    });
    expect(await run(['translations', 'labels', 'pull', '--space', 'docs', '--format', 'xliff'], h.deps)).toBe(0);
    const xlf = h.files['labels.xlf']!;
    expect(fromXliff(xlf)[0]!.units).toEqual([
      { id: 'Docs', source: 'Docs', target: 'Documentos' },
      { id: 'Pricing', source: 'Pricing', target: '' },
    ]);
    h.files['labels.xlf'] = xlf.replace('<target></target>', '<target>Precios</target>');
    expect(await run(['translations', 'labels', 'push', 'labels.xlf', '--space', 'docs'], h.deps)).toBe(0);
    expect(h.calls.at(-1)).toMatchObject({ method: 'PATCH', body: { labels: { es: { Pricing: 'Precios' } } } });
  });

  it('pushes overrides and prunes only with --prune', async () => {
    const h = harness(
      {
        ...BASE,
        [`GET /orgs/${ORG}/translation-overrides`]: { overrides: [{ locale: 'es', key: 'a', value: 'x', updatedAt: '' }, { locale: 'es', key: 'b', value: 'y', updatedAt: '' }] },
        [`PUT /orgs/${ORG}/translation-overrides`]: { override: {} },
        [`DELETE /orgs/${ORG}/translation-overrides?locale=es&key=b`]: { ok: true },
      },
      { 'o.json': JSON.stringify({ overrides: { es: { a: 'x2' } } }) },
    );
    expect(await run(['translations', 'overrides', 'push', 'o.json'], h.deps)).toBe(0);
    expect(h.calls.filter((c) => c.method !== 'GET').map((c) => c.method)).toEqual(['PUT']);
    expect(await run(['translations', 'overrides', 'push', 'o.json', '--prune'], h.deps)).toBe(0);
    expect(h.calls.at(-1)!.method).toBe('DELETE');
  });
});

describe('translation files', () => {
  it('round-trips front matter and escapes XLIFF', () => {
    const text = writeTranslationFile({ space: 's', piece: 'p', locale: 'es', door: 'blog', title: 'Hola: mundo', markdown: '# x', excerpt: 'e', published: false });
    expect(readTranslationFile(text)).toMatchObject({ title: 'Hola: mundo', excerpt: 'e', published: false, markdown: '# x' });
    const xlf = toXliff([{ locale: 'es', units: [{ id: 'a&b', source: '<x>', target: '"y"' }] }], { original: 't' });
    expect(fromXliff(xlf)[0]!.units[0]).toEqual({ id: 'a&b', source: '<x>', target: '"y"' });
  });
});
