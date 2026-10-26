import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { differingKeys } from './compare';
import { spacePath, type SpaceCtx } from './context';
import { fieldDiff } from './diff';
import { lookupAsset } from './api';
import { slugify } from './names';
import type { LiveTag, TagSpec } from './types';

/**
 * A blog's categories: how each tag looks — label, colours, description,
 * cover, icon, the tag it sits under.
 *
 * Declared in the manifest (`tags:` on the space) or in `_tags.yml` beside the
 * posts; the manifest wins key by key. Matched by slug, compared key by key
 * against `GET …/blog/tag-info`, and only a tag that differs is written
 * (`PUT …/blog/tags/{slug}`, which merges). A local `cover:` or image `icon:`
 * is uploaded once, by content hash, like any image a post points at.
 *
 * Only a BLOG has this door; a tag list on another type is reported, not
 * silently dropped.
 */

/** `PUT …/blog/tags/{slug}`'s own keys. */
const TAG_KEYS = [
  'label',
  'color',
  'textColor',
  'colorDark',
  'textColorDark',
  'gradient',
  'description',
  'pageScheme',
  'pagePalette',
  'coverUrl',
  'icon',
  'parent',
  'translations',
  'internal',
] as const;
const BY_FOLD = new Map<string, string>(TAG_KEYS.map((k) => [k.toLowerCase(), k]));

/** The spellings people write first. */
const ALIAS: Record<string, string> = {
  name: 'label',
  title: 'label',
  colour: 'color',
  textcolour: 'textColor',
  colourdark: 'colorDark',
  textcolourdark: 'textColorDark',
  cover: 'coverUrl',
  coverimage: 'coverUrl',
  image: 'coverUrl',
  scheme: 'pageScheme',
  palette: 'pagePalette',
};

const COLOR_KEYS = new Set(['color', 'textColor', 'colorDark', 'textColorDark']);
/** A value that is a path to a local image, to upload rather than send. */
const IMAGE = /\.(png|jpe?g|gif|webp|svg|avif|ico)$/i;

/** The API's colour rule (lower-case, a hex gets its `#`), so a compare is not fooled by spelling. */
function canonColor(v: unknown): unknown {
  if (typeof v !== 'string') return v;
  const raw = v.trim().toLowerCase();
  return /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(raw) && !raw.startsWith('#')
    ? `#${raw}`
    : raw;
}

/** One declared tag → the body its door takes, and the keys nothing here understands. */
export function tagBody(spec: TagSpec): { body: Record<string, unknown>; unknown: string[] } {
  const body: Record<string, unknown> = {};
  const unknown: string[] = [];
  for (const [k, v] of Object.entries(spec ?? {})) {
    const fold = k.toLowerCase().replace(/[-_\s]/g, '');
    const key = BY_FOLD.get(fold) ?? ALIAS[fold];
    if (!key) {
      unknown.push(k);
      continue;
    }
    body[key] = COLOR_KEYS.has(key) ? canonColor(v) : typeof v === 'string' ? v.trim() : v;
  }
  if (typeof body.parent === 'string') body.parent = slugify(body.parent, '');
  return { body, unknown };
}

/** A live tag in the same terms as a declared one. */
function liveBody(t: LiveTag): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TAG_KEYS) out[k] = k in t ? (t as Record<string, unknown>)[k] : null;
  // `label` reads back as the slug when nobody named the tag.
  if (out.label === t.slug) out.label = null;
  for (const k of COLOR_KEYS) out[k] = canonColor(out[k]);
  return out;
}

/** Does a tag hold any display of its own (beyond being used by a post)? */
function described(t: LiveTag): boolean {
  const b = liveBody(t);
  return TAG_KEYS.some((k) => b[k] !== null && b[k] !== undefined && b[k] !== false);
}

