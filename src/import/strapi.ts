/**
 * Strapi: the content-type schemas of a project (`src/api/<name>/content-types/<name>/schema.json`,
 * copied into one folder as `<name>.schema.json`) plus the data as its REST API
 * gives it (`<plural-name>.json`: `{ data: [...] }`, Strapi 5 flat or Strapi 4
 * `{ id, attributes }`), `media.json` for the Media Library, and the files in
 * `uploads/`.
 *
 * Strapi's own `strapi export` archive is encrypted and versioned for
 * restoring into Strapi; this reads what a person can actually produce from a
 * running instance or a repository. Components and dynamic zones carry no
 * schema in these files, so they are imported as JSON and counted in the notes.
 */
import { join } from 'node:path';
import { keyOf, listOf, payloadConfigSource, type PayloadCollection, type PayloadField } from './config';
import { fromHtml, fromMarkdown } from './richtext-html';
import { fromStrapiBlocks } from './richtext-json';
import type { ImportFiles, ImportSource, RawRecord, SourceMedia } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const idOf = (v: unknown): string | null => (typeof v === 'string' || typeof v === 'number' ? String(v) : isObj(v) && (typeof v.id === 'string' || typeof v.id === 'number') ? String(v.id) : null);

/** Strapi 4 wraps a relation/media value in `{ data }` and a record's fields in `attributes`. */
const unwrap = (v: unknown): unknown => (isObj(v) && 'data' in v && Object.keys(v).length <= 2 ? v.data : v);
const flat = (d: Obj): Obj => (isObj(d.attributes) ? { id: d.id, ...d.attributes } : d);

export interface StrapiOptions {
  /** Where relative upload URLs (`/uploads/x.png`) are served from, when the file is not in `uploads/`. */
  baseUrl?: string;
}

