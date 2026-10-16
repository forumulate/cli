/**
 * Payload CMS: `payload.config.ts` + a data export.
 *
 * The CONFIG is handed to the API as it is (`format: 'payload'`): the API's
 * Payload reader owns the config-to-model mapping and the list of what it
 * could not map (hooks, access functions, custom components), so this
 * importer neither has a second mapping nor a second opinion about it.
 *
 * The DATA is what Payload's REST/Local API gives for each collection: one
 * `<slug>.json` per collection (an array, or Payload's `{ docs: [...] }`),
 * one `globals/<slug>.json` per global, and `media.json` (or the upload
 * collection's own `<slug>.json`) for uploaded files, whose bytes are in
 * `media/` or at the doc's `url`. Fetched with `depth=0` the relationships
 * are ids; fetched deeper they are documents, and both are understood.
 */
import { join } from 'node:path';
import { fromLexical } from '../richtext-json';
import type { FieldDecl, ImportFiles, ImportSource, RawRecord, RefTarget, SourceMedia } from '../types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : isObj(v) && (typeof v.id === 'string' || typeof v.id === 'number') ? String(v.id) : null);

export interface PayloadOptions {
  /** The config file; omitted when the library's model already exists. */
  configPath?: string;
  /** Upload collections' slugs; defaults to `media`. */
  mediaCollections?: string[];
}

function docsOf(text: string): Obj[] {
  const parsed: unknown = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : isObj(parsed) && Array.isArray(parsed.docs) ? parsed.docs : isObj(parsed) ? [parsed] : [];
  return list.filter(isObj);
}

export function readPayloadExport(dir: string, files: ImportFiles, opts: PayloadOptions = {}): ImportSource {
  const notes: string[] = [];
  const mediaSlugs = new Set(opts.mediaCollections ?? ['media']);
  const modelSource = opts.configPath ? files.read(opts.configPath) : undefined;

  const read = (sub: string, name: string): Obj[] => docsOf(files.read(join(dir, sub, name)));
  const collections = files.list(dir).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5));
  const globals = files.exists(join(dir, 'globals')) ? files.list(join(dir, 'globals')).filter((n) => n.endsWith('.json')).map((n) => n.slice(0, -5)) : [];

  const media: SourceMedia[] = [];
  const mediaIds = new Set<string>();
  const addMedia = (d: Obj): string | null => {
    const id = idOf(d);
    if (!id) return null;
    if (mediaIds.has(id)) return id;
    const filename = typeof d.filename === 'string' ? d.filename : typeof d.url === 'string' ? decodeURIComponent(d.url.split('/').pop() ?? '') : '';
    const url = typeof d.url === 'string' ? d.url : '';
    if (!filename) return null;
    const local = join(dir, 'media', filename);
    const location = files.exists(local) ? local : /^https?:/i.test(url) ? url : local;
    mediaIds.add(id);
    media.push({
      id,
      filename,
      location,
      ...(typeof d.alt === 'string' ? { alt: d.alt } : {}),
      ...(typeof d.mimeType === 'string' ? { contentType: d.mimeType } : {}),
      aliases: [url, `/api/media/file/${filename}`, `/media/${filename}`].filter(Boolean),
    });
    return id;
  };

  const records: RawRecord[] = [];
  const addRecords = (slug: string, docs: Obj[], global: boolean) => {
    docs.forEach((d, i) => {
      const id = global ? slug : idOf(d);
      if (!id) return void notes.push(`${slug}[${i}] has no id and was skipped.`);
      const { id: _id, createdAt: _c, updatedAt: _u, _status, ...values } = d;
      records.push({
        type: slug,
        id,
        // A collection without drafts has no `_status`: everything in it is live.
        published: _status === undefined || _status === 'published',
        ...(typeof d.slug === 'string' ? { slug: d.slug } : {}),
        ...(typeof d.title === 'string' ? { title: d.title } : {}),
        values,
      });
    });
  };
  for (const slug of collections) {
    const docs = read('', `${slug}.json`);
    if (mediaSlugs.has(slug)) docs.forEach(addMedia);
    else addRecords(slug, docs, false);
  }
  for (const slug of globals) addRecords(slug, read('globals', `${slug}.json`), true);
  // Files embedded in a record (fetched with depth > 0, or a Lexical upload node) are media too;
  // they must be known before the engine uploads, so they are found now, not when a field is read.
  const scan = (v: unknown, depth = 0): void => {
    if (depth > 40) return;
    if (Array.isArray(v)) return v.forEach((x) => scan(x, depth + 1));
    if (!isObj(v)) return;
    if (typeof v.filename === 'string' && typeof v.url === 'string' && idOf(v)) addMedia(v);
    for (const x of Object.values(v)) scan(x, depth + 1);
  };
  records.forEach((r) => scan(r.values));
  if (!records.length) notes.push(`No collection data found in ${dir} (expected <collection>.json files).`);

  return {
    name: 'payload',
    modelSource,
    records,
    media,
    notes,
    richText: (raw, image) => fromLexical(raw, image, (v) => media.find((m) => m.id === idOf(v))?.aliases?.[0] ?? null),
    mediaId: (raw) => {
      const id = idOf(raw);
      return id && mediaIds.has(id) ? id : null;
    },
    refs: (raw, field: FieldDecl): RefTarget[] => {
      const only = field.to?.length === 1 && field.to[0]!.types?.length === 1 ? field.to[0]!.types[0] : undefined;
      return (Array.isArray(raw) ? raw : [raw]).flatMap((v): RefTarget[] => {
        // Polymorphic: { relationTo, value } where value is an id or a document.
        if (isObj(v) && typeof v.relationTo === 'string' && 'value' in v) {
          const id = idOf(v.value);
          return id ? [{ type: v.relationTo, id }] : [];
        }
        const id = idOf(v);
        return id ? [{ ...(only ? { type: only } : {}), id }] : [];
      });
    },
  };
}
