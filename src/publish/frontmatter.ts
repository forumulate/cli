import { parse as parseYaml } from 'yaml';
import type { MetaPatch } from './types';

/**
 * Front matter, read as the YAML it is.
 *
 * The directory publisher this replaces read `key: value` lines and nothing
 * else, so `tags:` written as a list (which is how every static-site generator
 * writes it) arrived as an empty string and a `hero:` block vanished. Four
 * customers wrote their own publishers rather than live with that. A file that
 * is not valid YAML is an error naming the file, not a silently empty map: a
 * page published without the icon its author gave it is a bug nobody reports.
 */
const FRONT = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function splitFront(text: string): {
  data: Record<string, unknown>;
  body: string;
  raw: string | null;
} {
  const m = FRONT.exec(text);
  if (!m) return { data: {}, body: text, raw: null };
  const parsed = parseYaml(m[1] ?? '') as unknown;
  if (
    parsed !== null &&
    parsed !== undefined &&
    (typeof parsed !== 'object' || Array.isArray(parsed))
  )
    throw new Error('front matter is not a map of keys');
  return {
    data: (parsed ?? {}) as Record<string, unknown>,
    body: text.slice(m[0].length),
    raw: m[1] ?? '',
  };
}

/**
 * Put `slug: <slug>` in a file's front matter, replacing one already there.
 *
 * The CLI decides every address before anything is sent and DECLARES it, so
 * the importer cannot disagree with the plan: its own filename rule keeps a
 * `01-` prefix the CLI strips, and a plan that names one address while the
 * write lands at another is the failure a dry run exists to prevent. Only the
 * slug is injected. A title is not — the importer treats a declared title as
 * "the body's heading is not a duplicate" and the page would show it twice.
 */
export function declareSlug(text: string, slug: string): string {
  const m = FRONT.exec(text);
  if (!m) return `---\nslug: ${slug}\n---\n${text}`;
  const lines = (m[1] ?? '').split(/\r?\n/).filter((l) => !/^slug\s*:/i.test(l));
  return `---\n${[...lines, `slug: ${slug}`].join('\n')}\n---\n${text.slice(m[0].length)}`;
}

/** `seo_title`, `seo-title`, `SeoTitle` → `seoTitle`. */
export function camel(key: string): string {
  const parts = key
    .trim()
    .split(/[-_\s]+/)
    .filter(Boolean);
  return parts
    .map((p, i) =>
      i === 0 ? p.charAt(0).toLowerCase() + p.slice(1) : p.charAt(0).toUpperCase() + p.slice(1),
    )
    .join('');
}

/**
 * Every field `PATCH …/pages/{id}/metadata` takes. A front matter key that is
 * one of these (in any casing) is sent as written; the API validates it.
 */
export const PAGE_META_KEYS = [
  'tags',
  'audience',
  'fields',
  'icon',
  'hideFromNav',
  'externalUrl',
  'navTitle',
  'badge',
  'navKind',
  'navFont',
  'searchExclude',
  'coverUrl',
  'layout',
  'hideTitle',
  'subtitle',
  'hideUpdated',
  'hideCover',
  'template',
  'hero',
  'tocLevels',
  'pageChrome',
  'titleAlign',
  'themePatch',
  'onThisPage',
  'apiMethod',
  'apiPage',
  'seoTitle',
  'seoDescription',
  'noindex',
  'contentLanguage',
  'canonicalUrl',
  'hideFeedback',
  'editUrl',
  'sourcePath',
  'pager',
  'hidePager',
  'keywords',
  'commentsEnabled',
  'customCss',
  'theme',
  'shareImageUrl',
  'ogTitle',
  'ogDescription',
  'twitterCard',
  'socialBadge',
  'jsonLd',
] as const;
const META_BY_LOWER = new Map(PAGE_META_KEYS.map((k) => [k.toLowerCase(), k]));

/**
 * The names other tools use for the same idea, so a Docusaurus, Jekyll, Hugo
 * or MkDocs tree publishes without being rewritten first.
 */
const ALIASES: Record<string, string> = {
  description: 'seoDescription',
  summary: 'seoDescription',
  sidebarlabel: 'navTitle',
  navlabel: 'navTitle',
  shorttitle: 'navTitle',
  linktitle: 'navTitle',
  hidden: 'hideFromNav',
  navexclude: 'hideFromNav',
  sidebarhidden: 'hideFromNav',
  image: 'coverUrl',
  cover: 'coverUrl',
  coverimage: 'coverUrl',
  ogimage: 'shareImageUrl',
  socialimage: 'shareImageUrl',
  canonical: 'canonicalUrl',
  lang: 'contentLanguage',
  language: 'contentLanguage',
  toc: 'onThisPage',
};

