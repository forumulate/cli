import { spacePath, type SpaceCtx } from './context';
import type { DocsLive, DocsPlan } from './docs-plan';

/**
 * Studio edits made since the last publish (FMU-D18), found before anything
 * is written.
 *
 * A docs-as-code publish compared each file with the live page and wrote over
 * whatever differed. When somebody had fixed a typo in the studio, the next CI
 * run put the typo back, and nothing anywhere said a change had been lost. The
 * server now keeps a sync baseline per page (what the last publish made live);
 * `GET …/sync-state` says which pages were edited after it, by whom and when.
 * A page this run would UPDATE that was edited since is a conflict: the run
 * stops before its first write and names each one. `--force` overwrites.
 */
export interface StudioConflict {
  slug: string;
  pageId: string;
  by: string;
  at: string;
}

interface SyncStateRow {
  pageId: string;
  slug: string;
  editedSinceSync: boolean;
  lastEdit: { by: { name: string | null; email: string | null }; at: string } | null;
}

/** The pages this plan would overwrite that were edited since the last publish. */
export async function studioConflicts(
  ctx: SpaceCtx,
  plan: DocsPlan,
  live: DocsLive,
): Promise<StudioConflict[]> {
  const bySlug = new Map(live.pages.map((p) => [p.slug, p]));
  const touched = new Map<string, string>();
  for (const sends of plan.sends.values())
    for (const s of sends) {
      const page = s.why === 'update' ? bySlug.get(s.page.slug) : undefined;
      if (page) touched.set(page.id, page.slug);
    }
  for (const p of plan.slotWrites) {
    const page = bySlug.get(p.slug);
    if (page) touched.set(page.id, page.slug);
  }
  if (touched.size === 0) return [];
  let rows: SyncStateRow[] = [];
  try {
    // Chunked: a query string has a limit, and a big docs space has hundreds.
    const ids = [...touched.keys()];
    for (let i = 0; i < ids.length; i += 100) {
      const res = await ctx.api.get<{ pages: SyncStateRow[] }>(spacePath(ctx, '/sync-state'), {
        pageIds: ids.slice(i, i + 100).join(','),
      });
      rows.push(...(res.pages ?? []));
    }
  } catch (e) {
    // An API from before the baseline existed: nothing to compare with, which
    // is the state every page was in before this check — publish as before.
    if ((e as { status?: number }).status === 404) return [];
    throw e;
  }
  rows = rows.filter((r) => r.editedSinceSync && touched.has(r.pageId));
  return rows.map((r) => ({
    slug: r.slug,
    pageId: r.pageId,
    by: r.lastEdit?.by.name ?? r.lastEdit?.by.email ?? 'someone',
    at: r.lastEdit?.at ?? 'an unknown time',
  }));
}

/** The line and the error a conflict prints, in the words the docs promise. */
export function conflictText(c: StudioConflict): string {
  return `CONFLICT ${c.slug} edited in studio by ${c.by} at ${c.at}`;
}
