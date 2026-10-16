/**
 * Sanity: the NDJSON `sanity dataset export` writes (`data.ndjson`: one JSON
 * document per line, asset documents included).
 *
 * Sanity keeps its schema in code, not in the export, so the model is
 * INFERRED from the documents: per `_type`, each field's kind comes from the
 * values it holds (a Portable Text array is rich text, an `image` is an
 * upload, a `reference` is a relationship). A field whose values disagree
 * becomes JSON rather than being forced into one kind and losing data. A
 * `drafts.` document whose published twin exists is the twin's pending edit
 * and is not imported twice.
 */
import { keyOf, listOf, payloadConfigSource, type PayloadCollection, type PayloadField } from './config';
import { fromPortableText } from './richtext-json';
import type { ImportSource, RawRecord, SourceMedia } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

type Kind = PayloadField['type'];
interface Seen {
  kinds: Set<string>;
  many: boolean;
  targets: Set<string>;
}

const isPortable = (v: unknown) => Array.isArray(v) && v.length > 0 && v.every((b) => isObj(b) && typeof b._type === 'string' && (b._type === 'block' || b._type === 'image' || b._type === 'code'));
const isImage = (v: unknown) => isObj(v) && isObj(v.asset) && typeof v.asset._ref === 'string' && /^(image|file)-/.test(v.asset._ref);
const isRef = (v: unknown) => isObj(v) && typeof v._ref === 'string' && !('asset' in v);
const DATE = /^\d{4}-\d{2}-\d{2}(T[\d:.+Z-]+)?$/;

function kindOf(v: unknown): string {
  if (typeof v === 'string') return DATE.test(v) ? 'date' : v.length > 160 || v.includes('\n') ? 'textarea' : 'text';
  if (typeof v === 'number') return 'number';
  if (typeof v === 'boolean') return 'checkbox';
  if (isPortable(v)) return 'richText';
  if (isImage(v)) return 'upload';
  if (isRef(v)) return 'relationship';
  return 'json';
}

/** `image-<hash>-<w>x<h>-<ext>` → `<hash>-<w>x<h>.<ext>`, the name Sanity's CDN serves it under. */
export const assetFilename = (ref: string): string => {
  const m = /^(?:image|file)-(.+)-([a-z0-9]+)$/.exec(ref);
  return m ? `${m[1]}.${m[2]}` : ref;
};

