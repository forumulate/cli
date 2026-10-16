import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyOf, payloadConfigSource } from './config';
import { readContentfulExport } from './contentful';
import { diskFiles } from './disk';
import { readPayloadExport } from './payload';
import { readSanityExport } from './sanity';
import { readStrapiExport } from './strapi';
import type { ImportFiles, ImportSource } from './types';
import { autop, readWordpressExport } from './wordpress';

const fx = (...p: string[]) => path.join(__dirname, '__fixtures__', ...p);
const read = (...p: string[]) => readFileSync(fx(...p), 'utf8');

/** The disk, plus bytes for the pictures the fixtures name but do not carry. */
const withPictures: ImportFiles = {
  ...diskFiles,
  exists: (p) => /\.(png|jpe?g)$/.test(p) || diskFiles.exists(p),
  readBytes: (p) => (/\.(png|jpe?g)$/.test(p) ? new TextEncoder().encode(`bytes of ${path.basename(p)}`) : diskFiles.readBytes(p)),
};

/**
 * The model each importer asks the API for is a committed fixture too: the
 * API's own test reads these files through its Payload reader, so a source
 * that emits a config the reader cannot map fails THERE, in the API's lane.
 * Regenerate with `UPDATE_IMPORT_FIXTURES=1`.
 */
function pinModel(name: string, source: ImportSource) {
  const file = fx('models', `${name}.payload.txt`);
  if (process.env.UPDATE_IMPORT_FIXTURES) writeFileSync(file, source.modelSource ?? '');
  expect(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).toBe(source.modelSource);
}

describe('config emitter', () => {
  it('keys are stable identifiers', () => {
    expect(keyOf('blog-post')).toBe('blogPost');
    expect(keyOf('Blog Post')).toBe('blogPost');
    expect(keyOf('2fa')).toBe('fa');
    expect(keyOf('!!!')).toBe('field');
  });
  it('emits a literal config', () => {
    const src = payloadConfigSource([{ slug: 'a', titleField: 't', fields: [{ name: 't', type: 'text', required: true }, { name: 'o', type: 'select', options: ['x'] }] }]);
    const json = JSON.parse(src.replace(/^export default /, ''));
    expect(json.collections[0]).toMatchObject({ slug: 'a', admin: { useAsTitle: 't' } });
    expect(json.collections[0].fields[1].options).toEqual([{ label: 'x', value: 'x' }]);
  });
});

describe('Payload export', () => {
  const src = readPayloadExport(fx('payload-website'), withPictures, { configPath: fx('payload-website', 'payload.config.ts.txt') });

  it('reads collections, globals and drafts', () => {
    expect(src.modelSource).toContain('buildConfig');
    const byType = (t: string) => src.records.filter((r) => r.type === t);
    expect(byType('posts').map((r) => [r.id, r.published, r.slug])).toEqual([['10', true, 'first-post'], ['11', false, 'second-post']]);
    expect(byType('categories')).toHaveLength(2);
    expect(byType('header')).toMatchObject([{ id: 'header', published: true }]);
    expect(src.records.some((r) => r.type === 'media')).toBe(false);
  });

  it('finds uploads, including ones only a rich-text node mentions', () => {
    expect(src.media.map((m) => m.filename)).toEqual(['hero.png', 'inline.png']);
    expect(src.media[0]!.location).toBe(fx('payload-website', 'media', 'hero.png'));
    expect(src.media[0]!.aliases).toContain('/api/media/file/hero.png');
  });

  it('understands relationship spellings', () => {
    const f = { key: 'relatedPosts', type: 'reference', hasMany: true, to: [{ kind: 'entry', types: ['posts'] }] };
    expect(src.refs([11, { relationTo: 'categories', value: 3 }, { id: 4 }, null], f)).toEqual([
      { type: 'posts', id: '11' },
      { type: 'categories', id: '3' },
      { type: 'posts', id: '4' },
    ]);
    expect(src.refs(7, { key: 'x', type: 'reference' })).toEqual([{ id: '7' }]);
    expect(src.mediaId(1)).toBe('1');
    expect(src.mediaId(99)).toBeNull();
  });

  it('notes an export with no data', () => {
    const empty = readPayloadExport(fx('models'), diskFiles);
    expect(empty.notes[0]).toMatch(/No collection data/);
  });
});

