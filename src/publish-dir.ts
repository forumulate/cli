import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

/** One markdown file, as the publisher sees it. */
export interface LocalDoc {
  /** Path as given on the command line, for the plan a person reads. */
  path: string;
  /** The slug this file publishes at. */
  slug: string;
  title: string;
  markdown: string;
}

/** What a directory publish would do, before it does any of it. */
export interface PublishPlan {
  create: LocalDoc[];
  update: (LocalDoc & { itemId: string })[];
  /** Published pieces with no file — never touched, only reported. */
  orphans: { slug: string; title: string }[];
}

const FRONT_MATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

/**
 * A file's own front matter, in the small form every static-site generator
 * writes: `key: value` lines, no nesting, no arrays. Anything richer belongs in
 * the page itself, and guessing at YAML we do not support would publish a
 * document whose first paragraph is a parse error.
 */
export function parseFrontMatter(text: string): { data: Record<string, string>; body: string } {
  const m = FRONT_MATTER.exec(text);
  if (!m) return { data: {}, body: text };
  const data: Record<string, string> = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const at = line.indexOf(':');
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key) data[key] = value;
  }
  return { data, body: text.slice(m[0].length) };
}

/** `01-getting-started.md` → `getting-started`; `a/b/c.md` → `a-b-c`. */
export function slugFor(file: string, root: string, front: Record<string, string>): string {
  if (front.slug) return front.slug.trim();
  const rel = relative(root, file).replace(/\.mdx?$/i, '');
  return rel
    .split(sep)
    .map((part) => part.replace(/^\d+[-_]/, ''))
    .join('-')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The first `# heading`, else the front matter's title, else the slug. */
export function titleFor(body: string, front: Record<string, string>, slug: string): string {
  if (front.title) return front.title.trim();
  const heading = /^#\s+(.+)$/m.exec(body);
  return heading?.[1]?.trim() || slug;
}

/** Every `.md`/`.mdx` under a directory, depth-first, in a stable order. */
export function readDocs(root: string): LocalDoc[] {
  const out: LocalDoc[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      if (entry.startsWith('.')) continue;
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      if (!/\.mdx?$/i.test(entry)) continue;
      const raw = readFileSync(path, 'utf8');
      const { data, body } = parseFrontMatter(raw);
      const slug = slugFor(path, root, data);
      out.push({ path, slug, title: titleFor(body, data, slug), markdown: body.trim() });
    }
  };
  walk(root);
  return out;
}

/**
 * What publishing this directory would change, decided against what the space
 * already holds.
 *
 * A file whose slug the space already has is an UPDATE; one it does not is a
 * CREATE; a published piece with no file is an orphan — reported and left
 * alone, because a directory is a source of truth for what it contains and not
 * a statement about what should be deleted.
 */
export function planPublish(
  docs: LocalDoc[],
  existing: { id: string; slug?: string; title: string }[],
): PublishPlan {
  const bySlug = new Map(existing.filter((e) => e.slug).map((e) => [e.slug!, e]));
  const create: LocalDoc[] = [];
  const update: (LocalDoc & { itemId: string })[] = [];
  for (const doc of docs) {
    const match = bySlug.get(doc.slug);
    if (match) update.push({ ...doc, itemId: match.id });
    else create.push(doc);
  }
  const named = new Set(docs.map((d) => d.slug));
  const orphans = existing
    .filter((e) => e.slug && !named.has(e.slug))
    .map((e) => ({ slug: e.slug!, title: e.title }));
  return { create, update, orphans };
}

/** The plan as a person reads it — the whole point of `--dry-run`. */
export function describePlan(plan: PublishPlan, root: string): string[] {
  const lines: string[] = [];
  for (const d of plan.create)
    lines.push(`  create  ${d.slug}   ← ${relative(root, d.path) || d.path}`);
  for (const d of plan.update)
    lines.push(`  update  ${d.slug}   ← ${relative(root, d.path) || d.path}`);
  for (const o of plan.orphans)
    lines.push(`  (left)  ${o.slug}   — published here, no file in this directory`);
  if (lines.length === 0) lines.push('  nothing to do — no .md files found');
  return lines;
}