export function readStrapiExport(dir: string, files: ImportFiles, opts: StrapiOptions = {}): ImportSource {
  const notes: string[] = [];
  const names = files.list(dir);
  const schemas = names.filter((n) => n.endsWith('.schema.json')).map((n) => JSON.parse(files.read(join(dir, n))) as Obj);

  const singular = (uid: string) => {
    const m = /^api::([^.]+)\.(.+)$/.exec(uid);
    return m ? keyOf(m[2]!) : keyOf(uid);
  };
  const plurals = new Map<string, string>();
  const collections: PayloadCollection[] = [];
  let components = 0;
  for (const s of schemas) {
    const info = isObj(s.info) ? s.info : {};
    if (typeof info.singularName !== 'string') continue;
    const slug = keyOf(info.singularName);
    plurals.set(typeof info.pluralName === 'string' ? info.pluralName : info.singularName, slug);
    plurals.set(info.singularName, slug);
    const fields: PayloadField[] = [];
    for (const [name, a] of Object.entries(isObj(s.attributes) ? s.attributes : {})) {
      if (!isObj(a)) continue;
      const base = { name: keyOf(name), label: name, ...(a.required ? { required: true } : {}) };
      switch (a.type) {
        case 'string':
        case 'uid':
          fields.push({ ...base, type: 'text' });
          break;
        case 'text':
          fields.push({ ...base, type: 'textarea' });
          break;
        case 'email':
          fields.push({ ...base, type: 'email' });
          break;
        case 'enumeration':
          fields.push({ ...base, type: 'select', options: (Array.isArray(a.enum) ? a.enum : []).map(String) });
          break;
        case 'richtext':
        case 'blocks':
          fields.push({ ...base, type: 'richText' });
          break;
        case 'integer':
        case 'biginteger':
        case 'decimal':
        case 'float':
          fields.push({ ...base, type: 'number' });
          break;
        case 'boolean':
          fields.push({ ...base, type: 'checkbox' });
          break;
        case 'date':
        case 'datetime':
          fields.push({ ...base, type: 'date' });
          break;
        case 'media':
          fields.push(a.multiple ? listOf(base.name, { type: 'upload', relationTo: 'media' }, name) : { ...base, type: 'upload', relationTo: 'media' });
          break;
        case 'relation':
          if (typeof a.target === 'string') {
            fields.push({ ...base, type: 'relationship', relationTo: singular(a.target), ...(/ToMany$/.test(String(a.relation)) ? { hasMany: true } : {}) });
          }
          break;
        case 'password':
          break; // A credential is never content.
        case 'component':
        case 'dynamiczone':
          components++;
          fields.push({ ...base, type: 'json' });
          break;
        default:
          fields.push({ ...base, type: 'json' });
      }
    }
    collections.push({ slug, label: typeof info.displayName === 'string' ? info.displayName : undefined, fields });
  }
  if (components) notes.push(`${components} component / dynamic-zone field(s) have no schema in these files and were imported as JSON.`);

  const media: SourceMedia[] = [];
  const mediaIds = new Set<string>();
  const addMedia = (d: Obj) => {
    const id = idOf(d);
    const url = typeof d.url === 'string' ? d.url : '';
    const filename = typeof d.name === 'string' ? d.name : url.split('/').pop() ?? '';
    if (!id || !filename || mediaIds.has(id)) return;
    mediaIds.add(id);
    const local = join(dir, 'uploads', url.split('/').pop() ?? filename);
    const location = files.exists(local) ? local : /^https?:/i.test(url) ? url : opts.baseUrl && url ? opts.baseUrl.replace(/\/$/, '') + url : local;
    media.push({
      id,
      filename,
      location,
      ...(typeof d.alternativeText === 'string' ? { alt: d.alternativeText } : {}),
      ...(typeof d.mime === 'string' ? { contentType: d.mime } : {}),
      aliases: [url].filter(Boolean),
    });
  };
  if (files.exists(join(dir, 'media.json'))) {
    const m = JSON.parse(files.read(join(dir, 'media.json'))) as unknown;
    (Array.isArray(m) ? m : isObj(m) && Array.isArray(m.data) ? m.data : []).filter(isObj).forEach((d) => addMedia(flat(d)));
  }

  const records: RawRecord[] = [];
  for (const n of names) {
    if (!n.endsWith('.json') || n.endsWith('.schema.json') || n === 'media.json') continue;
    const slug = plurals.get(n.slice(0, -5));
    if (!slug) {
      notes.push(`${n} matches no content type schema and was skipped.`);
      continue;
    }
    const parsed: unknown = JSON.parse(files.read(join(dir, n)));
    const list = Array.isArray(parsed) ? parsed : isObj(parsed) && Array.isArray(parsed.data) ? parsed.data : isObj(parsed) && isObj(parsed.data) ? [parsed.data] : [];
    for (const raw of list.filter(isObj)) {
      const d = flat(raw);
      const id = idOf(d);
      if (!id) continue;
      const { id: _id, documentId: _doc, createdAt: _c, updatedAt: _u, publishedAt, locale: _l, createdBy: _cb, updatedBy: _ub, localizations: _loc, ...values } = d;
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) out[keyOf(k)] = unwrap(v);
      records.push({
        type: slug,
        id,
        published: typeof publishedAt === 'string',
        ...(typeof d.slug === 'string' ? { slug: d.slug } : {}),
        ...(typeof d.title === 'string' ? { title: d.title } : {}),
        values: out,
      });
    }
  }
  const scan = (v: unknown, depth = 0): void => {
    if (depth > 40) return;
    if (Array.isArray(v)) return v.forEach((x) => scan(x, depth + 1));
    if (!isObj(v)) return;
    if (typeof v.url === 'string' && typeof v.mime === 'string') addMedia(v);
    Object.values(v).forEach((x) => scan(x, depth + 1));
  };
  records.forEach((r) => scan(r.values));

  return {
    name: 'strapi',
    modelSource: collections.length ? payloadConfigSource(collections) : undefined,
    records,
    media,
    notes,
    richText: (raw, image) =>
      Array.isArray(raw) ? fromStrapiBlocks(raw, image) : typeof raw === 'string' ? (/^\s*<[a-z!]/i.test(raw) ? fromHtml(raw, image) : fromMarkdown(raw, image)) : null,
    mediaId: (raw) => {
      const id = idOf(unwrap(raw));
      return id && mediaIds.has(id) ? id : null;
    },
    refs: (raw) => (Array.isArray(unwrap(raw)) ? (unwrap(raw) as unknown[]) : [unwrap(raw)]).flatMap((v) => {
      const id = idOf(unwrap(v));
      return id ? [{ id }] : [];
    }),
  };
}
