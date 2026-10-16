/**
 * The fields of a content type, read off the library's STORED model.
 *
 * A stored type is a patch over the library-wide shape (`patch.params` is a
 * list patch: `add`, `omit`, `set`, `order`), so the importer, which needs to
 * know what a field IS to convert a value into it, applies the same four
 * verbs. It reads only what a conversion needs (key, type, nesting, targets),
 * and the API remains the judge of the values: an entry that does not fit is
 * refused there, with the field named.
 */
import type { ContentModel } from '@forumulate/sdk';
import type { FieldDecl } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

interface ListPatch {
  add?: Obj[];
  omit?: string[];
  order?: string[];
  set?: Record<string, Obj>;
  unset?: Record<string, string[]>;
}

export function applyListPatch(base: Obj[], patch: unknown): Obj[] {
  if (!isObj(patch)) return base;
  const p = patch as ListPatch;
  let out = base.filter((f) => !p.omit?.includes(String(f.key)));
  out = out.map((f) => {
    const key = String(f.key);
    let next = f;
    const set = p.set?.[key];
    if (set) next = { ...next, ...set };
    const unset = p.unset?.[key];
    if (unset) next = Object.fromEntries(Object.entries(next).filter(([k]) => !unset.includes(k)));
    return next;
  });
  for (const add of p.add ?? []) {
    const at = out.findIndex((f) => f.key === add.key);
    if (at >= 0) out[at] = add;
    else out.push(add);
  }
  if (p.order) {
    const rank = new Map(p.order.map((k, i) => [k, i]));
    out = [...out].sort((a, b) => (rank.get(String(a.key)) ?? 1e9) - (rank.get(String(b.key)) ?? 1e9));
  }
  return out;
}

function decl(f: Obj): FieldDecl {
  const to = Array.isArray(f.to) ? f.to.filter(isObj).map((t) => ({ kind: String(t.kind), types: Array.isArray(t.types) ? t.types.map(String) : undefined })) : undefined;
  return {
    key: String(f.key),
    type: String(f.type),
    ...(f.hasMany ? { hasMany: true } : {}),
    ...(f.localized ? { localized: true } : {}),
    ...(Array.isArray(f.fields) ? { fields: f.fields.filter(isObj).map(decl) } : {}),
    ...(to ? { to } : {}),
  };
}

export interface ResolvedFields {
  fields: FieldDecl[];
  blocks: Map<string, FieldDecl[]>;
  titleField?: string;
}

export function resolveType(model: Pick<ContentModel, 'shape' | 'types'>, typeKey: string): ResolvedFields | null {
  const kind = model.types[typeKey];
  if (!isObj(kind)) return null;
  const patch = isObj(kind.patch) ? kind.patch : {};
  const shape = model.shape;
  const fields = applyListPatch(applyListPatch([], shape.params), patch.params).map(decl);
  const blockList = applyListPatch(applyListPatch([], shape.blockTypes), patch.blockTypes);
  const blocks = new Map<string, FieldDecl[]>();
  for (const b of blockList) blocks.set(String(b.key), Array.isArray(b.fields) ? b.fields.filter(isObj).map(decl) : []);
  const settings = isObj(kind.settings) ? kind.settings : {};
  return { fields, blocks, ...(typeof settings.titleField === 'string' ? { titleField: settings.titleField } : {}) };
}
