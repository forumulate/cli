/**
 * Contentful: the JSON `contentful space export` writes (content types,
 * entries, assets, locales).
 *
 * Content types become collections, entries become records of them, and a
 * `Link` to an asset or entry becomes an upload or relationship. Only the
 * space's default locale becomes the entry; every OTHER locale's values become
 * the entry's locale twins (the engine adds the languages to the library and
 * writes the twins). A Contentful field that is not `localized` has one value
 * for all locales, so it stays on the source entry, as the library's model says.
 */
import { keyOf, listOf, payloadConfigSource, type PayloadCollection, type PayloadField } from './config';
import { fromContentful } from './richtext-json';
import type { ImportSource, RawRecord, SourceMedia } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const sysId = (v: unknown): string | null => (isObj(v) && isObj(v.sys) && typeof v.sys.id === 'string' ? v.sys.id : null);

function fieldOf(f: Obj, name: string, label: string): PayloadField | null {
  const base = { name, label, ...(f.required ? { required: true } : {}), ...(f.localized ? { localized: true } : {}) };
  const link = (spec: Obj): PayloadField => {
    if (spec.linkType === 'Asset') return { ...base, type: 'upload', relationTo: 'media' };
    const allowed = arr(arr(spec.validations).filter(isObj).find((v) => Array.isArray(v.linkContentType))?.linkContentType).map(String);
    return { ...base, type: 'relationship', relationTo: allowed.length ? allowed.map(keyOf) : ['*'] };
  };
  switch (f.type) {
    case 'Symbol': {
      const inList = arr(arr(f.validations).filter(isObj).find((v) => Array.isArray(v.in))?.in).map(String);
      return inList.length ? { ...base, type: 'select', options: inList } : { ...base, type: 'text' };
    }
    case 'Text':
      return { ...base, type: 'textarea' };
    case 'RichText':
      return { ...base, type: 'richText' };
    case 'Integer':
    case 'Number':
      return { ...base, type: 'number' };
    case 'Date':
      return { ...base, type: 'date' };
    case 'Boolean':
      return { ...base, type: 'checkbox' };
    case 'Link':
      return link(f);
    case 'Array': {
      const items = isObj(f.items) ? f.items : {};
      if (items.type === 'Link' && items.linkType === 'Asset') return listOf(name, { type: 'upload', relationTo: 'media' }, label);
      if (items.type === 'Link') return { ...link(items), hasMany: true };
      return listOf(name, { type: 'text' }, label);
    }
    default:
      return { ...base, type: 'json' };
  }
}

