import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ForumulateClient } from '@forumulate/sdk';
import { readContentfulExport } from './contentful';
import { diskFiles } from './disk';
import { entryKey, runImport, slugOf, titleOf, type EngineOptions } from './engine';
import { applyListPatch, resolveType } from './model-fields';
import { readPayloadExport } from './payload';
import { exitCode, reportLines } from './report';
import type { ImportFiles } from './types';

const ROOT = path.join(__dirname, '__fixtures__', 'payload-website');
const files: ImportFiles = {
  ...diskFiles,
  exists: (p) => /\.png$/.test(p) || diskFiles.exists(p),
  readBytes: (p) => (/\.png$/.test(p) ? new TextEncoder().encode(`bytes:${path.basename(p)}`) : diskFiles.readBytes(p)),
};
const source = () => readPayloadExport(ROOT, files, { configPath: path.join(ROOT, 'payload.config.ts.txt') });

/**
 * The model the API stores for the Payload website fixture, built from the view
 * the API's own test pins (apps/api import-fixtures.test.ts): the importer is
 * written against what the API really produces, not against a hand-made model.
 */
interface ViewType { titleField?: string; singleton?: boolean; fields: unknown[] }
const VIEW = JSON.parse(readFileSync(path.join(ROOT, 'importer-view.json'), 'utf8')) as { types: Record<string, ViewType>; blocks: Record<string, unknown[]> };
const STORED = {
  shape: { blockTypes: { add: Object.entries(VIEW.blocks).map(([key, fields]) => ({ key, label: key, fields })) } },
  types: Object.fromEntries(
    Object.entries(VIEW.types).map(([key, t]) => [
      key,
      { label: key, patch: { params: { add: t.fields } }, settings: { ...(t.titleField ? { titleField: t.titleField } : {}), ...(t.singleton ? { singleton: true } : {}) } },
    ]),
  ),
  version: 4,
};

// Test-only view of a written entry's params: the shapes are asserted field by field below.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Fields = Record<string, any>;
interface Call { fn: string; args: unknown[] }
function fakeClient(opts: { existingAssets?: { id: string; url: string; filename: string }[]; failCreate?: (title: string) => boolean; removeType?: string } = {}) {
  const calls: Call[] = [];
  let n = 0;
  const byKey = new Map<string, string>();
  const libLocales = [{ code: 'en', label: 'English' }];
  const note = (fn: string, ...args: unknown[]) => calls.push({ fn, args });
  const client = {
    content: {
      model: {
        import: async (_o: string, _l: string, input: { dryRun?: boolean }) => {
          note('model.import', input);
          return {
            changed: true, applied: !input.dryRun, storageOnly: false, ops: [], version: input.dryRun ? 3 : 4,
            diff: opts.removeType ? [{ op: 'remove', target: 'type', type: opts.removeType }] : [{ op: 'add', target: 'type', type: 'pages' }],
            issues: [{ path: 'pages.hooks', kind: 'hook', message: 'afterChange is code' }],
          };
        },
        get: async () => ({ model: STORED }),
      },
      locales: {
        list: async () => ({ sourceLocale: 'en', locales: libLocales }),
        add: async (_o: string, _l: string, input: { code: string; label: string }) => (note('locales.add', input), libLocales.push(input), { sourceLocale: 'en', locales: libLocales }),
      },
      assets: { list: async (_o: string, _l: string, q: { search?: string }) => ({ assets: (opts.existingAssets ?? []).filter((a) => a.filename.startsWith(q.search ?? '')) }) },
      entries: {
        create: async (_o: string, _l: string, input: { title: string; preset: string }, key: string) => {
          if (opts.failCreate?.(input.title)) throw new Error('422 strict type');
          note('create', input, key);
          const id = `e${++n}`;
          byKey.set(key, id);
          return { item: { id, title: input.title } };
        },
        lookup: async (_o: string, _l: string, keys: string[]) => ({ found: Object.fromEntries(keys.filter((k) => byKey.has(k)).map((k) => [k, byKey.get(k)!])) }),
        update: async (_o: string, _l: string, id: string, input: { title?: string }) => (note('update', id, input), { item: { id, title: input.title ?? '' } }),
        writeLocale: async (_o: string, _l: string, id: string, locale: string, fields: unknown) => (note('writeLocale', id, locale, fields), { locale, sourceEntryId: id, entryId: `${id}-${locale}`, created: true }),
        setFields: async (_o: string, _l: string, id: string, fields: unknown) => (note('setFields', id, fields), { fields }),
        publish: async (_o: string, _l: string, id: string) => (note('publish', id), { published: true }),
      },
    },
  } as unknown as ForumulateClient;
  const uploads: { path: string; name: string }[] = [];
  const upload = async (p: string, form: FormData) => {
    const file = form.get('file') as File;
    uploads.push({ path: p, name: file.name });
    return { asset: { id: `a${uploads.length}`, url: `https://assets.test/${file.name}`, filename: file.name } };
  };
  return { client, calls, uploads, upload };
}

