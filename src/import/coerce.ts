/**
 * A record's source values as the values of the model's declared fields.
 *
 * Driven by the field's declared TYPE, never by guessing from the value: a
 * number is an id only where the field is a reference. What a value means
 * (a rich-text document, a file, a pointer) is the importer's to say
 * (`ImportSource`); what the library wants it to look like is decided here, so
 * five platforms produce one shape. Anything that cannot be converted is
 * left out and counted, never stored wrong.
 */
import type { FieldDecl, ImageResolver, ImportSource, RefTarget } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface CoerceCtx {
  source: ImportSource;
  image: ImageResolver;
  /** The library asset id for a source file, uploading it first if needed. */
  asset(sourceId: string): { id: string; filename: string } | null;
  /** The entry id for a source record, or null while it does not exist yet / is not in the export. */
  entry(target: RefTarget): string | null;
  blocks: Map<string, FieldDecl[]>;
  /** `type.field` → values that fitted no declared field or could not be converted. */
  dropped: Map<string, number>;
  /** Set when a reference could not be resolved yet; the engine writes the field again once all entries exist. */
  pendingRef: { value: boolean };
}

const drop = (ctx: CoerceCtx, path: string) => ctx.dropped.set(path, (ctx.dropped.get(path) ?? 0) + 1);

function many<T>(field: FieldDecl, raw: unknown, one: (v: unknown) => T | undefined): T[] | T | undefined {
  if (field.hasMany) {
    const list = (Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [raw]).map(one).filter((x): x is T => x !== undefined);
    return list;
  }
  return one(Array.isArray(raw) ? raw[0] : raw);
}

export function coerceFields(fields: FieldDecl[], raw: Obj, ctx: CoerceCtx, path: string, skip: ReadonlySet<string> = new Set()): Obj {
  const out: Obj = {};
  const known = new Set(fields.map((f) => f.key));
  for (const f of fields) {
    if (skip.has(f.key) || raw[f.key] === undefined || raw[f.key] === null) continue;
    const v = coerceValue(f, raw[f.key], ctx, `${path}.${f.key}`);
    if (v !== undefined && !(Array.isArray(v) && v.length === 0 && f.hasMany)) out[f.key] = v;
  }
  for (const k of Object.keys(raw)) if (!known.has(k) && !skip.has(k) && raw[k] !== undefined && raw[k] !== null) drop(ctx, `${path}.${k}`);
  return out;
}

/**
 * A list of scalars or files is an array of one-field rows in the model. A raw
 * list of strings, ids or file objects is wrapped into those rows; a raw row
 * that already names the field is left as it is.
 */
const WRAPPED = new Set(['media', 'file', 'reference', 'richText', 'json']);

const ISO = /^\d{4}-\d{2}-\d{2}/;

export function coerceValue(f: FieldDecl, raw: unknown, ctx: CoerceCtx, path: string): unknown {
  const bad = () => {
    drop(ctx, path);
    return undefined;
  };
  switch (f.type) {
    case 'text':
    case 'textarea':
    case 'email':
    case 'select':
    case 'multiselect':
    case 'slug':
    case 'color':
    case 'url':
    case 'phone':
      return many(f, raw, (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : undefined)) ?? bad();
    case 'number':
    case 'money':
      return many(f, raw, (v) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined)) ?? bad();
    case 'boolean':
      return typeof raw === 'boolean' ? raw : raw === 'true' ? true : raw === 'false' ? false : bad();
    case 'datetime':
    case 'date': {
      const d = typeof raw === 'string' || typeof raw === 'number' ? new Date(raw) : null;
      if (!d || Number.isNaN(d.getTime())) return bad();
      // A calendar day stays the day the source wrote, not that day in UTC shifted by a zone.
      return f.type === 'date' ? (typeof raw === 'string' && ISO.test(raw) ? raw.slice(0, 10) : d.toISOString().slice(0, 10)) : d.toISOString();
    }
    case 'code':
      if (typeof raw === 'string') return { language: 'text', code: raw };
      return isObj(raw) && typeof raw.code === 'string' ? { language: typeof raw.language === 'string' && raw.language ? raw.language : 'text', code: raw.code } : bad();
    case 'json':
      return raw;
    case 'richText': {
      const doc = ctx.source.richText(raw, ctx.image);
      return doc ?? bad();
    }
    case 'media':
    case 'file': {
      const one = (v: unknown) => {
        const id = ctx.source.mediaId(v);
        const asset = id ? ctx.asset(id) : null;
        if (!asset) return undefined;
        const alt = isObj(v) && typeof v.alt === 'string' ? v.alt : undefined;
        return f.type === 'file' ? { assetId: asset.id, name: asset.filename } : { assetId: asset.id, ...(alt ? { alt } : {}) };
      };
      return many(f, raw, one) ?? bad();
    }
    case 'reference': {
      const targets = ctx.source.refs(raw, f);
      const ids: { kind: 'entry'; id: string }[] = [];
      for (const t of targets) {
        const id = ctx.entry(t);
        if (id) ids.push({ kind: 'entry', id });
        else ctx.pendingRef.value = true;
      }
      if (!targets.length) return bad();
      if (!ids.length) return undefined;
      return f.hasMany ? ids : ids[0];
    }
    case 'group':
      return isObj(raw) ? coerceFields(f.fields ?? [], raw, ctx, path) : bad();
    case 'array': {
      if (!Array.isArray(raw)) return bad();
      const only = f.fields?.length === 1 ? f.fields[0]! : null;
      return raw
        .map((row) => (only && !(isObj(row) && only.key in row) && (!isObj(row) || WRAPPED.has(only.type)) ? { [only.key]: row } : row))
        .filter(isObj)
        .map((row, i) => coerceFields(f.fields ?? [], row, ctx, `${path}[${i}]`, new Set(['id'])));
    }
    case 'blocks': {
      if (!Array.isArray(raw)) return bad();
      const rows: Obj[] = [];
      raw.forEach((row, i) => {
        if (!isObj(row)) return;
        const bt = String(row.blockType ?? row._type ?? '');
        const fields = ctx.blocks.get(bt);
        if (!fields) return void drop(ctx, `${path}[${i}]<${bt || 'unnamed block'}>`);
        rows.push({ blockType: bt, ...coerceFields(fields, row, ctx, `${path}[${i}]<${bt}>`, new Set(['id', 'blockType', 'blockName', '_type', '_key'])) });
      });
      return rows;
    }
    default:
      // seo, link, form… have shapes only the author's model knows; a value already in that shape passes.
      return raw;
  }
}
