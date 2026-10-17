/**
 * One translation as one file: Markdown with front matter.
 *
 * `translations pull` writes `<out>/<locale>/<slug>.md` per piece per
 * language, and `push` reads them back. The front matter says what the file
 * IS (space, piece, language) so a file renamed or moved by a TMS still lands
 * on the right piece, and carries the non-body fields (title, a post's
 * summary, an incident's update texts). `source` is a hash of what was
 * written out for a piece nobody had translated yet: a file still carrying
 * those exact words is a stub, and pushing it would publish English under a
 * Spanish address — so it is skipped, not sent.
 */
import { createHash } from 'node:crypto';
import { stringify } from 'yaml';
import { splitFront } from '../publish/frontmatter';

export interface TranslationFile {
  space: string;
  piece: string;
  locale: string;
  door: string;
  title: string;
  markdown: string;
  excerpt?: string;
  updates?: Record<string, string>;
  published?: boolean;
  /** State when pulled (informational). */
  state?: string;
  /** The stub hash, when the file was written from the original (see above). */
  source?: string;
}

export const stubHash = (title: string, markdown: string): string =>
  createHash('sha256').update(`${title}\n${markdown.trim()}`).digest('hex').slice(0, 16);

export function writeTranslationFile(f: TranslationFile): string {
  const front: Record<string, unknown> = {
    forumulate: 'translation',
    space: f.space,
    piece: f.piece,
    door: f.door,
    locale: f.locale,
    title: f.title,
  };
  if (f.excerpt !== undefined && f.excerpt !== null) front.excerpt = f.excerpt;
  if (f.updates && Object.keys(f.updates).length) front.updates = f.updates;
  if (f.published !== undefined) front.published = f.published;
  if (f.state) front.state = f.state;
  if (f.source) front.source = f.source;
  return `---\n${stringify(front).trimEnd()}\n---\n\n${f.markdown.trim()}\n`;
}

/** A pulled file, or null when it is not one of ours (any other Markdown in the folder). */
export function readTranslationFile(text: string): TranslationFile | null {
  const { data, body } = splitFront(text);
  if (data.forumulate !== 'translation') return null;
  const s = (k: string) => (typeof data[k] === 'string' ? (data[k] as string) : '');
  if (!s('piece') || !s('locale')) throw new Error('front matter needs `piece` and `locale`.');
  const updates =
    data.updates && typeof data.updates === 'object' && !Array.isArray(data.updates)
      ? Object.fromEntries(Object.entries(data.updates as Record<string, unknown>).map(([k, v]) => [k, String(v ?? '')]))
      : undefined;
  return {
    space: s('space'),
    piece: s('piece'),
    locale: s('locale'),
    door: s('door'),
    title: s('title'),
    markdown: body.trim(),
    excerpt: typeof data.excerpt === 'string' ? data.excerpt : undefined,
    updates,
    published: typeof data.published === 'boolean' ? data.published : undefined,
    state: s('state') || undefined,
    source: s('source') || undefined,
  };
}

/** A file name a TMS and a filesystem both accept. */
export function fileStem(slug: string | null, id: string): string {
  const clean = (slug ?? '').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return clean || id;
}
