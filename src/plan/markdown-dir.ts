import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, posix, relative, sep } from 'node:path';
import { declaredOrder, isDraft, pageMeta, splitFront } from '../publish/frontmatter';
import { MD, NUMERIC, slugify, titleize } from '../publish/names';
import { assetRefs } from '../publish/scan';
import { rewriteLinks } from '../publish/rewrite';

/**
 * A folder of Markdown → the manifest's `pages` entries (DX-D).
 *
 *     content/about/
 *       index.md            → page `index`
 *       index.es.md         → its Spanish twin       (suffix form)
 *       01-team.md          → page `team`, order 1
 *       guides/setup.md     → page `setup` in the `guides` collection
 *       es/guides/setup.md  → the Spanish twin of guides/setup.md (folder form)
 *
 * Both twin forms are read, because both are what static-site generators
 * write (Hugo and Jekyll put the language in the file name, Docusaurus and
 * MkDocs in a folder) and a customer moving to us should not have to rename a
 * tree to say the same thing. A suffix or a top folder only counts as a
 * language when it is one of the space's declared language codes: `v1.2.md`
 * and a folder called `de` in a German-only space are ordinary names.
 *
 * Front matter, per file: `title`, `slug`, `seoTitle`, `seoDescription`,
 * `canonicalUrl`, `sections` (Markdown per slot), `collection`, `order`, `preset`
 * (the kind of piece), `parentSlug` (the page it nests under), `params` (the kind's
 * parameters), and
 * every page metadata key `forumulate publish` reads (same aliases: `description`
 * is `seoDescription`, `canonical` is `canonicalUrl`, …). A key nothing reads
 * is an error naming the file, not a value silently not published. `draft:
 * true` leaves the file out. Without a `title`, the leading `# heading` is the
 * title and is taken out of the body, as the importer does.
 */

export interface ScannedPage {
  space: string;
  slug: string;
  title: string;
  body?: string;
  sections?: Record<string, string>;
  seoTitle?: string;
  seoDescription?: string;
  canonicalUrl?: string;
  metadata?: Record<string, unknown>;
  collection?: string;
  order?: number;
  /** The kind of piece (`preset:`), the parent page's slug (`parentSlug:`) and the kind's parameters (`params:`) — source pages only. */
  preset?: string | null;
  parent?: string | null;
  params?: Record<string, string | boolean>;
  translations?: Record<
    string,
    Omit<ScannedPage, 'space' | 'collection' | 'order' | 'preset' | 'parent' | 'params' | 'translations' | 'slug'> & { slug?: string }
  >;
}

export interface ScanResult {
  pages: ScannedPage[];
  /** Folders read as collections: slug → name, for the space's `collections` block. */
  collections: Map<string, string>;
  /** Local files the pages point at, by page key (`slug` or `slug@es`): reference → absolute path. */
  assets: Map<string, Map<string, string>>;
  /** Files left out, and why (a draft). */
  skipped: string[];
}

/** Front matter keys this reader consumes itself; the rest go through `pageMeta`. */
const OWN = new Set(['title', 'slug', 'sections', 'collection', 'locale', 'preset', 'parentslug', 'params']);

function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(join(root, rel)).sort()) {
    if (name.startsWith('.') || name.startsWith('_') || name === 'node_modules') continue;
    const r = rel ? `${rel}/${name}` : name;
    if (statSync(join(root, r)).isDirectory()) out.push(...walk(root, r));
    else if (MD.test(name)) out.push(r);
  }
  return out;
}

/** `01-getting-started.es.md` → `{stem: '01-getting-started', locale: 'es'}` when `es` is declared. */
function splitName(file: string, locales: Set<string>): { stem: string; locale: string | null } {
  const stem = basename(file, extname(file));
  const dot = stem.lastIndexOf('.');
  if (dot > 0) {
    const code = stem.slice(dot + 1).toLowerCase();
    if (locales.has(code)) return { stem: stem.slice(0, dot), locale: code };
  }
  return { stem, locale: null };
}

