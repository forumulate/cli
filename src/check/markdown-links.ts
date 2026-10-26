/**
 * Links and anchors in a Markdown file, read the way the product reads them —
 * for `forumulate check links` on a folder (FMU-F05), before anything is
 * published.
 *
 * This package ships alone (it depends on the SDK and `yaml`, nothing else), so
 * the heading rule is mirrored here rather than imported, the way `names.ts`
 * mirrors the slug rule: `headingSlug` below is the docs-schema's
 * `headingSlug` (packages/docs-schema/src/heading-slug.ts), and
 * `markdown-links.test.ts` pins the same cases that file's tests do. A checker
 * whose anchors differ from the renderer's would report working links broken.
 */

/**
 * The accent fold the product applies before an anchor (packages/shared
 * accent-fold): NFD, the Combining Diacritical Marks block dropped — not a
 * Japanese dakuten, which is part of its letter — then NFC.
 */
function foldAccents(s: string): string {
  return s.normalize('NFC').normalize('NFD').replace(/[̀-ͯ]/g, '').normalize('NFC');
}

/** A heading's anchor id from its text — the renderer's rule. */
export function headingSlug(text: string): string {
  return (
    foldAccents(text)
      .toLowerCase()
      .trim()
      .replace(/[^\p{Letter}\p{Number}_\s-]/gu, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 80) || 'section'
  );
}

/** The id the renderer used before the accent fix, still answered as an alias. */
export function legacyHeadingSlug(text: string): string | null {
  const old = text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80);
  return old && old !== '-' && old !== headingSlug(text) ? old : null;
}

/**
 * "Is this line inside a fenced code block?" — a MIRROR of the docs-schema's
 * `FenceTracker` (packages/docs-schema/src/markdown-fence-scan.ts), for the
 * same reason `headingSlug` above is one: this package cannot import it. The
 * CommonMark rule, as the renderer follows it: a run of 3+ backticks or tildes
 * opens (a backtick fence's info string holds no backtick), and only a bare run
 * of the SAME character at least as long closes — so a ````markdown example
 * holding a ```ts fence is not closed by the inner ``` and its links stay code.
 * `step` is true for the opening line, the body and the closing line.
 */
class FenceTracker {
  private open: { char: string; length: number } | null = null;

  step(line: string): boolean {
    if (this.open) {
      const c = /^[ \t]*(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (c && c[1]![0] === this.open.char && c[1]!.length >= this.open.length) this.open = null;
      return true;
    }
    const o = /^[ \t]*(`{3,}|~{3,})(.*)$/.exec(line);
    if (!o || (o[1]![0] === '`' && o[2]!.includes('`'))) return false;
    this.open = { char: o[1]![0]!, length: o[1]!.length };
    return true;
  }
}

/** A link as written, and the line it is on (1-based, in the file). */
export interface FoundLink {
  href: string;
  line: number;
  /** An image or embedded file, rather than a link a reader follows. */
  media: boolean;
}

/** Inline Markdown down to the words a heading's id is made from. */
function headingWords(raw: string): string {
  return raw
    .replace(/\s*\{#[^}]+\}\s*$/, '')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
    .replace(/\s+#+\s*$/, '')
    .trim();
}

/** Strip front matter, keeping the line count so reported lines stay right. */
function bodyLines(text: string): { lines: string[]; offset: number } {
  const all = text.split(/\r?\n/);
  if (all[0]?.replace(/^﻿/, '') === '---') {
    const end = all.indexOf('---', 1);
    if (end > 0) return { lines: all.slice(end + 1), offset: end + 1 };
  }
  return { lines: all, offset: 0 };
}

/**
 * Every `#fragment` the page will answer to: each heading's id (duplicates
 * suffixed `-2`, `-3`, as the renderer claims them), its pre-fix alias, an
 * explicit `{#id}` on a heading, and any `id="…"` / `name="…"` in HTML.
 * `title` drops a leading `# Title` that repeats the page title, which the
 * renderer does not render as a heading either.
 */
export function markdownAnchors(text: string, title?: string): Set<string> {
  const out = new Set<string>();
  const taken = new Set<string>();
  const claim = (base: string) => {
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    taken.add(id);
    out.add(id);
  };
  const { lines } = bodyLines(text);
  const fences = new FenceTracker();
  let first = true;
  for (const line of lines) {
    if (fences.step(line)) continue;
    for (const m of line.matchAll(/\b(?:id|name)\s*=\s*["']([^"']+)["']/g)) out.add(m[1]!);
    const h = /^\s{0,3}(#{1,6})\s+(.*)$/.exec(line);
    if (!h) continue;
    const explicit = /\{#([^}\s]+)\}\s*$/.exec(h[2]!);
    const words = headingWords(h[2]!);
    if (first && title && h[1] === '#' && words.trim() === title.trim()) {
      first = false;
      continue;
    }
    first = false;
    if (explicit) {
      taken.add(explicit[1]!);
      out.add(explicit[1]!);
      continue;
    }
    claim(headingSlug(words));
    const legacy = legacyHeadingSlug(words);
    if (legacy) out.add(legacy);
  }
  return out;
}

/**
 * Every link and picture in the file: `[t](href)`, `![a](src)`, reference
 * definitions `[id]: href`, and HTML `href=` / `src=` — not inside a code
 * fence or an inline code span, where a URL is an example, not a link.
 */
export function markdownLinks(text: string): FoundLink[] {
  const out: FoundLink[] = [];
  const { lines, offset } = bodyLines(text);
  const fences = new FenceTracker();
  lines.forEach((raw, i) => {
    if (fences.step(raw)) return;
    const line = raw.replace(/`[^`]*`/g, (m) => ' '.repeat(m.length));
    const at = i + 1 + offset;
    for (const m of line.matchAll(/(!?)\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+["'][^"']*["'])?\s*\)/g))
      out.push({ href: m[2]!, line: at, media: m[1] === '!' });
    const def = /^\s{0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+["'(].*)?$/.exec(line);
    if (def) out.push({ href: def[1]!, line: at, media: false });
    for (const m of line.matchAll(/\b(href|src)\s*=\s*["']([^"']+)["']/g))
      out.push({ href: m[2]!, line: at, media: m[1] === 'src' });
  });
  return out;
}