export async function syncTags(
  ctx: SpaceCtx,
  apply: boolean,
  existingAssets: Map<string, string>,
): Promise<void> {
  const declared: Record<string, TagSpec> = { ...ctx.scan.tags };
  for (const [slug, spec] of Object.entries(ctx.spec.tags ?? {}))
    declared[slug] = { ...(declared[slug] ?? {}), ...(spec ?? {}) };
  if (!Object.keys(declared).length || !ctx.only.part('tags', ctx.spec)) return;
  if (ctx.type !== 'BLOG') {
    ctx.line({
      verb: 'warn',
      what: 'tags',
      detail: `a ${ctx.type} space has no tag display to set — only a blog's categories are synced`,
    });
    return;
  }
  const live = await ctx.api.tagInfo(ctx.org, ctx.spaceId);
  if (live === null) {
    ctx.line({ verb: 'meta', what: 'tags', detail: 'cannot compare without a token' });
    return;
  }
  const bySlug = new Map(live.map((t) => [t.slug, t]));
  const seen = new Set<string>();
  for (const [raw, spec] of Object.entries(declared)) {
    const slug = slugify(raw, '');
    if (!slug) {
      ctx.errors.push(`tags: "${raw}" is not a tag slug (letters, numbers and dashes)`);
      continue;
    }
    seen.add(slug);
    const { body, unknown } = tagBody(spec);
    if (unknown.length)
      ctx.line({
        verb: 'warn',
        what: `tag ${slug}`,
        detail: `not understood, not sent: ${unknown.join(', ')}`,
      });
    for (const k of ['coverUrl', 'icon'] as const) {
      const v = body[k];
      if (typeof v !== 'string' || !IMAGE.test(v) || /^[a-z][a-z0-9+.-]*:|^\//i.test(v)) continue;
      const abs = resolve(ctx.scan.absDir, v);
      if (!existsSync(abs) || !statSync(abs).isFile()) {
        ctx.errors.push(`tag ${slug}: ${k} ${v} is not a file in ${ctx.scan.dir || '.'}/`);
        delete body[k];
        continue;
      }
      // Uploaded once, by content; a plan names it by the URL it already has.
      const known = lookupAsset(existingAssets, abs);
      if (known) body[k] = known;
      else if (!apply)
        ctx.line({
          verb: 'upload',
          what: abs.slice(ctx.root.length + 1) || abs,
          detail: `tag ${slug}'s ${k} — uploaded by a real run`,
        });
      else {
        const had = existingAssets.size;
        body[k] = await ctx.api.upload(ctx.org, ctx.spaceId, abs, existingAssets);
        if (existingAssets.size > had)
          ctx.line({ verb: 'upload', what: abs.slice(ctx.root.length + 1) || abs, detail: String(body[k]) });
      }
    }
    const current = bySlug.get(slug);
    const was = current ? liveBody(current) : undefined;
    const keys = differingKeys(was, body);
    if (!keys.length) continue;
    ctx.line({
      verb: current && described(current) ? 'update' : 'create',
      what: `tag ${slug}`,
      detail: keys.join(', '),
      diff: fieldDiff(was, body, keys),
    });
    if (apply)
      await ctx.api.put(
        spacePath(ctx, `/blog/tags/${encodeURIComponent(slug)}`),
        Object.fromEntries(keys.map((k) => [k, body[k]])),
      );
  }

  // `--prune`: a described tag the folder no longer describes loses its look.
  // Its posts keep the tag; only the display is cleared (`DELETE …/tags/{slug}`).
  if (!ctx.prune) return;
  if (!ctx.only.all) return;
  const keep = new Set(ctx.spec.keep ?? []);
  for (const t of live) {
    if (seen.has(t.slug) || keep.has(t.slug) || !described(t)) continue;
    ctx.line({ verb: 'prune', what: `tag ${t.slug}`, detail: 'not declared — display cleared, posts keep the tag' });
    if (apply) await ctx.api.del(spacePath(ctx, `/blog/tags/${encodeURIComponent(t.slug)}`));
  }
}