/** The leading `# heading` as a title, removed from the body (the importer's rule). */
function takeTitle(body: string): { title: string | null; body: string } {
  const m = /^\s*#\s+(.+?)\s*#*\s*(?:\r?\n|$)/.exec(body);
  if (!m) return { title: null, body };
  const plain = m[1]!
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, '')
    .trim();
  return { title: plain || null, body: body.slice(m[0].length).replace(/^\s*\n/, '') };
}

interface Parsed {
  file: string;
  key: string;
  locale: string | null;
  collection: string | null;
  /** Whether the front matter named the slug (a twin otherwise keeps its source's). */
  slugDeclared: boolean;
  words: Omit<ScannedPage, 'space' | 'translations'>;
  assets: Map<string, string>;
}

function parseFile(root: string, file: string, locales: Set<string>, defaultCollection?: string): Parsed | 'draft' {
  const abs = join(root, file);
  const text = readFileSync(abs, 'utf8');
  let front: ReturnType<typeof splitFront>;
  try {
    front = splitFront(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  if (isDraft(front.data)) return 'draft';
  // A top folder named after a declared language holds that language's tree.
  const parts = file.split('/');
  let locale: string | null = null;
  if (parts.length > 1 && locales.has(parts[0]!.toLowerCase())) locale = parts.shift()!.toLowerCase();
  const named = splitName(parts[parts.length - 1]!, locales);
  if (named.locale) {
    if (locale && locale !== named.locale)
      throw new Error(`${file}: the folder says ${locale} and the file name says ${named.locale}`);
    locale = named.locale;
  }
  const folder = parts.length > 1 ? parts[0]! : null;
  const data = front.data;
  const lower = Object.fromEntries(Object.entries(data).map(([k, v]) => [k.toLowerCase().replace(/[-_\s]/g, ''), v]));
  const collection =
    typeof lower.collection === 'string' ? lower.collection : folder ? slugify(folder.replace(NUMERIC, ''), 'section') : (defaultCollection ?? null);
  const slug = typeof data.slug === 'string' && data.slug ? data.slug : slugify(named.stem.replace(NUMERIC, ''));
  const prefix = NUMERIC.exec(named.stem);
  const order = declaredOrder(data) ?? (prefix ? Number(prefix[1]) : undefined);

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) if (!OWN.has(k.toLowerCase())) rest[k] = v;
  const { meta, unknown } = pageMeta(rest, []);
  if (unknown.length) throw new Error(`${file}: front matter key(s) nothing reads: ${unknown.join(', ')}`);
  const { seoTitle, seoDescription, canonicalUrl, ...metadata } = meta as Record<string, unknown>;

  let body = front.body;
  let title = typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null;
  if (!title) {
    const t = takeTitle(body);
    title = t.title;
    body = t.body;
  }
  // Lower-cased lookups: front matter keys are case-insensitive here, as `collection` is.
  const own = (name: string): unknown => Object.entries(data).find(([k]) => k.toLowerCase() === name)?.[1];
  const preset = own('preset');
  const parentSlug = own('parentslug');
  const params = own('params');
  if (preset !== undefined && preset !== null && typeof preset !== 'string') throw new Error(`${file}: \`preset\` must be a kind name`);
  if (parentSlug !== undefined && parentSlug !== null && typeof parentSlug !== 'string')
    throw new Error(`${file}: \`parentSlug\` must be the slug of the page this one nests under`);
  if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params)))
    throw new Error(`${file}: \`params\` must be a map of parameter → value`);
  const sections = data.sections;
  if (sections !== undefined && (typeof sections !== 'object' || sections === null || Array.isArray(sections)))
    throw new Error(`${file}: \`sections\` must be a map of slot → Markdown`);
  const words: Parsed['words'] = {
    slug,
    title: title ?? titleize(named.stem),
    ...(body.trim() ? { body } : {}),
    ...(sections ? { sections: Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, String(v ?? '')])) } : {}),
    ...(typeof seoTitle === 'string' ? { seoTitle } : {}),
    ...(typeof seoDescription === 'string' ? { seoDescription } : {}),
    ...(typeof canonicalUrl === 'string' ? { canonicalUrl } : {}),
    ...(Object.keys(metadata).length ? { metadata } : {}),
    ...(order !== undefined ? { order } : {}),
    ...(preset !== undefined ? { preset: preset as string | null } : {}),
    ...(parentSlug !== undefined ? { parent: parentSlug as string | null } : {}),
    ...(params ? { params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, typeof v === 'boolean' ? v : String(v ?? '')])) } : {}),
  };
  // The twin of `guides/setup` is `es/guides/setup` or `guides/setup.es`: one key for both.
  const key = [...parts.slice(0, -1), named.stem].join('/');
  const slugDeclared = typeof data.slug === 'string' && !!data.slug;
  return { file, key, locale, collection, slugDeclared, words, assets: assetRefs(text, dirname(abs), data) };
}