const base: EngineOptions = { orgId: 'o', libraryId: 'l', dryRun: false, publish: 'source', allowModelRemovals: false, pace: 0 };
const deps = (c: ReturnType<typeof fakeClient>) => ({ client: c.client, upload: c.upload, files, fetchBytes: async () => new Uint8Array(), root: ROOT, sleep: async () => {} });
const created = (c: ReturnType<typeof fakeClient>) => c.calls.filter((x) => x.fn === 'create').map((x) => ({ input: x.args[0] as { title: string; slug?: string; preset: string; params: Fields }, key: x.args[1] as string }));
const idOf = (c: ReturnType<typeof fakeClient>, title: string) => `e${created(c).findIndex((x) => x.input.title === title) + 1}`;

describe('the stored model, read back', () => {
  it('applies add, omit, set, unset and order', () => {
    const base = [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }, { key: 'c', label: 'C' }];
    const out = applyListPatch(base, { add: [{ key: 'd', label: 'D' }], omit: ['b'], set: { a: { label: 'AA' } }, unset: { c: ['label'] }, order: ['d'] });
    expect(out).toEqual([{ key: 'd', label: 'D' }, { key: 'a', label: 'AA' }, { key: 'c' }]);
  });
  it('resolves fields, blocks and the title field', () => {
    const r = resolveType(STORED as never, 'pages')!;
    expect(r.fields.map((x) => x.key)).toEqual(['title', 'hero', 'layout', 'meta', 'publishedAt', 'slug']);
    expect(r.blocks.get('content')![0]!.fields!.map((x) => x.key)).toEqual(['size', 'richText']);
    expect(r.titleField).toBe('title');
    expect(resolveType(STORED as never, 'nope')).toBeNull();
  });
});

describe('titles, slugs and keys', () => {
  it('prefers the record title, then the type title field, then name, slug, id', () => {
    const r = (o: object) => ({ type: 't', id: '9', published: true, values: {}, ...o });
    expect(titleOf(r({ title: ' T ' }), null)).toBe('T');
    expect(titleOf(r({ values: { heading: 'H' } }), { fields: [], blocks: new Map(), titleField: 'heading' })).toBe('H');
    expect(titleOf(r({ values: { name: 'N' } }), null)).toBe('N');
    expect(titleOf(r({ slug: 's' }), null)).toBe('s');
    expect(titleOf(r({}), null)).toBe('9');
  });
  it('slugs lose accents and punctuation; keys differ by library and record', () => {
    expect(slugOf('Crème Brûlée!')).toBe('creme-brulee');
    expect(slugOf('!!!')).toBeUndefined();
    const k = (lib: string, id: string) => entryKey('payload', lib, { type: 'posts', id });
    expect(k('l', '1')).toBe(k('l', '1'));
    expect(new Set([k('l', '1'), k('l', '2'), k('m', '1')]).size).toBe(3);
    expect(k('l', '1').length).toBeLessThan(200);
  });
});

