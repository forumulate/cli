import { declareSlug } from './frontmatter';
import { lookupAsset } from './api';
import { spacePath, type SpaceCtx } from './context';
import type { DocsPlan } from './docs-plan';
import { rewriteAssets, rewriteLinks } from './rewrite';
import { slottedMarkdown } from './slots';
import type { LiveCollection, LivePage, LocalCollection, LocalPage } from './types';

/**
 * The writes a docs plan names, in the only order that works: collections
 * before the pages filed in them, moves before the import that would otherwise
 * refuse a page living in another collection, assets before the text that
 * points at them.
 *
 * The bodies go through `POST …/docs/import` — the product's own converter,
 * the door our own guides are published through — not page-by-page creates:
 * it is the one place that understands every Markdown dialect we accept, and
 * it publishes as it writes.
 */

/** Files per import call. Long calls are cut at the edge at 30 s while the work carries on. */
const BATCH = 20;

export interface ImportReport {
  created?: number;
  replaced?: number;
  failed?: number;
  failures?: { file: string; reason: string }[];
  refused?: string[];
  collisions?: string[];
  brokenLinks?: { pageSlug: string; url: string }[];
  plan?: { slug: string; action: string }[];
}

/** The text sent for one page: its address declared, links and assets pointed at the web. */
export function payloadOf(ctx: SpaceCtx, page: LocalPage, urls: Map<string, string>): string {
  if (page.stub) return page.source;
  const linked = rewriteLinks(page.source, page.file, ctx.scan.slugByFile);
  return declareSlug(rewriteAssets(linked, urls), page.slug);
}

/** Upload what the given files reference; the map is ref → URL, per file. */
export async function uploadAssetsFor(
  ctx: SpaceCtx,
  files: string[],
  existing: Map<string, string>,
): Promise<Map<string, Map<string, string>>> {
  const out = new Map<string, Map<string, string>>();
  for (const file of files) {
    const refs = ctx.scan.refs.get(file);
    if (!refs) continue;
    const urls = new Map<string, string>();
    for (const [ref, abs] of refs) {
      // `upload` finds the same bytes under any name (`lookupAsset`), so a
      // picture used by ten posts, or renamed since the last run, goes up once.
      const had = existing.size;
      const url = await ctx.api.upload(ctx.org, ctx.spaceId, abs, existing);
      if (existing.size > had)
        ctx.line({ verb: 'upload', what: abs.slice(ctx.root.length + 1) || abs, detail: url });
      urls.set(ref, url);
    }
    out.set(file, urls);
  }
  return out;
}

/** Step 1-4: collections, moves, assets, bodies. Returns the asset URLs it used. */
export async function applyDocs(
  ctx: SpaceCtx,
  plan: DocsPlan,
  existingAssets: Map<string, string>,
): Promise<Map<string, Map<string, string>>> {
  const ids = new Map<LocalCollection, string>();
  for (const [c, live] of plan.collectionOf) if (live) ids.set(c, live.id);
  for (const c of plan.createCollections) {
    const { collection } = await ctx.api.post<{ collection: LiveCollection }>(
      spacePath(ctx, '/collections'),
      {
        name: c.name,
        slug: c.slug,
        ...(c.nav ? { nav: c.nav } : {}),
      },
    );
    ids.set(c, collection.id);
    plan.collectionOf.set(c, collection);
  }
  for (const { live, body } of plan.patchCollections)
    await ctx.api.patch(spacePath(ctx, `/collections/${live.id}`), body);
  for (const { page, to } of plan.moves) {
    await ctx.api.post(spacePath(ctx, `/pages/${page.id}/reorder`), { collectionId: ids.get(to) });
  }

  // Every file that is sent, and every page whose metadata names a local
  // image, needs its assets before anything points at them.
  const files = new Set<string>();
  for (const sends of plan.sends.values()) for (const s of sends) files.add(s.page.file);
  for (const p of plan.slotWrites) files.add(p.file);
  for (const c of ctx.scan.collections)
    for (const p of c.pages)
      if (Object.keys(p.meta).length && ctx.only.piece(ctx.spec, p.slug, p.file, c))
        files.add(p.file);
  const urls = await uploadAssetsFor(ctx, [...files], existingAssets);

  for (const [c, sends] of plan.sends) {
    const collectionId = ids.get(c);
    for (let i = 0; i < sends.length; i += BATCH) {
      const batch = sends.slice(i, i + BATCH);
      const report = await ctx.api.post<ImportReport & { purged?: Record<string, unknown> }>(
        spacePath(ctx, '/docs/import'),
        {
          files: batch.map((s) => ({
            name: s.page.importName,
            content: payloadOf(ctx, s.page, urls.get(s.page.file) ?? new Map()),
          })),
          collectionId,
          onExisting: 'replace',
          // What this publish made live becomes the sync baseline (FMU-D18),
          // and the batch's own purge is reported back (FMU-D04).
          syncBaseline: true,
          ...(ctx.purge === 'page' || ctx.purge === 'none' ? { purge: ctx.purge } : {}),
        },
      );
      if (report.purged) (ctx.purged ??= []).push(report.purged);
      noteImport(ctx, c, report);
    }
  }
  return urls;
}