export function readSanityExport(ndjson: string, opts: { projectId?: string; dataset?: string } = {}): ImportSource {
  const notes: string[] = [];
  const docs: Obj[] = [];
  ndjson.split(/\r?\n/).forEach((line, i) => {
    if (!line.trim()) return;
    try {
      const d: unknown = JSON.parse(line);
      if (isObj(d) && typeof d._id === 'string' && typeof d._type === 'string') docs.push(d);
    } catch {
      notes.push(`Line ${i + 1} is not JSON and was skipped.`);
    }
  });

  const media: SourceMedia[] = [];
  const assetById = new Map<string, SourceMedia>();
  for (const d of docs) {
    if (d._type !== 'sanity.imageAsset' && d._type !== 'sanity.fileAsset') continue;
    if (typeof d.url !== 'string') continue;
    const m: SourceMedia = {
      id: d._id as string,
      filename: typeof d.originalFilename === 'string' && d.originalFilename ? d.originalFilename : assetFilename(d._id as string),
      location: d.url,
      ...(typeof d.mimeType === 'string' ? { contentType: d.mimeType } : {}),
      aliases: [d.url],
    };
    media.push(m);
    assetById.set(m.id, m);
  }

  const published = new Set(docs.filter((d) => !(d._id as string).startsWith('drafts.')).map((d) => d._id));
  const content = docs.filter((d) => !String(d._type).startsWith('sanity.') && !(String(d._id).startsWith('_.')));
  const live = content.filter((d) => {
    const draft = (d._id as string).startsWith('drafts.');
    return !draft || !published.has((d._id as string).slice(7));
  });
  const typeOfId = new Map(content.map((d) => [(d._id as string).replace(/^drafts\./, ''), keyOf(d._type as string)]));

  // Sanity's `{ _type: 'slug', current }` is plain text here, so the model and the values agree.
  const valuesOf = (d: Obj): [string, unknown][] =>
    Object.entries(d)
      .filter(([k, v]) => !k.startsWith('_') && v !== null && v !== undefined)
      .map(([k, v]) => [k, isObj(v) && v._type === 'slug' && typeof v.current === 'string' ? v.current : v]);

  const seen = new Map<string, Map<string, Seen>>();
  for (const d of live) {
    const slug = keyOf(d._type as string);
    const fields = seen.get(slug) ?? seen.set(slug, new Map()).get(slug)!;
    for (const [k, v] of valuesOf(d)) {
      // An empty list says nothing about what the field holds.
      if (Array.isArray(v) && v.length === 0) continue;
      const entry = fields.get(k) ?? fields.set(k, { kinds: new Set(), many: false, targets: new Set() }).get(k)!;
      const list = Array.isArray(v) && !isPortable(v);
      const items = list ? v : [v];
      entry.many ||= list;
      for (const item of items) {
        entry.kinds.add(list && kindOf(item) === 'textarea' ? 'text' : kindOf(item));
        if (isRef(item)) entry.targets.add(typeOfId.get(String((item as Obj)._ref).replace(/^drafts\./, '')) ?? '');
      }
    }
  }
  const collections: PayloadCollection[] = [...seen].map(([slug, fields]) => ({
    slug,
    fields: [...fields]
      .map(([k, f]): PayloadField => {
        const kind = (f.kinds.size === 1 ? [...f.kinds][0]! : 'json') as Kind;
        const name = keyOf(k);
        if (kind === 'relationship') {
          const to = [...f.targets].filter(Boolean);
          return { name, type: 'relationship', relationTo: to.length === 1 ? to[0]! : to.length ? to : [...seen.keys()], ...(f.many ? { hasMany: true } : {}) };
        }
        if (kind === 'upload') return f.many ? listOf(name, { type: 'upload', relationTo: 'media' }) : { name, type: 'upload', relationTo: 'media' };
        // A list of scalars is a list of one-value rows; a list of anything else is JSON.
        if (f.many && (kind === 'text' || kind === 'number')) return listOf(name, { type: kind });
        if (f.many) return { name, type: 'json' };
        return { name, type: kind };
      }),
  }));

  const records: RawRecord[] = live.map((d) => {
    const id = (d._id as string).replace(/^drafts\./, '');
    const values: Record<string, unknown> = Object.fromEntries(valuesOf(d).map(([k, v]) => [keyOf(k), v]));
    const slugValue = values.slug;
    return {
      type: keyOf(d._type as string),
      id,
      published: !(d._id as string).startsWith('drafts.'),
      ...(typeof slugValue === 'string' ? { slug: slugValue } : {}),
      values,
    };
  });
  if (opts.projectId) notes.push(`Assets are fetched from their cdn.sanity.io URLs (project ${opts.projectId}${opts.dataset ? `, dataset ${opts.dataset}` : ''}).`);

  const assetUrl = (ref: string) => assetById.get(ref)?.location ?? null;
  return {
    name: 'sanity',
    modelSource: collections.length ? payloadConfigSource(collections) : undefined,
    records,
    media,
    notes,
    richText: (raw, image) => fromPortableText(raw, image, assetUrl),
    mediaId: (raw) => {
      const items = Array.isArray(raw) ? raw : [raw];
      const first = items.find(isImage) as Obj | undefined;
      return first ? String((first.asset as Obj)._ref) : null;
    },
    refs: (raw) => (Array.isArray(raw) ? raw : [raw]).flatMap((v) => (isRef(v) ? [{ type: typeOfId.get(String((v as Obj)._ref).replace(/^drafts\./, '')), id: String((v as Obj)._ref).replace(/^drafts\./, '') }] : [])),
  };
}
