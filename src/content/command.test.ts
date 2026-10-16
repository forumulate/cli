import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ContentModelImportResult, ForumulateClient } from '@forumulate/sdk';
import { run } from '../run';
import { renameOps } from './command';
import { diffLines } from './render';

const ORG = '11111111-1111-4111-8111-111111111111';
const LIB = '22222222-2222-4222-8222-222222222222';
const schema = JSON.parse(readFileSync(path.join(__dirname, '__fixtures__', 'website.schema.json'), 'utf8'));

const DIFF: ContentModelImportResult = {
  changed: true,
  applied: false,
  storageOnly: false,
  version: 4,
  diff: [
    { op: 'remove', target: 'field', type: 'post', path: 'excerpt', before: 'textarea' },
    { op: 'change', target: 'field', type: 'post', path: 'author', property: 'maxLength', after: 80 },
    { op: 'add', target: 'type', type: 'author', after: 'Author' },
  ],
  ops: [{ op: 'removeField', type: 'post', path: 'excerpt' }],
  issues: [{ path: 'collections.pages.hooks', kind: 'hook', message: '`hooks` is code the content model does not run.' }],
};

function harness(opts: { changed?: boolean; files?: Record<string, string>; ask?: string } = {}) {
  const files: Record<string, string> = { ...(opts.files ?? {}) };
  const out: string[] = [];
  const err: string[] = [];
  const imports: Record<string, unknown>[] = [];
  const client = {
    orgs: { list: async () => ({ orgs: [{ id: ORG, slug: 'acme', name: 'Acme' }] }) },
    content: {
      libraries: { list: async () => ({ libraries: [{ id: LIB, slug: 'site', name: 'Acme site' }] }) },
      model: {
        schema: async () => schema,
        export: async (_o: string, _l: string, format: string) => ({
          format,
          filename: format === 'json' ? 'forumulate.content.json' : 'forumulate.payload.ts',
          content: `pulled ${format}`,
          version: 4,
          issues: [],
        }),
        import: async (_o: string, _l: string, body: Record<string, unknown>) => {
          imports.push(body);
          if (opts.changed === false) return { ...DIFF, changed: false, diff: [], ops: [], issues: [] };
          return body.dryRun ? DIFF : { ...DIFF, applied: true, version: 5 };
        },
      },
    },
  } as unknown as ForumulateClient;
  const deps = {
    client,
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
    env: {},
    ask: opts.ask === undefined ? undefined : async () => opts.ask!,
    files: {
      read: (p: string) => {
        if (!(p in files)) throw new Error(`ENOENT ${p}`);
        return files[p]!;
      },
      write: (p: string, t: string) => void (files[p] = t),
      exists: (p: string) => p in files,
    },
  };
  return { deps, files, out, err, imports };
}

describe('forumulate content types', () => {
  it('writes the generated types for a library named by slug', async () => {
    const h = harness();
    expect(await run(['content', 'types', '--library', 'site', '--out', 'src/forumulate.d.ts'], h.deps)).toBe(0);
    expect(h.files['src/forumulate.d.ts']).toContain('export type PostFields = {');
    expect(h.files['src/forumulate.d.ts']).toContain(`// Content library: ${LIB}`);
    expect(h.out).toEqual(['Wrote src/forumulate.d.ts: 4 collections, 4 globals, 5 block types.']);
  });

  it('--check passes on a current file and fails on a stale one, writing nothing', async () => {
    const h = harness();
    await run(['content', 'types', '--library', 'site'], h.deps);
    const current = h.files['forumulate.d.ts']!;
    expect(await run(['content', 'types', '--library', 'site', '--check'], h.deps)).toBe(0);
    h.files['forumulate.d.ts'] = current.replace('excerpt', 'summary');
    expect(await run(['content', 'types', '--library', 'site', '--check'], h.deps)).toBe(1);
    expect(h.err.at(-1)).toMatch(/out of date/);
    expect(h.files['forumulate.d.ts']).not.toBe(current);
  });

  it('reads a schema file instead of the API when given one', async () => {
    const h = harness({ files: { 'schema.json': JSON.stringify(schema) } });
    expect(await run(['content', 'types', '--schema', 'schema.json'], h.deps)).toBe(0);
    expect(h.files['forumulate.d.ts']).toContain('export type Block = HeroBlock');
  });

  it('says which library is missing instead of guessing', async () => {
    const h = harness();
    expect(await run(['content', 'types', '--library', 'nope'], h.deps)).toBe(1);
    expect(h.err).toEqual(['No content library "nope" in any of your organizations.']);
  });
});

describe('forumulate content pull', () => {
  it('writes the file the API names, in either format', async () => {
    const h = harness();
    expect(await run(['content', 'pull', '--library', 'site'], h.deps)).toBe(0);
    expect(h.files['forumulate.content.json']).toBe('pulled json');
    expect(await run(['content', 'pull', '--library', 'site', '--format', 'payload', '--out', 'cms/model.ts'], h.deps)).toBe(0);
    expect(h.files['cms/model.ts']).toBe('pulled payload');
    expect(h.out).toEqual([
      'Wrote forumulate.content.json from "Acme site" (model version 4).',
      'Wrote cms/model.ts from "Acme site" (model version 4).',
    ]);
  });
});