/** Keys that position a page among its siblings. Read here, never sent. */
export const ORDER_KEYS = ['order', 'sidebarposition', 'navorder', 'weight', 'position'];

/**
 * Keys the importer itself reads (`title`, `slug`, `redirect_from`, `author`,
 * `api`) or that only mean something to the tool a tree came from. Neither is
 * an "unknown key" worth a warning.
 */
const HANDLED = new Set([
  'title',
  'slug',
  'redirectfrom',
  'author',
  'api',
  'openapi',
  'draft',
  'metadata',
  'id',
  'permalink',
  'parent',
  'haschildren',
  'grandparent',
  'sidebarclassname',
  'paginationnext',
  'paginationprev',
  'date',
  'lastmod',
  'authors',
  'type',
  'kind',
  'menu',
  'url',
  'aliases',
  ...ORDER_KEYS,
]);

/** Enumerated fields whose other-tool spellings must not reach the API as a 422. */
const ENUMS: Record<string, readonly string[]> = {
  layout: ['narrow', 'default', 'wide', 'full', 'center', 'custom'],
  template: ['doc', 'splash'],
  titleAlign: ['start', 'center'],
};

/** `a, b` and `[a, b]` and a YAML list all mean the same list. */
function list(v: unknown): string[] | undefined {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string')
    return v
      .replace(/^\[|\]$/g, '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  return undefined;
}

/** A front matter `order`, wherever the tool put it. */
export function declaredOrder(data: Record<string, unknown>): number | undefined {
  for (const [k, v] of Object.entries(data)) {
    if (!ORDER_KEYS.includes(k.toLowerCase().replace(/[-_]/g, ''))) continue;
    const n = typeof v === 'number' ? v : Number(v);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** A front matter `draft: true` — the page is left out, and the plan says so. */
export function isDraft(data: Record<string, unknown>): boolean {
  return data.draft === true || data.draft === 'true';
}

/**
 * Front matter → the metadata patch for a docs page.
 *
 * `fieldKeys` are the parameters the space's type declares (`audience`,
 * `appliesTo`, `deprecated` for docs); those go under `fields`, everything the
 * page model takes goes at the top, `metadata:` is an escape hatch merged as
 * written, and the rest is returned as `unknown` for the plan to name. A key
 * nobody reads, published silently, is how a page ships without the thing its
 * author thought they set.
 */
export function pageMeta(
  data: Record<string, unknown>,
  fieldKeys: string[],
): { meta: MetaPatch; unknown: string[] } {
  const meta: MetaPatch = {};
  const fields: Record<string, unknown> = {};
  const unknown: string[] = [];
  const declared = new Map(fieldKeys.map((k) => [k.toLowerCase(), k]));
  for (const [rawKey, value] of Object.entries(data)) {
    const lower = rawKey.toLowerCase().replace(/[-_\s]/g, '');
    if (lower === 'metadata' && value && typeof value === 'object') {
      Object.assign(meta, value as Record<string, unknown>);
      continue;
    }
    // A declared parameter wins over a same-named page field: `audience:
    // Administrators` is "written for", not the audience gate (an object).
    const field = declared.get(lower);
    if (
      field &&
      field !== 'author' &&
      !(lower === 'audience' && value && typeof value === 'object')
    ) {
      fields[field] = value;
      continue;
    }
    if (HANDLED.has(lower)) continue;
    const key =
      META_BY_LOWER.get(lower) ?? ALIASES[lower] ?? META_BY_LOWER.get(camel(rawKey).toLowerCase());
    if (!key) {
      unknown.push(rawKey);
      continue;
    }
    if (key === 'tags' || key === 'keywords') {
      const l = list(value);
      if (l) meta[key] = l;
      continue;
    }
    const allowed = ENUMS[key];
    if (allowed && !allowed.includes(String(value))) {
      unknown.push(`${rawKey} (${String(value)} is not one of ${allowed.join('/')})`);
      continue;
    }
    if (key === 'onThisPage' && typeof value === 'boolean') {
      meta[key] = value ? 'always' : 'never';
      continue;
    }
    meta[key] = value instanceof Date ? value.toISOString() : value;
  }
  if (Object.keys(fields).length) meta.fields = { ...((meta.fields as object) ?? {}), ...fields };
  return { meta, unknown };
}