/**
 * Read one directory into page entries for `space`. `locales` are the codes
 * the space publishes in (from the document); `collection` puts every page of
 * the directory into that collection unless a sub-folder or front matter says
 * otherwise.
 */
export function scanMarkdownDir(
  dir: string,
  opts: { space: string; locales?: string[]; collection?: string },
): ScanResult {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`pages: ${dir} is not a directory`);
  const locales = new Set((opts.locales ?? []).map((l) => l.toLowerCase()));
  const sources = new Map<string, Parsed>();
  const twins: Parsed[] = [];
  const skipped: string[] = [];
  for (const file of walk(dir)) {
    const parsed = parseFile(dir, file.split(sep).join(posix.sep), locales, opts.collection);
    if (parsed === 'draft') {
      skipped.push(`${file} (draft)`);
      continue;
    }
    if (parsed.locale) twins.push(parsed);
    else if (sources.has(parsed.key)) throw new Error(`${file}: the same page as ${sources.get(parsed.key)!.file}`);
    else sources.set(parsed.key, parsed);
  }

  // Links between files become links between pages, in the importer's own
  // form — the same rewrite `forumulate publish` does, by the same function.
  const slugByFile = new Map<string, string>();
  for (const p of sources.values()) slugByFile.set(p.file, p.words.slug);
  for (const t of twins)
    slugByFile.set(t.file, t.slugDeclared ? t.words.slug : (sources.get(t.key)?.words.slug ?? t.words.slug));
  const linked = (p: Parsed): Parsed['words'] => ({
    ...p.words,
    ...(p.words.body !== undefined ? { body: rewriteLinks(p.words.body, p.file, slugByFile) } : {}),
    ...(p.words.sections
      ? {
          sections: Object.fromEntries(
            Object.entries(p.words.sections).map(([k, v]) => [k, rewriteLinks(v, p.file, slugByFile)]),
          ),
        }
      : {}),
  });

  const pages = new Map<string, ScannedPage>();
  const collections = new Map<string, string>();
  const assets = new Map<string, Map<string, string>>();
  const slugs = new Map<string, string>();
  for (const p of sources.values()) {
    const prior = slugs.get(p.words.slug);
    if (prior) throw new Error(`${p.file}: slug "${p.words.slug}" is also ${prior}'s`);
    slugs.set(p.words.slug, p.file);
    if (p.collection) collections.set(p.collection, titleize(p.collection));
    pages.set(p.key, {
      space: opts.space,
      ...linked(p),
      ...(p.collection ? { collection: p.collection } : {}),
    });
    if (p.assets.size) assets.set(p.words.slug, p.assets);
  }
  for (const t of twins) {
    const source = pages.get(t.key);
    if (!source) throw new Error(`${t.file}: a ${t.locale} version of a page that does not exist (${t.key})`);
    if (t.words.order !== undefined && t.words.order !== source.order)
      throw new Error(`${t.file}: \`order\` belongs on the source page; a twin follows its place`);
    // A twin keeps the source's address unless its own front matter names one.
    const { order: _o, preset: _p, parent: _pa, params: _pr, slug, ...words } = linked(t);
    source.translations = { ...(source.translations ?? {}), [t.locale!]: t.slugDeclared ? { ...words, slug } : words };
    if (t.assets.size) assets.set(`${source.slug}@${t.locale}`, t.assets);
  }
  return { pages: [...pages.values()], collections, assets, skipped };
}

/** For messages: a path as the user wrote it. */
export function shown(root: string, abs: string): string {
  return relative(root, abs) || '.';
}
