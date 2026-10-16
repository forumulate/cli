import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, posix, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { declaredOrder, isDraft, pageMeta, splitFront } from './frontmatter';
import type { LocalCollection, LocalPage, LocalSpace, SpaceSpec } from './types';

/**
 * A folder on disk, read into what it would publish.
 *
 * Docs: one top-level folder per collection, files at the root in the root
 * collection, nested folders as parent pages (the folder's `index.md` or
 * `README.md` is the parent; a folder without one gets a title-only stub so its
 * children still have somewhere to hang). Everything else — blog, changelog,
 * any type whose pieces are posts — is a flat set of posts, folders or not.
 */

const MD = /\.(md|mdx|markdown)$/i;
/** What a reference may point at to be uploaded rather than linked. */
const ASSET = /\.(png|jpe?g|gif|webp|svg|avif|ico|pdf|mp4|webm|mp3|zip)$/i;
export const MANIFEST_NAMES = ['forumulate.yaml', 'forumulate.yml', 'forumulate.json'];
const NUMERIC = /^(\d+)[-_. ]+/;
const DATED = /^(\d{4}-\d{2}-\d{2})[-_]/;
const BIG = Number.MAX_SAFE_INTEGER;

/** The product's slug rule (packages/shared `slugify`), mirrored: this package ships alone. */
export function slugify(input: string, fallback = 'page', max = 70): string {
  return (
    input
      .normalize('NFC')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .normalize('NFC')
      .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, max)
      .replace(/-+$/, '') || fallback
  );
}

/**
 * The product's TAG rule (apps/api `normalizeTag`), mirrored for the same reason
 * as `slugify`. Used to compare a front-matter tag list with the stored one: an
 * ASCII-only fold here turned every Japanese or Cyrillic tag into `-`, so two
 * different non-Latin tag lists compared equal and the update was skipped.
 */
