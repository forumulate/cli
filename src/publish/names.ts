/**
 * The naming rules a folder is read by: which files are Markdown, what a
 * number prefix means, and the product's slug and tag rules.
 */
export const MD = /\.(md|mdx|markdown)$/i;
/** What a reference may point at to be uploaded rather than linked. */
export const ASSET = /\.(png|jpe?g|gif|webp|svg|avif|ico|pdf|mp4|webm|mp3|zip)$/i;
export const NUMERIC = /^(\d+)[-_. ]+/;
export const DATED = /^(\d{4}-\d{2}-\d{2})[-_]/;
export const BIG = Number.MAX_SAFE_INTEGER;
/** Numbers and separators only: a version (`2-4-0`, `1.10`), never a sort prefix. */
export const VERSION = /^v?\d+(?:[-_.]\d+)+$/i;

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

/** `[n, name]` from a numeric prefix, or "no position" sorted by name. */
export function prefixOrder(name: string): [number, string] {
  const m = NUMERIC.exec(name);
  return [m ? Number(m[1]) : BIG, name.replace(NUMERIC, '').toLowerCase()];
}

/** The title a page will get: front matter, else the leading `# heading` (the importer's rule). */
export function titleOf(front: Record<string, unknown>, body: string, fallback: string): string {
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

