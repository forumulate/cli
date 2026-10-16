/**
 * Strapi's own `strapi export --no-encrypt` archive (`.tar.gz`), turned into
 * the folder the REST/schema reader (`./strapi`) already understands, in
 * memory: one reader, so a Strapi export maps the same whichever way it was
 * made.
 *
 * The archive holds JSON lines: `schemas/` (every content type),
 * `entities/` (`{ type, id, data }`), `links/` (relations and media, which
 * Strapi stores OUTSIDE the entity) and `assets/` (`uploads/<file>` bytes).
 * Links are folded back into the entity's own fields here, using the schema to
 * tell a to-many field (a list) from a to-one (one value). Component and
 * dynamic-zone links are not folded; the reader already imports those fields
 * as JSON and says so.
 *
 * An encrypted archive (`.tar.gz.enc`) cannot be read; the error says to export
 * with `--no-encrypt`.
 */
import { readTar } from './tar';
import type { ImportFiles } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const UPLOAD = 'plugin::upload.file';
const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');

export const STRAPI_ARCHIVE_ROOT = '/strapi-archive';
export const isStrapiArchive = (path: string): boolean => /\.(tar\.gz|tgz|tar|tar\.gz\.enc)$/i.test(path);

function jsonl(files: Map<string, Uint8Array>, dir: string): Obj[] {
  const out: Obj[] = [];
  for (const [p, b] of [...files].sort(([a], [z]) => a.localeCompare(z))) {
    if (!p.startsWith(`${dir}/`) || !p.endsWith('.jsonl')) continue;
    for (const line of Buffer.from(b).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      const v: unknown = JSON.parse(line);
      if (isObj(v)) out.push(v);
    }
  }
  return out;
}

/** An in-memory `ImportFiles` laid out the way `readStrapiExport` reads a folder. */
export function strapiArchiveFiles(archive: Uint8Array, archiveName = 'the archive'): ImportFiles {
  if (/\.enc$/i.test(archiveName)) {
    throw new Error(`${archiveName} is encrypted. Export again with \`strapi export --no-encrypt\`.`);
  }
  const raw = readTar(archive);
  // Archives carry no wrapper folder today, but tolerate one: drop a shared first segment.
  const first = new Set([...raw.keys()].map((k) => k.split('/')[0]));
  const strip = first.size === 1 && ![...raw.keys()].some((k) => !k.includes('/')) ? `${[...first][0]}/` : '';
  const tar = new Map([...raw].map(([k, v]) => [strip ? k.slice(strip.length) : k, v]));
  if (!tar.size || ![...tar.keys()].some((k) => k.startsWith('entities/') || k.startsWith('schemas/'))) {
    throw new Error(`${archiveName} is not a Strapi export (no schemas/ or entities/ inside).`);
  }

  const vfs = new Map<string, Uint8Array>();
  const put = (path: string, content: string | Uint8Array) => vfs.set(path, typeof content === 'string' ? new TextEncoder().encode(content) : content);

  const schemas = jsonl(tar, 'schemas').filter((s) => typeof s.uid === 'string');
  const byUid = new Map<string, { plural: string; attrs: Obj }>();
  for (const s of schemas) {
    const info = isObj(s.info) ? s.info : {};
    if (s.modelType === 'component' || typeof info.singularName !== 'string' || !String(s.uid).startsWith('api::')) continue;
    byUid.set(String(s.uid), { plural: typeof info.pluralName === 'string' ? info.pluralName : info.singularName, attrs: isObj(s.attributes) ? s.attributes : {} });
    put(`${info.singularName}.schema.json`, JSON.stringify({ ...s, info }));
  }

  // links → fields. A to-many attribute collects every link; a to-one keeps the first.
  const linked = new Map<string, Map<string, unknown[]>>();
  for (const l of jsonl(tar, 'links')) {
    const left = isObj(l.left) ? l.left : null;
    const right = isObj(l.right) ? l.right : null;
    if (!left || !right || typeof left.field !== 'string' || !byUid.has(String(left.type))) continue;
    const k = `${left.type}\u0000${left.ref}`;
    const fields = linked.get(k) ?? linked.set(k, new Map()).get(k)!;
    (fields.get(left.field) ?? fields.set(left.field, []).get(left.field)!).push({ id: right.ref });
  }
  const many = (attr: unknown) => isObj(attr) && (attr.multiple === true || /ToMany$/.test(String(attr.relation)));

  const rows = new Map<string, Obj[]>();
  const media: Obj[] = [];
  for (const e of jsonl(tar, 'entities')) {
    const data = isObj(e.data) ? e.data : null;
    if (!data) continue;
    const id = e.id ?? data.id;
    if (e.type === UPLOAD) {
      media.push({ ...data, id });
      continue;
    }
    const model = byUid.get(String(e.type));
    if (!model) continue;
    const row: Obj = { ...data, id };
    for (const [field, refs] of linked.get(`${e.type}\u0000${id}`) ?? []) {
      row[field] = many(model.attrs[field]) ? refs : refs[0];
    }
    (rows.get(model.plural) ?? rows.set(model.plural, []).get(model.plural)!).push(row);
  }
  for (const [plural, list] of rows) put(`${plural}.json`, JSON.stringify({ data: list }));
  if (media.length) put('media.json', JSON.stringify({ data: media }));
  for (const [p, b] of tar) if (p.startsWith('assets/uploads/')) put(`uploads/${p.slice('assets/uploads/'.length)}`, b);

  const key = (p: string) => norm(p).replace(new RegExp(`^${STRAPI_ARCHIVE_ROOT}/?`), '');
  const names = (dir: string) => [...vfs.keys()].filter((p) => (dir ? p.startsWith(`${dir}/`) : true)).map((p) => (dir ? p.slice(dir.length + 1) : p)).filter((p) => p && !p.includes('/'));
  return {
    read: (p) => {
      const b = vfs.get(key(p));
      if (!b) throw new Error(`No ${key(p)} in the Strapi archive.`);
      return Buffer.from(b).toString('utf8');
    },
    readBytes: (p) => {
      const b = vfs.get(key(p));
      if (!b) throw new Error(`No ${key(p)} in the Strapi archive.`);
      return b;
    },
    exists: (p) => key(p) === '' || vfs.has(key(p)),
    list: (dir) => names(key(dir)),
    isDir: (p) => key(p) === '' || [...vfs.keys()].some((k) => k.startsWith(`${key(p)}/`)),
  };
}
