import { differingKeys, stayPut } from './compare';
import { spacePath, type SpaceCtx } from './context';
import type { DocsLive } from './docs-plan';
import { rewriteValue } from './rewrite';
import type { LiveCollection, LocalCollection, LocalPage } from './types';

/**
 * After the bodies land: metadata, nesting and order.
 *
 * Run twice in a real publish — never, in fact, on a guess. On a dry run it
 * reads the space as it is and says what would change; on a real run it reads
 * the space AGAIN after the import, because the pages this run created only
 * have ids now, and acts on that. One function, so the plan and the run cannot
 * disagree about what "in order" means.
 */
export interface ReconcileInput {
  live: DocsLive;
  collectionOf: Map<LocalCollection, LiveCollection | undefined>;
  /** Current metadata of a page, or null when it cannot be read (no token). */
  metaOf: (pageId: string) => Promise<Record<string, unknown> | null>;
  /** Per file: local reference → asset URL, for metadata that names a local image. */
  urlsFor: (file: string) => Map<string, string>;
  /** Shared across a run: whether `POST …/collections/{id}/order` exists. */
  bulkOrder: { available: boolean | undefined };
}

/** Keys a public page row carries, under the metadata name they compare with. */
const PUBLIC_META: Record<string, string> = {
  icon: 'icon',
  tags: 'tags',
  hideFromNav: 'hideFromNav',
  seoDescription: 'description',
};

export async function reconcileDocs(
  ctx: SpaceCtx,
  input: ReconcileInput,
  apply: boolean,
): Promise<void> {
  const { live } = input;
  const bySlug = new Map(live.pages.map((p) => [p.slug, p]));
  const idOf = (slug: string) => bySlug.get(slug)?.id ?? `new:${slug}`;
  const scoped = (c: LocalCollection, p: LocalPage) => ctx.only.piece(ctx.spec, p.slug, p.file, c);

  // ── Metadata ──────────────────────────────────────────────────────────────
  for (const c of ctx.scan.collections) {
    for (const p of c.pages) {
      if (!scoped(c, p) || !Object.keys(p.meta).length) continue;
      const want = rewriteValue(p.meta, input.urlsFor(p.file));
      const page = bySlug.get(p.slug);
      if (!page) {
        if (apply) ctx.errors.push(`page ${p.slug} is missing after the import — metadata not set`);
        else
          ctx.line({
            verb: 'meta',
            what: `page ${p.slug}`,
            detail: `set ${Object.keys(want).join(', ')} (new page)`,
          });
        continue;
      }
      let current = await input.metaOf(page.id);
      let unknown: string[] = [];
      if (current === null) {
        // Anonymous: the public row has a few of these; the rest cannot be compared.
        const row = live.publicRows.get(page.id) ?? {};
        current = {};
        for (const k of Object.keys(want)) {
          if (PUBLIC_META[k]) current[k] = row[PUBLIC_META[k]!] ?? null;
          else unknown.push(k);
        }
      }
      const keys = differingKeys(current, want).filter((k) => !unknown.includes(k));
      unknown = unknown.filter((k) => want[k] !== undefined);
      if (unknown.length && !apply)
        ctx.line({
          verb: 'meta',
          what: `page ${p.slug}`,
          detail: `cannot compare without a token: ${unknown.join(', ')}`,
        });
      if (!keys.length) continue;
      if (!apply) {
        ctx.line({ verb: 'meta', what: `page ${p.slug}`, detail: keys.join(', ') });
        continue;
      }
      await ctx.api.patch(
        spacePath(ctx, `/pages/${page.id}/metadata`),
        Object.fromEntries(keys.map((k) => [k, want[k]])),
      );
      ctx.line({ verb: 'meta', what: `page ${p.slug}`, detail: keys.join(', ') });
    }
  }

  // ── Nesting and order, one sibling group at a time ────────────────────────
  for (const c of ctx.scan.collections) {
    const col = input.collectionOf.get(c);
    const cid = col?.id ?? `new:${c.slug}`;
    const groups = new Map<string | null, LocalPage[]>();
    for (const p of c.pages) groups.set(p.parentSlug, [...(groups.get(p.parentSlug) ?? []), p]);
    for (const [parentSlug, pages] of groups) {
      // A narrowed run orders a group only if it may touch every page in it.
      if (!pages.every((p) => scoped(c, p))) continue;
      const pid = parentSlug === null ? null : idOf(parentSlug);
      const desired = [...pages]
        .sort((a, b) => a.order[0] - b.order[0] || a.order[1].localeCompare(b.order[1]))
        .map((p) => idOf(p.slug));
      // `GET …/pages` arrives in tree order; position in that list IS the order.
      const current = live.pages
        .filter((p) => p.collectionId === cid && p.parentId === pid)
        .map((p) => p.id);
      const placed = new Set(current);
      const keep = stayPut(
        desired.filter((id) => placed.has(id)),
        current,
      );
      const moving = desired.filter((id) => !keep.has(id));
      if (!moving.length) continue;
      const where = `${c.slug}${parentSlug ? `/${parentSlug}` : ''}`;
      const names = moving.map(
        (id) => live.pages.find((p) => p.id === id)?.slug ?? id.replace(/^new:/, ''),
      );
      ctx.line({
        verb: 'order',
        what: where,
        detail: `${moving.length} to place: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}`,
      });
      if (!apply) continue;
      if (pid?.startsWith('new:') || cid.startsWith('new:')) {
        ctx.errors.push(`${where}: parent or collection missing after the import — order not set`);
        continue;
      }
      await placeGroup(ctx, cid, pid, desired, moving, current, input.bulkOrder);
    }
  }

  // ── Collection order ───────────────────────────────────────────────────────
  if (!ctx.only.all) return;
  const desiredCols = ctx.scan.collections.map(
    (c) => input.collectionOf.get(c)?.id ?? `new:${c.slug}`,
  );
  const currentCols = live.collections.map((c) => c.id).filter((id) => desiredCols.includes(id));
  if (desiredCols.join() === currentCols.join()) return;
  ctx.line({
    verb: 'order',
    what: 'collections',
    detail: ctx.scan.collections.map((c) => c.slug).join(', '),
  });
  if (apply)
    await ctx.api.post(spacePath(ctx, '/collections/reorder'), {
      ids: desiredCols.filter((id) => !id.startsWith('new:')),
    });
}

