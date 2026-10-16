/**
 * WordPress: the WXR file `Tools → Export` writes (`.xml`, "All content").
 *
 * Posts, pages and any custom post type become collections (attachments are
 * media, menus and revisions are not content), with the same fields on each:
 * title, body (rich text from the HTML), excerpt, date, author, categories,
 * tags and the featured image. WordPress has no per-type schema in the
 * export, so there is no schema to map; the model is this fixed one, which
 * is what a post IS in WordPress.
 */
import { keyOf, listOf, payloadConfigSource, type PayloadCollection } from './config';
import { decodeEntities, fromHtml } from './richtext-html';
import type { ImportSource, RawRecord, SourceMedia } from './types';

interface Item {
  tags: Map<string, string>;
  meta: Map<string, string>;
  cats: { domain: string; value: string }[];
}

/** CDATA is literal text; anything outside it has its entities decoded. */
const cdata = (s: string) => {
  const m = /^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/.exec(s);
  return m ? m[1]! : decodeEntities(s);
};

export function parseWxr(xml: string): Item[] {
  const items: Item[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    let body = m[1]!;
    const meta = new Map<string, string>();
    body = body.replace(/<wp:postmeta>([\s\S]*?)<\/wp:postmeta>/g, (_x, inner: string) => {
      const k = /<wp:meta_key>([\s\S]*?)<\/wp:meta_key>/.exec(inner)?.[1];
      const v = /<wp:meta_value>([\s\S]*?)<\/wp:meta_value>/.exec(inner)?.[1];
      if (k !== undefined) meta.set(cdata(k), cdata(v ?? ''));
      return '';
    });
    const cats: Item['cats'] = [];
    body = body.replace(/<category\b([^>]*)>([\s\S]*?)<\/category>/g, (_x, attrs: string, text: string) => {
      cats.push({ domain: /domain="([^"]*)"/.exec(attrs)?.[1] ?? 'category', value: cdata(text) });
      return '';
    });
    const tags = new Map<string, string>();
    for (const t of body.matchAll(/<([A-Za-z][\w:-]*)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/g)) if (!tags.has(t[1]!)) tags.set(t[1]!, cdata(t[2]!));
    items.push({ tags, meta, cats });
  }
  return items;
}

/** WordPress stores paragraphs as blank-line-separated text and adds the <p> when it renders. */
export function autop(html: string): string {
  if (/<(p|h[1-6]|ul|ol|div|blockquote|pre|figure|table)\b/i.test(html)) return html;
  return html
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${p.replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

const NOT_CONTENT = new Set(['attachment', 'nav_menu_item', 'revision', 'customize_changeset', 'oembed_cache', 'wp_global_styles', 'wp_navigation', 'wp_template', 'wp_template_part', 'custom_css', 'user_request']);

export function readWordpressExport(xml: string): ImportSource {
  const notes: string[] = [];
  const items = parseWxr(xml);
  const get = (i: Item, k: string) => i.tags.get(k) ?? '';
  // WordPress stores titles and names entity-encoded even inside CDATA.
  const text = (i: Item, k: string) => decodeEntities(get(i, k));

  const media: SourceMedia[] = [];
  for (const i of items.filter((x) => get(x, 'wp:post_type') === 'attachment')) {
    const url = get(i, 'wp:attachment_url');
    const id = get(i, 'wp:post_id');
    if (!url || !id) continue;
    media.push({
      id,
      filename: decodeURIComponent(url.split('/').pop() ?? id),
      location: url,
      ...(i.meta.get('_wp_attachment_image_alt') ? { alt: i.meta.get('_wp_attachment_image_alt') } : {}),
      aliases: [url],
    });
  }

  const records: RawRecord[] = [];
  const skipped = new Map<string, number>();
  let scheduled = 0;
  for (const i of items) {
    const type = get(i, 'wp:post_type');
    const id = get(i, 'wp:post_id');
    if (!type || !id || type === 'attachment') continue;
    const status = get(i, 'wp:status');
    if (NOT_CONTENT.has(type) || status === 'trash' || status === 'auto-draft' || status === 'inherit') {
      skipped.set(type, (skipped.get(type) ?? 0) + 1);
      continue;
    }
    if (status === 'future') scheduled++;
    const gmt = get(i, 'wp:post_date_gmt');
    const date = gmt && !gmt.startsWith('0000') ? `${gmt.replace(' ', 'T')}Z` : get(i, 'wp:post_date') ? get(i, 'wp:post_date').replace(' ', 'T') + 'Z' : undefined;
    const thumb = i.meta.get('_thumbnail_id');
    const slug = get(i, 'wp:post_name') || undefined;
    records.push({
      type: keyOf(type),
      id,
      published: status === 'publish',
      ...(slug ? { slug } : {}),
      title: text(i, 'title') || undefined,
      values: {
        title: text(i, 'title') || undefined,
        body: get(i, 'content:encoded') ? { $html: get(i, 'content:encoded') } : undefined,
        excerpt: text(i, 'excerpt:encoded') || undefined,
        publishedAt: date,
        author: text(i, 'dc:creator') || undefined,
        categories: i.cats.filter((c) => c.domain === 'category').map((c) => decodeEntities(c.value)),
        tags: i.cats.filter((c) => c.domain === 'post_tag').map((c) => decodeEntities(c.value)),
        featuredImage: thumb && media.some((m) => m.id === thumb) ? thumb : undefined,
      },
    });
  }
  const types = [...new Set(records.map((r) => r.type))];
  const collections: PayloadCollection[] = types.map((slug) => ({
    slug,
    titleField: 'title',
    fields: [
      { name: 'title', type: 'text', required: true },
      { name: 'body', type: 'richText' },
      { name: 'excerpt', type: 'textarea' },
      { name: 'publishedAt', type: 'date' },
      { name: 'author', type: 'text' },
      listOf('categories', { type: 'text' }),
      listOf('tags', { type: 'text' }),
      { name: 'featuredImage', type: 'upload', relationTo: 'media' },
    ],
  }));
  for (const [t, n] of skipped) notes.push(`${n} ${t} item(s) (menus, revisions, trash…) are not content and were skipped.`);
  if (scheduled) notes.push(`${scheduled} scheduled post(s) are imported as drafts; schedule them in the library.`);

  return {
    name: 'wordpress',
    modelSource: collections.length ? payloadConfigSource(collections) : undefined,
    records,
    media,
    notes,
    richText: (raw, image) => (typeof raw === 'object' && raw !== null && typeof (raw as { $html?: unknown }).$html === 'string' ? fromHtml(autop((raw as { $html: string }).$html), image) : null),
    mediaId: (raw) => (typeof raw === 'string' || typeof raw === 'number' ? String(raw) : null),
    refs: () => [],
  };
}
