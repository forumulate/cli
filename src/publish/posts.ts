import { camel } from './frontmatter';
import { differingKeys, holds, sameText } from './compare';
import { spacePath, type SpaceCtx } from './context';
import { idemKey } from './api';
import { knownUrls, uploadAssetsFor } from './docs-apply';
import { rewriteAssets, rewriteLinks, rewriteValue } from './rewrite';
import { tagKey } from './scan';
import type { LivePost, LocalPost } from './types';

/**
 * Posts: a blog, a changelog, or any space whose pieces are not docs pages.
 *
 * Each type goes through the door its own surface uses, because each takes
 * facts the generic one cannot: a blog post's tags, excerpt and date are
 * columns of the blog, not declared parameters, and `POST …/items` refuses a
 * key the type does not declare. Blog and changelog through their own routes;
 * everything else through `POST …/items`, which writes any kind of piece.
 *
 * Keyed by slug. A changelog derives its slug from the release title (it takes
 * no slug on create), so a release is also matched by its title — otherwise a
 * file named `2-4-0.md` titled "Faster search" would make a second release on
 * every run.
 */

type Kind = 'blog' | 'changelog' | 'items';
const kindOf = (type: string): Kind =>
  type === 'BLOG' ? 'blog' : type === 'CHANGELOG' ? 'changelog' : 'items';

/** Front matter keys each door takes besides the body, under the door's own names. */
const BLOG_EXTRAS = [
  'tags',
  'excerpt',
  'coverUrl',
  'coverAlt',
  'subtitle',
  'series',
  'socialImageUrl',
  'publishedAt',
  'seo',
  'furtherReading',
  'commentsEnabled',
  'onThisPage',
  'author',
  'bylines',
  'customization',
  'featured',
  'pinned',
];
const CHANGELOG_EXTRAS = [
  'version',
  'publishedAt',
  'tags',
  'fields',
  'onThisPage',
  'customization',
  'featured',
  'pinned',
];
const ALIAS: Record<string, string> = {
  image: 'coverUrl',
  cover: 'coverUrl',
  coverimage: 'coverUrl',
  date: 'publishedAt',
  ogimage: 'socialImageUrl',
  socialimage: 'socialImageUrl',
};
const IGNORED = new Set([
  'title',
  'slug',
  'draft',
  'notify',
  'layout',
  'permalink',
  'id',
  'description',
  'summary',
  'standfirst',
]);
/** What a summary section is called in the front matter of every tool we have met. */
const SUMMARY_KEYS = ['standfirst', 'description', 'summary', 'excerpt', 'lede'];

interface Shape {
  sections: { key: string; required?: boolean; role?: string; schemaProperty?: string }[];
  params: { key: string }[];
}