/**
 * Put one sibling group in order.
 *
 * `POST …/collections/{id}/order` does it in one call when the API
 * has it; until then — and for any group it refuses — one paced
 * `POST …/pages/{id}/reorder` per page that is out of place, each placed after
 * its predecessor in the desired order. A page under the wrong parent is
 * always moved one at a time, because that call is the one that re-parents.
 */
async function placeGroup(
  ctx: SpaceCtx,
  cid: string,
  pid: string | null,
  desired: string[],
  moving: string[],
  current: string[],
  bulk: { available: boolean | undefined },
): Promise<void> {
  const reparent = moving.some((id) => !current.includes(id));
  if (!reparent && bulk.available !== false) {
    // Unmanaged siblings keep their relative order, after the managed ones.
    const pageIds = [...desired, ...current.filter((id) => !desired.includes(id))];
    try {
      await ctx.api.post(
        spacePath(ctx, `/collections/${cid}/order`),
        pid ? { pageIds, parentId: pid } : { pageIds },
      );
      bulk.available = true;
      return;
    } catch (e) {
      const status = (e as { status?: number }).status;
      // 404/405: the route is not there (yet) — stop asking for the rest of the run.
      if (status === 404 || status === 405) bulk.available = false;
      else if (status !== 400 && status !== 422) throw e;
    }
  }
  const keep = new Set(desired.filter((id) => !moving.includes(id)));
  let prev: string | null = null;
  for (const id of desired) {
    if (!keep.has(id)) {
      await ctx.api.post(spacePath(ctx, `/pages/${id}/reorder`), { parentId: pid, afterId: prev });
    }
    prev = id;
  }
}