/**
 * Slotted pages, after the import: each one's slots through the page's
 * markdown door (`## <label>` per slot — see `slots.ts`), then published.
 * Needs the fresh page list, because a page this run created only has an id
 * once the import has landed.
 */
export async function applySlots(
  ctx: SpaceCtx,
  plan: DocsPlan,
  pages: LivePage[],
  urls: Map<string, Map<string, string>>,
): Promise<void> {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  for (const p of plan.slotWrites) {
    const page = bySlug.get(p.slug);
    if (!page) {
      ctx.errors.push(`page ${p.slug} is missing after the import — its slots were not written`);
      continue;
    }
    const fileUrls = urls.get(p.file) ?? new Map<string, string>();
    const sections = Object.fromEntries(
      Object.entries(p.sections).map(([k, v]) => [
        k,
        rewriteAssets(rewriteLinks(v, p.file, ctx.scan.slugByFile), fileUrls),
      ]),
    );
    await ctx.api.put(spacePath(ctx, `/pages/${page.id}/content`), {
      title: p.title,
      body: slottedMarkdown(ctx.slots ?? [], sections),
    });
    const published = await ctx.api.post<{ purged?: Record<string, unknown> }>(
      spacePath(ctx, `/pages/${page.id}/publish`),
      {
        syncBaseline: true,
        // A space purge at the end covers it; otherwise the page's own.
        ...(ctx.purge ? { purge: ctx.purge === 'space' ? 'none' : ctx.purge } : {}),
      },
    );
    if (ctx.purge && published?.purged) (ctx.purged ??= []).push(published.purged);
  }
}

/** A dry run with a token asks the importer itself, so the plan is the server's too. */
export async function dryRunImports(ctx: SpaceCtx, plan: DocsPlan): Promise<void> {
  for (const [c, sends] of plan.sends) {
    const live = plan.collectionOf.get(c);
    const urls = (file: string) => {
      const refs = ctx.scan.refs.get(file);
      const m = new Map<string, string>();
      // Not uploaded on a dry run: a placeholder keeps the reference a URL.
      if (refs)
        for (const ref of refs.keys())
          m.set(ref, `https://assets.invalid/${encodeURIComponent(ref)}`);
      return m;
    };
    for (let i = 0; i < sends.length; i += BATCH) {
      const batch = sends.slice(i, i + BATCH);
      // `dryRun: true` is the importer's own promise to write nothing, so this
      // one POST goes around the read-only guard on purpose.
      const res = await ctx.api.opts.client
        .request<ImportReport>('POST', spacePath(ctx, '/docs/import'), {
          body: {
            files: batch.map((s) => ({
              name: s.page.importName,
              content: payloadOf(ctx, s.page, urls(s.page.file)),
            })),
            ...(live ? { collectionId: live.id } : { collection: c.name }),
            onExisting: 'replace',
            dryRun: true,
          },
        })
        .catch((e: Error & { status?: number }) => {
          ctx.errors.push(`import dry run for ${c.slug}: ${e.status ?? ''} ${e.message}`);
          return null;
        });
      if (res) noteImport(ctx, c, res);
    }
  }
}

function noteImport(ctx: SpaceCtx, c: LocalCollection, report: ImportReport): void {
  for (const f of report.failures ?? [])
    ctx.errors.push(`${c.dir || '(root)'}/${f.file}: ${f.reason}`);
  if ((report.failed ?? 0) > (report.failures?.length ?? 0))
    ctx.errors.push(`${c.slug}: ${report.failed} file(s) failed to import`);
  for (const s of report.refused ?? []) ctx.errors.push(`${s}: refused by the importer`);
  for (const b of report.brokenLinks ?? [])
    ctx.line({ verb: 'warn', what: `page ${b.pageSlug}`, detail: `link to nothing: ${b.url}` });
}

/** `--prune`, last: pages to the trash, then the collections left empty. */
export async function applyPrune(ctx: SpaceCtx, plan: DocsPlan): Promise<void> {
  if (plan.prunePages.length)
    await ctx.api.post(spacePath(ctx, '/pages/bulk-delete'), {
      ids: plan.prunePages.map((p) => p.id),
    });
  for (const c of plan.pruneCollections) await ctx.api.del(spacePath(ctx, `/collections/${c.id}`));
}

/**
 * Per file: local reference → the URL it already has, for assets uploaded on
 * an earlier run. A reference not uploaded yet keeps its local spelling, which
 * is what makes a plan say "coverUrl would change" — because it would.
 */
export function knownUrls(
  ctx: SpaceCtx,
  existing: Map<string, string>,
): (file: string) => Map<string, string> {
  return (file) => {
    const out = new Map<string, string>();
    for (const [ref, abs] of ctx.scan.refs.get(file) ?? []) {
      const url = lookupAsset(existing, abs);
      if (url) out.set(ref, url);
    }
    return out;
  };
}