describe('Contentful export', () => {
  const src = readContentfulExport(read('contentful', 'export.json'));
  it('maps content types to collections and fields to Payload fields', () => {
    pinModel('contentful', src);
    const cfg = JSON.parse(src.modelSource!.replace(/^export default /, ''));
    const post = cfg.collections.find((c: { slug: string }) => c.slug === 'blogPost');
    const types = Object.fromEntries(post.fields.map((f: { name: string; type: string }) => [f.name, f.type]));
    expect(types).toMatchObject({ title: 'text', body: 'richText', summary: 'textarea', views: 'number', publishDate: 'date', heroImage: 'upload', author: 'relationship', tags: 'array', related: 'relationship' });
    expect(types.internalNotes).toBeUndefined();
    expect(post.fields.find((f: { name: string }) => f.name === 'related')).toMatchObject({ hasMany: true, relationTo: 'blogPost' });
    expect(post.admin.useAsTitle).toBe('title');
  });
  it('imports default-locale values, publish state and assets', () => {
    expect(src.records.map((r) => [r.type, r.id, r.published])).toEqual([['person', 'p1', true], ['blogPost', 'b1', true], ['blogPost', 'b2', false]]);
    const b1 = src.records[1]!;
    expect(b1.values.title).toBe('Hello Contentful');
    expect(b1.slug).toBe('hello-contentful');
    expect(src.media.map((m) => [m.id, m.location])).toEqual([['asset1', 'https://images.ctfassets.net/s/asset1/hero.jpg'], ['asset2', 'https://images.ctfassets.net/s/asset2/body.png']]);
    expect(src.notes.join(' ')).toMatch(/1 value\(s\) in other locales sit on fields the export does not mark localized/);
    expect(src.mediaId(b1.values.heroImage)).toBe('asset1');
    expect(src.refs(b1.values.related, { key: 'related', type: 'reference' })).toEqual([{ id: 'b2' }]);
  });
  it('keeps every other locale of a localized field as that entry\'s locale twin', () => {
    expect(src.languages).toEqual([{ code: 'en-US', label: 'en-US', default: true }, { code: 'de', label: 'de' }]);
    expect(src.records[1]!.locales).toEqual({ de: { title: 'Hallo', summary: 'Eine Zusammenfassung' } });
    expect(src.records[0]!.locales).toBeUndefined();
  });
  it('reads rich text with its embedded asset', () => {
    const doc = src.richText(src.records[1]!.values.body, (s) => s)!;
    expect(doc.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'image']);
    expect(doc.content[3]!.attrs!.src).toBe('https://images.ctfassets.net/s/asset2/body.png');
  });
});

describe('Sanity export', () => {
  const src = readSanityExport(read('sanity', 'data.ndjson'));
  it('infers a model from the documents', () => {
    pinModel('sanity', src);
    const cfg = JSON.parse(src.modelSource!.replace(/^export default /, ''));
    const post = cfg.collections.find((c: { slug: string }) => c.slug === 'post');
    const types = Object.fromEntries(post.fields.map((f: { name: string; type: string; hasMany?: boolean }) => [f.name, f.type + (f.hasMany ? '[]' : '')]));
    expect(types).toMatchObject({ title: 'text', slug: 'text', publishedAt: 'date', author: 'relationship', mainImage: 'upload', categories: 'array', related: 'relationship[]', body: 'richText' });
    expect(post.fields.find((f: { name: string }) => f.name === 'author').relationTo).toBe('author');
  });
  it('merges drafts with their published twin and keeps lone drafts as drafts', () => {
    expect(src.records.map((r) => [r.id, r.published])).toEqual([['author-1', true], ['post-1', true], ['post-2', true], ['post-3', false]]);
    expect(src.records.find((r) => r.id === 'post-1')!.slug).toBe('hello-sanity');
  });
  it('uploads asset documents and resolves references and portable text', () => {
    expect(src.media.map((m) => m.filename)).toEqual(['cover.jpg', 'bbb222-400x300.png']);
    const post = src.records.find((r) => r.id === 'post-1')!;
    expect(src.mediaId(post.values.mainImage)).toBe('image-aaa111-800x600-jpg');
    expect(src.refs(post.values.author, { key: 'author', type: 'reference' })).toEqual([{ type: 'author', id: 'author-1' }]);
    const doc = src.richText(post.values.body, (s) => s)!;
    expect(doc.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'image', 'codeBlock']);
  });
});