export function tagKey(raw: string): string {
  const t = String(raw ?? '')
    .normalize('NFC')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .normalize('NFC')
    .replace(/[^\p{Letter}\p{Number}+#.-]+/gu, '-')
    .replace(/^[-#]+/, '')
    .replace(/^\.+(?![\p{Letter}\p{Number}])/u, '')
    .replace(/^[-#]+/, '')
    .replace(/[-.]+$/, '');
  if (!/[\p{Letter}\p{Number}]/u.test(t)) return '';
  return t.slice(0, 60).replace(/[-.]+$/, '');
}

/** `02-getting-started` → `Getting Started`. */
export function titleize(name: string): string {
  const bare = name.replace(NUMERIC, '').replace(/[-_]+/g, ' ').trim();
  return bare.replace(/\b\p{Letter}/gu, (c) => c.toUpperCase()) || name;
}

const isIndex = (file: string) => /^(index|readme)\.(md|mdx|markdown)$/i.test(basename(file));
const skipEntry = (name: string) =>
  name.startsWith('.') ||
  name.startsWith('_') ||
  name === 'node_modules' ||
  MANIFEST_NAMES.includes(name);

/** `[n, name]` from a numeric prefix, or "no position" sorted by name. */
function prefixOrder(name: string): [number, string] {
  const m = NUMERIC.exec(name);
  return [m ? Number(m[1]) : BIG, name.replace(NUMERIC, '').toLowerCase()];
}

function hasMarkdown(dir: string): boolean {
  for (const e of readdirSync(dir)) {
    if (skipEntry(e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory() ? hasMarkdown(p) : MD.test(e)) return true;
  }
  return false;
}

/** `_collection.yml` / `.yaml` / `.json` beside a collection's files. */
function folderMeta(dir: string): Record<string, unknown> {
  for (const n of ['_collection.yml', '_collection.yaml', '_collection.json']) {
    const p = join(dir, n);
    if (existsSync(p)) return (parseYaml(readFileSync(p, 'utf8')) ?? {}) as Record<string, unknown>;
  }
  return {};
}

/** The title a page will get: front matter, else the leading `# heading` (the importer's rule). */
function titleOf(front: Record<string, unknown>, body: string, fallback: string): string {
  if (typeof front.title === 'string' && front.title.trim()) return front.title.trim();
  const first = body.split(/\r?\n/).find((l) => l.trim());
  const h1 = first && /^#\s+(.+?)\s*#*\s*$/.exec(first);
  // A title is stored as plain text: the importer keeps the heading's words and
  // drops its marks, so `` `required` `` comes back as `required`.
  const plain = h1?.[1]
    ?.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim();
  return plain || fallback;
}

/** Local files a document points at — images, PDFs — resolved from its own folder. */
function assetRefs(
  text: string,
  fileDir: string,
  front: Record<string, unknown>,
): Map<string, string> {
  const refs = new Map<string, string>();
  const consider = (ref: string) => {
    const clean = ref.trim().replace(/^<|>$/g, '').split(/[?#]/)[0]!;
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/') || !ASSET.test(clean))
      return;
    const abs = resolve(fileDir, decodeURI(clean));
    if (existsSync(abs) && statSync(abs).isFile()) refs.set(ref.trim(), abs);
  };
  for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g)) consider(m[1]!);
  for (const m of text.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/g)) consider(m[1]!);
  const walk = (v: unknown) => {
    if (typeof v === 'string') consider(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(front);
  return refs;
}

export interface ScanResult extends LocalSpace {
  /** Per file (relative to the space folder): reference as written → absolute asset path. */
  refs: Map<string, Map<string, string>>;
  /** Every Markdown file of the space (relative to the space folder) → its slug. */
  slugByFile: Map<string, string>;
}

/** Read one space folder. `kind` decides whether its files are pages or posts. */
export function scanSpace(
  root: string,
  spec: SpaceSpec,
  kind: 'docs' | 'posts',
  fieldKeys: string[],
): ScanResult {
  const absDir = resolve(root, spec.path || '.');
  const out: ScanResult = {
    dir: spec.path || '',
    absDir,
    collections: [],
    posts: [],
    assets: new Set(),
    warnings: [],
    refs: new Map(),
    slugByFile: new Map(),
  };
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    out.warnings.push(`${absDir} is not a folder`);
    return out;
  }
  const read = (abs: string) => {
    const text = readFileSync(abs, 'utf8');
    const rel = relative(absDir, abs).split(sep).join('/');
    try {
      const { data, body } = splitFront(text);
      const refs = assetRefs(text, dirname(abs), data);
      if (refs.size) out.refs.set(rel, refs);
      for (const a of refs.values()) out.assets.add(a);
      return { rel, text, data, body };
    } catch (e) {
      throw new Error(`${rel}: ${(e as Error).message}`);
    }
  };
  if (kind === 'posts') scanPosts(absDir, out, read);
  else scanDocs(absDir, spec, out, read, fieldKeys);
  return out;
}

type Reader = (abs: string) => {
  rel: string;
  text: string;
  data: Record<string, unknown>;
  body: string;
};

function scanPosts(absDir: string, out: ScanResult, read: Reader): void {
  const walk = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      if (skipEntry(e)) continue;
      const abs = join(dir, e);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!MD.test(e)) continue;
      // A README at the top of a blog folder is a note about the folder.
      if (dir === absDir && /^readme\./i.test(e)) {
        out.warnings.push(
          `${e}: skipped — a README at the top of a posts folder is a note, not a post`,
        );
        continue;
      }
      const f = read(abs);
      if (isDraft(f.data)) {
        out.warnings.push(`${f.rel}: draft — left out`);
        continue;
      }
      const stem = e.replace(MD, '');
      const dated = DATED.exec(stem);
      const front = { ...f.data };
      if (dated && front.publishedAt === undefined && front.date === undefined)
        front.publishedAt = dated[1];
      if (front.date !== undefined && front.publishedAt === undefined)
        front.publishedAt = front.date;
      const slug =
        typeof f.data.slug === 'string' && f.data.slug.trim()
          ? slugify(f.data.slug)
          : slugify(stem.replace(DATED, '').replace(NUMERIC, ''));
      out.slugByFile.set(f.rel, slug);
      out.posts.push({
        file: f.rel,
        slug,
        title: titleOf(f.data, f.body, slug),
        source: f.text,
        body: f.body,
        front,
      });
    }
  };
  walk(absDir);
}

function scanDocs(
  absDir: string,
  spec: SpaceSpec,
  out: ScanResult,
  read: Reader,
  fieldKeys: string[],
): void {
  const rootName = spec.rootCollection ?? '';
  const rootFiles: string[] = [];
  const folders: string[] = [];
  for (const e of readdirSync(absDir).sort()) {
    if (skipEntry(e)) continue;
    const abs = join(absDir, e);
    if (statSync(abs).isDirectory()) {
      if (hasMarkdown(abs)) folders.push(e);
    } else if (MD.test(e)) rootFiles.push(e);
  }
  if (rootFiles.length) {
    out.collections.push(
      collectionOf(
        absDir,
        '',
        rootName ? slugify(rootName) : '',
        rootName,
        [-1, ''],
        {},
        out,
        read,
        fieldKeys,
        rootFiles,
      ),
    );
  }
  for (const name of folders) {
    const abs = join(absDir, name);
    const declared = { ...folderMeta(abs), ...(spec.collections?.[name] ?? {}) };
    const [n, key] = prefixOrder(name);
    const order: [number, string] = [typeof declared.order === 'number' ? declared.order : n, key];
    const slug =
      typeof declared.slug === 'string'
        ? slugify(declared.slug)
        : slugify(name.replace(NUMERIC, ''));
    const title = typeof declared.name === 'string' ? declared.name : titleize(name);
    out.collections.push(
      collectionOf(
        abs,
        name,
        slug,
        title,
        order,
        (declared.nav ?? undefined) as Record<string, unknown>,
        out,
        read,
        fieldKeys,
      ),
    );
  }
  out.collections.sort((a, b) => a.order[0] - b.order[0] || a.order[1].localeCompare(b.order[1]));
}

function collectionOf(
  abs: string,
  dir: string,
  slug: string,
  name: string,
  order: [number, string],
  nav: Record<string, unknown> | undefined,
  out: ScanResult,
  read: Reader,
  fieldKeys: string[],
  onlyFiles?: string[],
): LocalCollection {
  const col: LocalCollection = { dir, slug, name, order, nav, pages: [] };
  /**
   * Walk one folder. `own` is the page that stands for this folder (its files
   * nest under it; null at the collection's top) and `above` is the page that
   * one nests under — which is where the folder's own index file hangs.
   */
  const walk = (folder: string, rel: string, own: string | null, above: string | null) => {
    const entries = (onlyFiles ?? readdirSync(folder).sort()).filter((e) => !skipEntry(e));
    const files = entries.filter((e) => MD.test(e) && !statSync(join(folder, e)).isDirectory());
    const dirs = onlyFiles
      ? []
      : entries.filter(
          (e) => statSync(join(folder, e)).isDirectory() && hasMarkdown(join(folder, e)),
        );
    const index = rel ? files.find(isIndex) : undefined;
    for (const f of files) {
      const parentSlug = f === index ? above : own;
      const page = pageOf(
        join(folder, f),
        rel ? `${rel}/${f}` : f,
        rel,
        f === index,
        parentSlug,
        slug,
        out,
        read,
        fieldKeys,
      );
      if (page) col.pages.push(page);
    }
    for (const d of dirs) {
      const sub = join(folder, d);
      const subRel = rel ? `${rel}/${d}` : d;
      const subFiles = readdirSync(sub).filter((e) => !skipEntry(e) && MD.test(e));
      const subIndex = subFiles.find(isIndex);
      let folderSlug: string;
      if (subIndex) {
        // The index decides the folder page's address; read it once for that.
        const { data } = splitFront(readFileSync(join(sub, subIndex), 'utf8'));
        folderSlug =
          typeof data.slug === 'string' && data.slug.trim()
            ? slugify(data.slug)
            : slugify(d.replace(NUMERIC, ''));
      } else {
        folderSlug = slugify(d.replace(NUMERIC, ''));
        const title = titleize(d);
        col.pages.push({
          file: `${relative(out.absDir, sub).split(sep).join('/')}/ (no index.md)`,
          importName: `${subRel}/index.md`,
          slug: folderSlug,
          parentSlug: own,
          order: prefixOrder(d),
          title,
          source: `---\ntitle: ${JSON.stringify(title)}\nslug: ${folderSlug}\n---\n`,
          body: '',
          meta: {},
          unknown: [],
          stub: true,
        });
      }
      walk(sub, subRel, folderSlug, own);
    }
  };
  walk(abs, '', null, null);
  return col;
}

function pageOf(
  abs: string,
  importName: string,
  rel: string,
  isFolderIndex: boolean,
  parentSlug: string | null,
  collectionSlug: string,
  out: ScanResult,
  read: Reader,
  fieldKeys: string[],
): LocalPage | null {
  const f = read(abs);
  if (isDraft(f.data)) {
    out.warnings.push(`${f.rel}: draft — left out`);
    return null;
  }
  const name = basename(abs);
  const stem = name.replace(MD, '');
  const declaredSlug =
    typeof f.data.slug === 'string' && f.data.slug.trim() ? slugify(f.data.slug) : '';
  const folder = posix.basename(rel);
  const atCollectionTop = isIndex(name) && !rel;
  const slug =
    declaredSlug ||
    (isFolderIndex
      ? slugify(folder.replace(NUMERIC, ''))
      : atCollectionTop
        ? collectionSlug || slugify(titleOf(f.data, f.body, 'overview'))
        : slugify(stem.replace(NUMERIC, '')));
  const { meta, unknown } = pageMeta(f.data, fieldKeys);
  const n = declaredOrder(f.data);
  const [prefixN, key] = prefixOrder(isFolderIndex ? folder : stem);
  // A folder's index is ordered among the folder's siblings, by the folder's
  // prefix; a collection's own index leads it unless it says otherwise.
  const order: [number, string] = [n ?? (atCollectionTop ? -1 : prefixN), key];
  out.slugByFile.set(f.rel, slug);
  return {
    file: f.rel,
    importName,
    slug,
    parentSlug,
    order,
    title: titleOf(f.data, f.body, slug),
    source: f.text,
    body: f.body,
    meta,
    unknown,
  };
}

/** Every relative path → posix, for comparing with `importName`s. */
export const toPosix = (p: string) => p.split(sep).join('/');
export const extOf = (p: string) => extname(p).toLowerCase();