export function readContentfulExport(text: string): ImportSource {
  const data: Obj = JSON.parse(text);
  const notes: string[] = [];
  const locales = arr(data.locales).filter(isObj);
  const fallback = locales.find((l) => l.default)?.code;
  const defaultLocale = typeof fallback === 'string' ? fallback : 'en-US';
  const unlocalized = { n: 0 };

  const types = arr(data.contentTypes).filter(isObj);
  const typeKeys = new Map(types.map((t) => [sysId(t) ?? '', keyOf(sysId(t) ?? '')]));
  const fieldKeys = new Map<string, Map<string, string>>();
  const localizedFields = new Map<string, Set<string>>();
  const collections: PayloadCollection[] = [];
  for (const t of types) {
    const id = sysId(t);
    if (!id) continue;
    const keys = new Map<string, string>();
    const fields: PayloadField[] = [];
    for (const f of arr(t.fields).filter(isObj)) {
      if (f.omitted || typeof f.id !== 'string') continue;
      const name = keyOf(f.id);
      keys.set(f.id, name);
      const field = fieldOf(f, name, typeof f.name === 'string' ? f.name : f.id);
      if (field) fields.push(f.localized ? { ...field, localized: true } : field); // lists (listOf) carry no base, so set it here
    }
    fieldKeys.set(id, keys);
    localizedFields.set(id, new Set(arr(t.fields).filter(isObj).filter((f) => f.localized && typeof f.id === 'string').map((f) => String(f.id))));
    collections.push({
      slug: typeKeys.get(id)!,
      label: typeof t.name === 'string' ? t.name : id,
      ...(typeof t.displayField === 'string' && keys.has(t.displayField) ? { titleField: keys.get(t.displayField) } : {}),
      fields,
    });
  }
  // Relationship targets named by content type id become collection slugs; "any type" is every collection.
  const all = collections.map((c) => c.slug);
  const fixTargets = (fs: PayloadField[]) =>
    fs.forEach((f) => {
      if (f.type === 'relationship') f.relationTo = Array.isArray(f.relationTo) && f.relationTo.includes('*') ? all : f.relationTo;
      if (f.relationTo && Array.isArray(f.relationTo) && f.relationTo.length === 1) f.relationTo = f.relationTo[0];
    });
  collections.forEach((c) => fixTargets(c.fields));

  const pick = (localized: unknown): unknown => (isObj(localized) ? (localized[defaultLocale] ?? undefined) : undefined);

  const media: SourceMedia[] = [];
  const assetUrls = new Map<string, { url: string; alt?: string }>();
  for (const a of arr(data.assets).filter(isObj)) {
    const id = sysId(a);
    const fields = isObj(a.fields) ? a.fields : {};
    const file = isObj(pick(fields.file)) ? (pick(fields.file) as Obj) : null;
    if (!id || !file || typeof file.url !== 'string') continue;
    const url = file.url.startsWith('//') ? `https:${file.url}` : file.url;
    const title = pick(fields.title);
    media.push({
      id,
      filename: typeof file.fileName === 'string' ? file.fileName : (url.split('/').pop() ?? id),
      location: url,
      ...(typeof file.contentType === 'string' ? { contentType: file.contentType } : {}),
      ...(typeof title === 'string' ? { alt: title } : {}),
      aliases: [file.url, url],
    });
    assetUrls.set(id, { url, ...(typeof title === 'string' ? { alt: title } : {}) });
  }

  const records: RawRecord[] = [];
  for (const e of arr(data.entries).filter(isObj)) {
    const id = sysId(e);
    const typeId = isObj(e.sys) ? sysId(e.sys.contentType) : null;
    if (!id || !typeId || !typeKeys.has(typeId)) {
      notes.push(`Entry ${id ?? '?'} has a content type that is not in the export and was skipped.`);
      continue;
    }
    const keys = fieldKeys.get(typeId)!;
    const values: Record<string, unknown> = {};
    const twins: Record<string, Record<string, unknown>> = {};
    const fields = isObj(e.fields) ? e.fields : {};
    for (const [fid, loc] of Object.entries(fields)) {
      const v = pick(loc);
      if (v !== undefined && keys.has(fid)) values[keys.get(fid)!] = v;
      if (!isObj(loc) || !keys.has(fid)) continue;
      for (const [code, other] of Object.entries(loc)) {
        if (code === defaultLocale || other === undefined || other === null) continue;
        if (!localizedFields.get(typeId)?.has(fid)) unlocalized.n++;
        else (twins[code] ??= {})[keys.get(fid)!] = other;
      }
    }
    const sys = isObj(e.sys) ? e.sys : {};
    const slugField = ['slug', 'urlSlug'].find((k) => typeof values[k] === 'string');
    records.push({
      type: typeKeys.get(typeId)!,
      id,
      published: typeof sys.publishedVersion === 'number',
      ...(slugField ? { slug: values[slugField] as string } : {}),
      values,
      ...(Object.keys(twins).length ? { locales: twins } : {}),
    });
  }
  if (unlocalized.n) notes.push(`${unlocalized.n} value(s) in other locales sit on fields the export does not mark localized and were not imported.`);

  return {
    name: 'contentful',
    languages: locales.flatMap((l) => (typeof l.code === 'string' ? [{ code: l.code, label: typeof l.name === 'string' ? l.name : l.code, ...(l.code === defaultLocale ? { default: true } : {}) }] : [])),
    modelSource: collections.length ? payloadConfigSource(collections) : undefined,
    records,
    media,
    notes,
    richText: (raw, image) => fromContentful(raw, image, (id) => assetUrls.get(id) ?? null),
    mediaId: (raw) => sysId(raw),
    refs: (raw) => (Array.isArray(raw) ? raw : [raw]).flatMap((v) => {
      const id = sysId(v);
      return id ? [{ id }] : [];
    }),
  };
}