describe('forumulate content push', () => {
  const file = JSON.stringify({ format: 'forumulate.content', library: { id: LIB }, version: 4, shape: {}, types: {} });

  it('--dry-run shows the exact diff and writes nothing', async () => {
    const h = harness({ files: { 'forumulate.content.json': file } });
    expect(await run(['content', 'push', '--dry-run'], h.deps)).toBe(0);
    expect(h.imports).toEqual([{ format: 'json', content: file, dryRun: true }]);
    expect(h.out).toEqual([
      'forumulate.content.json → "Acme site" (model version 4):',
      '3 changes:',
      '  - post.excerpt  (textarea)',
      '  ~ post.author  maxLength: (none) → 80',
      '  + type author  "Author"',
      'Operations:',
      '  remove post.excerpt  (values hidden, restorable for 30 days)',
      'Not carried over as written (1):',
      '  hook  collections.pages.hooks  `hooks` is code the content model does not run.',
    ]);
  });

  it('applies after a yes, with the declared renames, and never without one', async () => {
    const yes = harness({ files: { 'm.ts': '// forumulate:library ' + LIB + '\nexport default {}' }, ask: 'y' });
    expect(await run(['content', 'push', 'm.ts', '--rename', 'post.headline=title'], yes.deps)).toBe(0);
    expect(yes.imports.map((b) => [b.format, b.dryRun, b.ops])).toEqual([
      ['payload', true, [{ op: 'renameField', type: 'post', from: 'headline', to: 'title' }]],
      ['payload', undefined, [{ op: 'renameField', type: 'post', from: 'headline', to: 'title' }]],
    ]);
    expect(yes.out.at(-1)).toBe('Applied: "Acme site" is at model version 5.');

    const no = harness({ files: { 'forumulate.content.json': file }, ask: 'n' });
    expect(await run(['content', 'push'], no.deps)).toBe(0);
    expect(no.imports).toHaveLength(1);
    expect(no.out.at(-1)).toBe('Nothing applied.');

    // Nobody to ask (CI): --yes or nothing.
    const ci = harness({ files: { 'forumulate.content.json': file } });
    expect(await run(['content', 'push'], ci.deps)).toBe(1);
    expect(ci.imports).toHaveLength(1);
    expect(await run(['content', 'push', '--yes', '--force'], ci.deps)).toBe(0);
    expect(ci.imports.at(-1)).toEqual({ format: 'json', content: file, force: true });
  });

  it('an unchanged file is a no-op: one dry call, nothing applied', async () => {
    const h = harness({ files: { 'forumulate.content.json': file }, changed: false });
    expect(await run(['content', 'push', '--yes'], h.deps)).toBe(0);
    expect(h.imports).toHaveLength(1);
    expect(h.out).toContain('No changes: the file matches the library model.');
  });

  it('warns when the file was pulled at an older version', async () => {
    const stale = JSON.stringify({ format: 'forumulate.content', library: { id: LIB }, version: 2, shape: {}, types: {} });
    const h = harness({ files: { 'forumulate.content.json': stale } });
    await run(['content', 'push', '--dry-run'], h.deps);
    expect(h.err).toEqual(['This file was pulled at version 2; the library is at 4. Pull again, or apply with --force.']);
  });
});

describe('renames and diff lines', () => {
  it('reads every rename spelling', () => {
    expect(
      renameOps([
        '--rename', 'post.seo.title=heading',
        '--rename=block:hero.heading=title',
        '--rename', 'library:subtitle=tagline',
        '--rename', 'post.a.b=a.c',
        '--rename-type', 'post=article',
        '--rename-block', 'cta=banner',
      ]),
    ).toEqual([
      { op: 'renameField', type: 'post', from: 'seo.title', to: 'seo.heading' },
      { op: 'renameField', blockType: 'hero', from: 'heading', to: 'title' },
      { op: 'renameField', from: 'subtitle', to: 'tagline' },
      { op: 'renameField', type: 'post', from: 'a.b', to: 'a.c' },
      { op: 'renameType', from: 'post', to: 'article' },
      { op: 'renameBlockType', from: 'cta', to: 'banner' },
    ]);
    expect(() => renameOps(['--rename', 'nodot=x'])).toThrow(/type>\.<field/);
  });

  it('addresses block and setting lines the way the model does', () => {
    expect(
      diffLines([
        { op: 'change', target: 'blockType', blockType: 'cta', property: 'label', before: 'Call to action', after: 'Banner' },
        { op: 'remove', target: 'blockField', blockType: 'cta', path: 'body', before: 'textarea' },
        { op: 'add', target: 'setting', type: 'post', property: 'titleField', after: 'author' },
        { op: 'change', target: 'field', type: 'site', path: '', property: 'order', before: ['a', 'b'], after: ['b', 'a'] },
      ]),
    ).toEqual([
      '~ block cta  label: "Call to action" → "Banner"',
      '- block cta.body  (textarea)',
      '+ post  setting titleField: (none) → "author"',
      '~ site  order: a, b → b, a',
    ]);
  });
});