describe('importing the Payload website fixture', () => {
  it('a dry run reads the model and writes nothing', async () => {
    const c = fakeClient();
    const r = await runImport(source(), deps(c), { ...base, dryRun: true });
    expect(c.calls.map((x) => x.fn)).toEqual(['model.import']);
    expect((c.calls[0]!.args[0] as { dryRun: boolean; format: string }).dryRun).toBe(true);
    expect((c.calls[0]!.args[0] as { format: string }).format).toBe('payload');
    expect(r.entries.planned).toBe(6);
    expect(r.media.planned).toBe(2);
    expect(r.model.issues[0]!.kind).toBe('hook');
    expect(c.uploads).toHaveLength(0);
    expect(reportLines(r).join('\n')).toMatch(/6 entries and 2 files would be imported from payload/);
  });

  it('refuses a model that removes types unless told it may', async () => {
    const c = fakeClient({ removeType: 'legacy' });
    await expect(runImport(source(), deps(c), base)).rejects.toThrow(/would remove content types the library has \(legacy\)/);
    expect(c.calls.filter((x) => x.fn === 'create')).toHaveLength(0);
    await expect(runImport(source(), deps(c), { ...base, allowModelRemovals: true })).resolves.toBeTruthy();
  });

  it('applies the model, uploads each file once, creates drafts, writes references, then publishes', async () => {
    const c = fakeClient();
    const r = await runImport(source(), deps(c), base);
    expect(c.calls.filter((x) => x.fn === 'model.import').map((x) => (x.args[0] as { dryRun?: boolean }).dryRun)).toEqual([true, undefined]);
    expect(r.model.version).toBe(4);
    expect(c.uploads.map((u) => u.name.replace(/^[0-9a-f]{12}-/, ''))).toEqual(['hero.png', 'inline.png']);
    expect(c.uploads[0]!.path).toBe('/orgs/o/content/libraries/l/assets');
    expect(r.media.uploaded).toBe(2);

    const made = created(c);
    expect(made.map((m) => m.input.preset)).toEqual(['categories', 'categories', 'pages', 'posts', 'posts', 'header']);
    expect(new Set(made.map((m) => m.key)).size).toBe(6);

    const first = made.find((m) => m.input.title === 'First post')!;
    expect(first.input.slug).toBe('first-post');
    expect(first.input.params.heroImage).toEqual({ assetId: 'a1' });
    // Categories were created before the post, so their ids are known on the first write.
    expect(first.input.params.categories).toEqual([{ kind: 'entry', id: idOf(c, 'Technology') }, { kind: 'entry', id: idOf(c, 'News') }]);
    // A forward reference is absent from the first write...
    expect(first.input.params.relatedPosts).toBeUndefined();
    expect(first.input.params.publishedAt).toBe('2025-02-01T09:30:00.000Z');
    const body = first.input.params.content;
    expect(body.content.map((n: { type: string }) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'image']);
    expect(body.content[3].attrs.src).toMatch(/^https:\/\/assets\.test\/[0-9a-f]{12}-inline\.png$/);

    // ...and written once every entry exists.
    const sets = c.calls.filter((x) => x.fn === 'setFields');
    const firstSet = sets.find((s) => s.args[0] === idOf(c, 'First post'))!;
    expect((firstSet.args[1] as Fields).relatedPosts).toEqual([{ kind: 'entry', id: idOf(c, 'Second post') }]);
    const secondSet = sets.find((s) => s.args[0] === idOf(c, 'Second post'))!;
    expect((secondSet.args[1] as Fields).relatedPosts).toEqual([{ kind: 'entry', id: idOf(c, 'First post') }]);
    expect((secondSet.args[1] as Fields).categories).toEqual([{ kind: 'entry', id: idOf(c, 'Technology') }]);

    const home = made.find((m) => m.input.title === 'Home')!.input.params;
    expect(home.hero).toMatchObject({ type: 'highImpact', media: { assetId: 'a1' } });
    expect(home.layout.map((b: { blockType: string }) => b.blockType)).toEqual(['cta', 'content', 'mediaBlock']);
    expect(home.layout[1].columns).toEqual([{ size: 'half', richText: expect.objectContaining({ type: 'doc' }) }]);
    expect(home.layout[2].media).toEqual({ assetId: 'a2' });
    expect(made.find((m) => m.input.preset === 'header')!.input.params.navItems[1].link).toEqual({ type: 'custom', label: 'Docs', url: 'https://example.com/docs', newTab: true });

    // Only what was live is published; the draft post stays a draft.
    const published = c.calls.filter((x) => x.fn === 'publish').map((x) => x.args[0]);
    expect(published).not.toContain(idOf(c, 'Second post'));
    expect(published).toContain(idOf(c, 'First post'));
    expect(r.entries.published).toBe(5);
    expect(c.calls.at(-1)!.fn).toBe('publish');
  });

  it('reports what it could not place, never silently', async () => {
    const c = fakeClient();
    const r = await runImport(source(), deps(c), base);
    expect(r.dropped).toEqual([{ field: 'pages.layout[3]<archive>', count: 1 }, { field: 'pages.legacyFlag', count: 1 }]);
    expect(r.unresolved).toEqual([
      { from: 'posts:10', to: 'users:3' },
      { from: 'posts:11', to: 'posts:99' },
    ]);
    const text = reportLines(r).join('\n');
    expect(text).toContain('pages.legacyFlag');
    expect(text).toContain('posts:11 → posts:99');
    expect(exitCode(r)).toBe(0);
  });

  it('--publish none leaves drafts and --publish all publishes everything', async () => {
    const none = fakeClient();
    await runImport(source(), deps(none), { ...base, publish: 'none' });
    expect(none.calls.some((x) => x.fn === 'publish')).toBe(false);
    const all = fakeClient();
    const r = await runImport(source(), deps(all), { ...base, publish: 'all' });
    expect(r.entries.published).toBe(6);
  });

  it('re-uses files already in the library and keeps going when one entry fails', async () => {
    const probe = fakeClient();
    await runImport(source(), deps(probe), base);
    const existing = probe.uploads.map((u, i) => ({ id: `old${i}`, url: `https://old.test/${u.name}`, filename: u.name }));
    const c = fakeClient({ existingAssets: existing, failCreate: (t) => t === 'News' });
    const r = await runImport(source(), deps(c), base);
    expect(c.uploads).toHaveLength(0);
    expect(r.media.uploaded).toBe(0);
    expect(created(c).find((m) => m.input.title === 'First post')!.input.params.heroImage).toEqual({ assetId: 'old0' });
    expect(r.entries.failed).toEqual([{ id: '2', type: 'categories', message: '422 strict type' }]);
    expect(r.entries.created).toBe(5);
    expect(exitCode(r)).toBe(1);
    // The failed category is unresolved for the post that names it, and the post still lands.
    expect(created(c).find((m) => m.input.title === 'First post')!.input.params.categories).toEqual([{ kind: 'entry', id: idOf(c, 'Technology') }]);
  });

  it('skips records of a type the model did not map and says so', async () => {
    const s = source();
    s.records.push({ type: 'users', id: '3', published: true, values: { name: 'x' } });
    const r = await runImport(s, deps(fakeClient()), base);
    expect(r.notes.join(' ')).toMatch(/1 record\(s\) of "users" were skipped/);
    expect(r.entries.failed).toEqual([]);
  });

  it('a re-run UPDATES the entries the first run made, and a dry run says so', async () => {
    const c = fakeClient();
    const first = await runImport(source(), deps(c), base);
    expect(first.entries.created).toBe(6);
    const dry = await runImport(source(), deps(c), { ...base, dryRun: true });
    expect(dry.plan).toEqual({ new: 0, update: 6 });
    expect(reportLines(dry).join('\n')).toMatch(/0 new, 6 already imported before/);
    const before = created(c).length;
    const again = await runImport(source(), deps(c), base);
    expect(created(c)).toHaveLength(before);
    expect(again.entries).toMatchObject({ created: 0, updated: 6, failed: [] });
    expect(c.calls.filter((x) => x.fn === 'update').map((x) => x.args[0])).toEqual(['e1', 'e2', 'e3', 'e4', 'e5', 'e6']);
  });

  it('writes other-locale values as locale twins, adding the language first', async () => {
    const s = readContentfulExport(readFileSync(path.join(__dirname, '__fixtures__', 'contentful', 'export.json'), 'utf8'));
    s.modelSource = undefined;
    const c = fakeClient();
    c.client.content.model.get = async () => ({
      model: {
        shape: {},
        types: {
          person: { label: 'p', patch: { params: { add: [{ key: 'name', type: 'text' }] } } },
          blogPost: { label: 'b', patch: { params: { add: [{ key: 'title', type: 'text', localized: true }, { key: 'summary', type: 'textarea', localized: true }, { key: 'views', type: 'number' }] } } },
        },
        version: 1,
      },
    }) as never;
    const r = await runImport(s, deps(c), base);
    expect(c.calls.filter((x) => x.fn === 'locales.add').map((x) => x.args[0])).toEqual([{ code: 'de', label: 'de' }]);
    const twin = c.calls.find((x) => x.fn === 'writeLocale')!;
    expect(twin.args.slice(1)).toEqual(['de', { title: 'Hallo', summary: 'Eine Zusammenfassung' }]);
    expect(r.entries.translations).toBe(1);
    // The twin is published with its source (the source was published in Contentful).
    expect(c.calls.filter((x) => x.fn === 'publish').map((x) => x.args[0])).toContain(`${twin.args[0]}-de`);
  });

  it('paces writes', async () => {
    const waits: number[] = [];
    const c = fakeClient();
    await runImport(source(), { ...deps(c), sleep: async (ms) => void waits.push(ms) }, { ...base, pace: 50 });
    expect(waits.length).toBeGreaterThan(10);
    expect(new Set(waits)).toEqual(new Set([50]));
  });
});