describe('Strapi export', () => {
  const src = readStrapiExport(fx('strapi'), withPictures);
  it('maps attributes and never imports a password', () => {
    pinModel('strapi', src);
    const cfg = JSON.parse(src.modelSource!.replace(/^export default /, ''));
    const article = cfg.collections.find((c: { slug: string }) => c.slug === 'article');
    const names = article.fields.map((f: { name: string }) => f.name);
    expect(names).not.toContain('secret');
    expect(article.fields.find((f: { name: string }) => f.name === 'gallery')).toMatchObject({ type: 'array', fields: [{ name: 'value', type: 'upload' }] });
    expect(article.fields.find((f: { name: string }) => f.name === 'category')).toMatchObject({ type: 'relationship', relationTo: 'category' });
    expect(article.fields.find((f: { name: string }) => f.name === 'related').hasMany).toBe(true);
    expect(src.notes.join(' ')).toMatch(/1 component/);
  });
  it('reads records, publish state and media from uploads/', () => {
    expect(src.records.map((r) => [r.type, r.id, r.published])).toEqual([['article', '5', true], ['article', '6', false], ['category', '1', true]]);
    expect(src.media.map((m) => m.filename)).toEqual(['cover.png', 'g1.png']);
    expect(src.media[0]!.location).toBe(fx('strapi', 'uploads', 'cover.png'));
    const a = src.records[0]!;
    expect(src.mediaId(a.values.cover)).toBe('7');
    expect(src.refs(a.values.category, { key: 'category', type: 'reference' })).toEqual([{ id: '1' }]);
  });
  it('reads both rich-text forms', () => {
    const a = src.records[0]!;
    expect(src.richText(a.values.body, (s) => s)!.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'orderedList', 'codeBlock', 'image']);
    expect(src.richText(a.values.legacyBody, (s) => s)!.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList']);
  });
  it('reads Strapi 4 attributes and { data } wrappers', () => {
    const files: ImportFiles = {
      ...diskFiles,
      list: (d) => (d === 'v4' ? ['thing.schema.json', 'things.json'] : diskFiles.list(d)),
      read: (p) =>
        p.endsWith('thing.schema.json') ? '{"info":{"singularName":"thing","pluralName":"things"},"attributes":{"name":{"type":"string"}}}'
        : p.endsWith('things.json') ? '{"data":[{"id":1,"attributes":{"name":"A","publishedAt":"2025-01-01T00:00:00Z","owner":{"data":{"id":2}}}}]}'
        : diskFiles.read(p),
      exists: () => false,
    };
    const v4 = readStrapiExport('v4', files);
    expect(v4.records[0]).toMatchObject({ type: 'thing', id: '1', published: true, values: { name: 'A' } });
    expect(v4.refs(v4.records[0]!.values.owner, { key: 'owner', type: 'reference' })).toEqual([{ id: '2' }]);
  });
});

describe('WordPress export', () => {
  const src = readWordpressExport(read('wordpress', 'export.xml'));
  it('has one fixed model per post type found', () => {
    pinModel('wordpress', src);
    const cfg = JSON.parse(src.modelSource!.replace(/^export default /, ''));
    expect(cfg.collections.map((c: { slug: string }) => c.slug)).toEqual(['post', 'page']);
  });
  it('reads posts, pages and attachments, skipping menus and the trash', () => {
    expect(src.records.map((r) => [r.type, r.id, r.published, r.slug])).toEqual([['post', '10', true, 'hello-world'], ['page', '11', false, 'about']]);
    expect(src.records[0]!.values).toMatchObject({ title: 'Hello world & welcome', author: 'admin', categories: ['News'], tags: ['intro'], featuredImage: '20', publishedAt: '2025-06-01T12:00:00Z' });
    expect(src.records[1]!.values.publishedAt).toBe('2025-06-02T08:00:00Z');
    expect(src.media).toMatchObject([{ id: '20', filename: 'pic.jpg', alt: 'Pic alt', location: 'https://blog.test/wp-content/uploads/2025/pic.jpg' }]);
    expect(src.notes.join(' ')).toMatch(/nav_menu_item/);
    expect(src.notes.join(' ')).toMatch(/post item\(s\)/);
  });
  it('turns the body into blocks, resolving pictures through the media aliases', () => {
    const doc = src.richText(src.records[0]!.values.body, (s) => s)!;
    expect(doc.content.map((n) => n.type)).toEqual(['paragraph', 'heading', 'bulletList', 'image', 'codeBlock']);
    expect(doc.content[3]!.attrs).toMatchObject({ caption: 'A caption', alt: 'Pic' });
    expect(JSON.stringify(doc)).not.toContain('alert');
    expect(src.mediaId('20')).toBe('20');
  });
  it('adds paragraphs to WordPress plain-text bodies', () => {
    expect(autop('A\n\nB\nC')).toBe('<p>A</p>\n<p>B<br>C</p>');
    expect(autop('<p>x</p>')).toBe('<p>x</p>');
    const doc = src.richText(src.records[1]!.values.body, (s) => s)!;
    expect(doc.content).toHaveLength(2);
  });
});