/** `2026-10-01` → an ISO datetime; anything Date can read, likewise. */
function isoDate(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'string' || !v.trim()) return undefined;
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(v.trim()) ? `${v.trim()}T00:00:00.000Z` : v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** The first paragraph as plain text — a standfirst for a post that did not write one. */
function firstParagraph(md: string): string {
  const para =
    md
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .find((p) => p && !/^(#|!\[|```|:::|<|\||[-*+] |\d+\. )/.test(p)) ?? '';
  return para
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

/** What one post sends: the body (as sections when the type declares them) and its extras. */
export function postPayload(
  post: LocalPost,
  kind: Kind,
  shape: Shape,
  ctx: SpaceCtx,
  urls: Map<string, string>,
): {
  body: Record<string, unknown>;
  extras: Record<string, unknown>;
  unknown: string[];
  derived?: string;
} {
  const text = rewriteAssets(rewriteLinks(post.body, post.file, ctx.scan.slugByFile), urls).trim();
  const front = rewriteValue(post.front, urls);
  const lower = new Map(
    Object.entries(front).map(([k, v]) => [k.toLowerCase().replace(/[-_]/g, ''), [k, v] as const]),
  );
  const body: Record<string, unknown> = { title: post.title };
  const used = new Set<string>();
  let derived: string | undefined;
  if (shape.sections.length) {
    const sections: Record<string, string> = {};
    for (const s of shape.sections) {
      const hit = lower.get(s.key.toLowerCase());
      if (hit && typeof hit[1] === 'string') {
        sections[s.key] = hit[1];
        used.add(hit[0]);
      }
    }
    const summary = shape.sections.find((s) => s.role === 'summary' || s.key === 'standfirst');
    const main =
      shape.sections.find((s) => s.key === 'body' || s.schemaProperty === 'articleBody') ??
      shape.sections[shape.sections.length - 1]!;
    if (summary && !sections[summary.key]) {
      const given = SUMMARY_KEYS.map((k) => lower.get(k)).find(
        (h) => h && typeof h[1] === 'string',
      );
      if (given) {
        sections[summary.key] = String(given[1]);
        used.add(given[0]);
      } else if (summary.required) {
        sections[summary.key] = derived = firstParagraph(text);
      }
    }
    if (!sections[main.key]) sections[main.key] = text;
    body.sections = sections;
  } else body[kind === 'items' ? 'body' : 'markdown'] = text;
  if (kind !== 'blog') {
    // Only the blog and items doors take an address; a release's comes from its title.
    if (kind === 'items') body.slug = post.slug;
  } else body.slug = post.slug;

  const extras: Record<string, unknown> = {};
  const unknown: string[] = [];
  const allowed = kind === 'blog' ? BLOG_EXTRAS : kind === 'changelog' ? CHANGELOG_EXTRAS : [];
  const params = new Map(shape.params.map((p) => [p.key.toLowerCase(), p.key]));
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(front)) {
    if (used.has(k)) continue;
    const flat = k.toLowerCase().replace(/[-_]/g, '');
    if (IGNORED.has(flat)) continue;
    const name = ALIAS[flat] ?? allowed.find((a) => a.toLowerCase() === flat) ?? camel(k);
    if (allowed.includes(name)) {
      extras[name] =
        name === 'publishedAt'
          ? isoDate(v)
          : name === 'tags'
            ? Array.isArray(v)
              ? v.map(String)
              : String(v)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
            : v;
      continue;
    }
    const param = params.get(flat);
    if (param) {
      fields[param] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
      continue;
    }
    unknown.push(k);
  }
  if (Object.keys(fields).length) {
    if (kind === 'items') body.params = fields;
    else if (kind === 'changelog')
      extras.fields = { ...((extras.fields as object) ?? {}), ...fields };
    // A blog's declared parameters that are not columns of the blog door
    // (`canonicalUrl`, `coverPlacement`) have no field to land in there.
    else unknown.push(...Object.keys(fields).map((k) => `${k} (set it in the studio)`));
  }
  // A blog without declared sections still has an excerpt; `description` is
  // what most tools call it.
  if (kind === 'blog' && !shape.sections.length && extras.excerpt === undefined) {
    const d = SUMMARY_KEYS.map((k) => lower.get(k)).find((h) => h && typeof h[1] === 'string');
    if (d) extras.excerpt = d[1];
  }
  if (extras.publishedAt === undefined) delete extras.publishedAt;
  return { body, extras, unknown, derived };
}

/** Plan, and on a real run apply, one posts folder. */
export async function publishPosts(
  ctx: SpaceCtx,
  apply: boolean,
  existingAssets: Map<string, string>,
): Promise<void> {
  const kind = kindOf(ctx.type);
  const [live, shape] = await Promise.all([
    ctx.api.posts(ctx.org, ctx.spaceId, ctx.type),
    ctx.api.shape(ctx.org, ctx.spaceId),
  ]);
  if (live === null)
    ctx.line({
      verb: 'warn',
      what: `space ${ctx.spec.space ?? ''}`,
      detail: `a ${ctx.type} space cannot be read without a token — every post is shown as a create`,
    });
  const bySlug = new Map((live ?? []).map((p) => [p.slug, p]));
  const byTitle = new Map((live ?? []).map((p) => [p.title.toLowerCase(), p]));
  const scoped = ctx.scan.posts.filter((p) => ctx.only.piece(ctx.spec, p.slug, p.file));
  const urls = apply
    ? await uploadAssetsFor(
        ctx,
        scoped.map((p) => p.file),
        existingAssets,
      )
    : new Map(scoped.map((p) => [p.file, knownUrls(ctx, existingAssets)(p.file)]));
  const matched = new Set<string>();
  const base = kind === 'items' ? '/items' : `/${kind}`;

  for (const post of scoped) {
    const found =
      bySlug.get(post.slug) ??
      (kind === 'changelog' ? byTitle.get(post.title.toLowerCase()) : undefined);
    if (found) matched.add(found.id);
    const fileUrls = urls.get(post.file) ?? new Map<string, string>();
    const pay = postPayload(post, kind, shape, ctx, fileUrls);
    if (pay.unknown.length)
      ctx.line({
        verb: 'warn',
        what: `post ${post.slug}`,
        detail: `front matter not understood, not sent: ${pay.unknown.join(', ')}`,
      });
    if (pay.derived !== undefined)
      ctx.line({
        verb: 'warn',
        what: `post ${post.slug}`,
        detail: 'no standfirst/description — the first paragraph is used',
      });

    if (!found) {
      ctx.line({ verb: 'create', what: `post ${post.slug}`, detail: `← ${post.file}` });
      if (!apply) continue;
      const created = await createPost(ctx, kind, base, { ...pay.body, ...pay.extras }, post);
      await publish(ctx, kind, base, created, post);
      continue;
    }
    const reasons: string[] = [];
    if (ctx.force) reasons.push('--force');
    if (found.title !== post.title) reasons.push('title');
    if (!reasons.length && live) {
      const sections = pay.body.sections as Record<string, string> | undefined;
      const same =
        sections && found.sections && Object.keys(found.sections).length
          ? Object.entries(sections).every(([k, v]) => sameText(v, found.sections?.[k] ?? ''))
          : sameText(
              String(
                pay.body.markdown ?? pay.body.body ?? Object.values(sections ?? {}).join('\n\n'),
              ),
              found.markdown ?? '',
            );
      if (!same) reasons.push('content');
    }
    const extrasDiff =
      Object.keys(pay.extras).length && ctx.api.opts.authed
        ? await extrasChanged(ctx, kind, base, found, pay.extras)
        : [];
    if (extrasDiff.length) reasons.push(extrasDiff.join(', '));
    if (!found.published) reasons.push('not published');
    if (!reasons.length) continue;
    ctx.line({
      verb: 'update',
      what: `post ${post.slug}`,
      detail: `${reasons.join(', ')} ← ${post.file}`,
    });
    if (!apply) continue;
    await updatePost(ctx, kind, base, found, pay, reasons);
    if (!found.published) await publish(ctx, kind, base, found.id, post);
  }

  if (!ctx.prune || !live) return;
  if (!ctx.only.all) {
    ctx.line({
      verb: 'skip',
      what: 'prune',
      detail: 'not with --only — a narrowed run never deletes',
    });
    return;
  }
  const keep = new Set(ctx.spec.keep ?? []);
  for (const p of live) {
    if (matched.has(p.id) || keep.has(p.slug)) continue;
    ctx.line({ verb: 'prune', what: `post ${p.slug}`, detail: 'no file — deleted (recoverable)' });
    if (apply) await ctx.api.del(spacePath(ctx, `/items/${p.id}`));
  }
}

async function createPost(
  ctx: SpaceCtx,
  kind: Kind,
  base: string,
  body: Record<string, unknown>,
  post: LocalPost,
): Promise<string> {
  if (kind === 'items') {
    // `POST …/items` requires an Idempotency-Key: a retried create is one piece.
    const r = await ctx.api.post<{ item: { id: string } }>(spacePath(ctx, base), body, {
      'Idempotency-Key': idemKey(ctx.spaceId, post.slug, post.source),
    });
    return r.item.id;
  }
  const r = await ctx.api.post<{ article?: { id: string }; release?: { id: string } }>(
    spacePath(ctx, base),
    body,
  );
  const id = r.article?.id ?? r.release?.id;
  if (!id) throw new Error(`creating ${post.slug} answered without an id`);
  return id;
}

async function updatePost(
  ctx: SpaceCtx,
  kind: Kind,
  base: string,
  found: LivePost,
  pay: ReturnType<typeof postPayload>,
  reasons: string[],
): Promise<void> {
  if (kind !== 'items') {
    // Blog and changelog take the body and the extras in one PATCH.
    const body: Record<string, unknown> = { ...pay.extras };
    if (reasons.some((r) => r !== 'not published')) Object.assign(body, pay.body);
    if (kind === 'blog') delete body.slug;
    await ctx.api.patch(spacePath(ctx, `${base}/${found.id}`), body);
    return;
  }
  const { title, params, sections, body } = pay.body as {
    title: string;
    params?: object;
    sections?: Record<string, string>;
    body?: string;
  };
  await ctx.api.patch(spacePath(ctx, `/items/${found.id}`), {
    title,
    ...(params ? { params } : {}),
  });
  if (sections)
    for (const [k, v] of Object.entries(sections))
      await ctx.api.put(spacePath(ctx, `/items/${found.id}/sections/${k}`), { markdown: v });
  else await ctx.api.put(spacePath(ctx, `/items/${found.id}/content`), { body });
}

async function publish(
  ctx: SpaceCtx,
  kind: Kind,
  base: string,
  id: string,
  post: LocalPost,
): Promise<void> {
  // `notify: false` in front matter is the silent publish a back-catalogue import wants.
  const notify = post.front.notify === false ? { notify: false } : {};
  await ctx.api.post(
    spacePath(ctx, kind === 'items' ? `/items/${id}/publish` : `${base}/${id}/publish`),
    kind === 'blog' ? notify : {},
  );
}

/** Which declared extras the live post does not already hold. */
async function extrasChanged(
  ctx: SpaceCtx,
  kind: Kind,
  base: string,
  found: LivePost,
  extras: Record<string, unknown>,
): Promise<string[]> {
  if (kind === 'items') return [];
  const r = await ctx.api.get<{
    article?: Record<string, unknown>;
    release?: Record<string, unknown>;
  }>(spacePath(ctx, `${base}/${found.id}`));
  const current = { ...(r.article ?? r.release ?? {}) };
  if (Array.isArray(current.tags))
    current.tags = (current.tags as unknown[]).map((t) =>
      typeof t === 'string' ? t : String((t as { name?: string }).name ?? ''),
    );
  const want = { ...extras };
  // Tags are stored as slugs; dates by the instant. Compare those, not spellings.
  if (Array.isArray(want.tags)) {
    const norm = (l: unknown[]) => l.map((t) => tagKey(String(t))).sort();
    if (holds(norm((current.tags as unknown[]) ?? []), norm(want.tags))) delete want.tags;
  }
  if (
    want.publishedAt &&
    current.publishedAt &&
    new Date(String(current.publishedAt)).getTime() === new Date(String(want.publishedAt)).getTime()
  )
    delete want.publishedAt;
  if (want.author !== undefined) {
    const byline = current.byline as { name?: string } | string | null;
    if ((typeof byline === 'string' ? byline : byline?.name) === want.author) delete want.author;
  }
  return differingKeys(current, want);
}
