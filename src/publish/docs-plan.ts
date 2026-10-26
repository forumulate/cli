import { sameText } from './compare';
import type { SpaceCtx } from './context';
import { textDiff } from './diff';
import { mainSlot } from './slots';
import { mediaChanged } from './rewrite';
import type { LiveCollection, LivePage, LocalCollection, LocalPage } from './types';

/**
 * What publishing a docs folder would WRITE: collections, page bodies, moves
 * between collections and the prune. Metadata and order come after the write
 * (`docs-reconcile.ts`), because they need the ids of pages this run creates.
 */
export interface DocsPlan {
  /** Local collection → the live one it is, or undefined when it will be created. */
  collectionOf: Map<LocalCollection, LiveCollection | undefined>;
  createCollections: LocalCollection[];
  patchCollections: { live: LiveCollection; body: Record<string, unknown> }[];
  /** A page that exists in another collection than its folder says. */
  moves: { page: LivePage; to: LocalCollection }[];
  /** Per collection, the files to send to the importer. */
  sends: Map<LocalCollection, { page: LocalPage; why: 'create' | 'update' }[]>;
  /**
   * Pages whose front matter fills named slots: written through the page's
   * markdown door after the import (which places a new one), then published.
   */
  slotWrites: LocalPage[];
  prunePages: LivePage[];
  pruneCollections: LiveCollection[];
  unchanged: number;
}

export interface DocsLive {
  collections: LiveCollection[];
  pages: LivePage[];
  publicRows: Map<string, Record<string, unknown>>;
}

/** The live collection a folder is: by slug, then by name. */
export function matchCollections(
  local: LocalCollection[],
  live: LiveCollection[],
  rootName?: string,
): Map<LocalCollection, LiveCollection | undefined> {
  const out = new Map<LocalCollection, LiveCollection | undefined>();
  const taken = new Set<string>();
  for (const c of local) {
    let hit: LiveCollection | undefined;
    if (c.dir === '' && !rootName) {
      // Files at the root of the space go where the space files loose pages.
      hit = live.find((l) => l.isDefault) ?? live.find((l) => l.slug === 'pages');
      if (!hit) {
        c.slug = 'pages';
        c.name = 'Pages';
      } else {
        c.slug = hit.slug;
        c.name = hit.name;
      }
    } else {
      hit =
        live.find((l) => !taken.has(l.id) && l.slug === c.slug) ??
        live.find((l) => !taken.has(l.id) && l.name.toLowerCase() === c.name.toLowerCase());
    }
    if (hit) taken.add(hit.id);
    out.set(c, hit);
  }
  return out;
}

/**
 * How a live page's body is read for comparison: one walk authenticated, per
 * page otherwise. `sections` is the page's named slots (empty without a token).
 */
export type BodyOf = (
  page: LivePage,
) => Promise<{ markdown: string; sections: Record<string, string> } | null>;

/** Which of a slotted page's slots differ from the live page's. */
function slotsDiffer(
  ctx: SpaceCtx,
  p: LocalPage,
  live: { markdown: string; sections: Record<string, string> },
): string[] {
  const main = mainSlot(ctx.slots ?? [])?.key;
  const flat = !Object.keys(live.sections).length;
  return Object.entries(p.sections)
    .filter(([k, v]) => {
      // A page written before it had slots holds its words outside any slot:
      // that is the main slot's content as far as a reader can tell.
      const was = live.sections[k] ?? (flat && k === main ? live.markdown : '');
      return !sameText(v, was);
    })
    .map(([k]) => k);
}

export async function planDocs(
  ctx: SpaceCtx,
  live: DocsLive,
  bodyOf: BodyOf,
  openapiCollections: Set<string>,
  /** Per file: reference → the URL already uploaded for it (see `mediaChanged`). */
  urlsFor: (file: string) => Map<string, string> = () => new Map(),
): Promise<DocsPlan> {
  const { scan, spec, only } = ctx;
  const collectionOf = matchCollections(scan.collections, live.collections, spec.rootCollection);
  const plan: DocsPlan = {
    collectionOf,
    createCollections: [],
    patchCollections: [],
    moves: [],
    sends: new Map(),
    slotWrites: [],
    prunePages: [],
    pruneCollections: [],
    unchanged: 0,
  };
  const bySlug = new Map(live.pages.map((p) => [p.slug, p]));
  // Every slug is one address in a space: two files claiming it is a conflict
  // the author resolves, not one the publisher picks a winner in.
  const owner = new Map<string, string>();
  for (const c of scan.collections)
    for (const p of c.pages) {
      const prev = owner.get(p.slug);
      if (prev)
        ctx.errors.push(
          `two files publish at "${p.slug}": ${prev} and ${p.file} — give one a \`slug:\``,
        );
      owner.set(p.slug, p.file);
    }

  for (const c of scan.collections) {
    const inScope = (p: LocalPage) => only.piece(spec, p.slug, p.file, c);
    const scoped = c.pages.filter(inScope);
    const target = collectionOf.get(c);
    if (!scoped.length && only.all === false) continue;
    if (!target) {
      plan.createCollections.push(c);
      ctx.line({
        verb: 'create',
        what: `collection ${c.slug}`,
        detail: `"${c.name}" ← ${c.dir || '(space root)'}/`,
      });
    } else {
      const declared = spec.collections?.[c.dir];
      const body: Record<string, unknown> = {};
      // Only what the author SAID. A name derived from a folder must not
      // overwrite one somebody chose in the studio on every run.
      if (declared?.name && declared.name !== target.name) body.name = declared.name;
      if (c.nav && JSON.stringify({ ...target.nav, ...c.nav }) !== JSON.stringify(target.nav ?? {}))
        body.nav = c.nav;
      if (Object.keys(body).length) {
        plan.patchCollections.push({ live: target, body });
        ctx.line({
          verb: 'patch',
          what: `collection ${target.slug}`,
          detail: Object.keys(body).join(', '),
        });
      }
    }
    const sends: { page: LocalPage; why: 'create' | 'update' }[] = [];
    for (const p of scoped) {
      const existing = bySlug.get(p.slug);
      const slotted = Object.keys(p.sections).length > 0;
      if (!existing) {
        sends.push({ page: p, why: 'create' });
        if (slotted) plan.slotWrites.push(p);
        ctx.line({
          verb: 'create',
          what: `page ${p.slug}`,
          detail: `← ${p.file}${slotted ? `  (${Object.keys(p.sections).join(', ')})` : ''}`,
        });
        continue;
      }
      if (target && existing.collectionId !== target.id) {
        plan.moves.push({ page: existing, to: c });
        ctx.line({ verb: 'move', what: `page ${p.slug}`, detail: `into collection ${c.slug}` });
      } else if (!target) {
        plan.moves.push({ page: existing, to: c });
        ctx.line({ verb: 'move', what: `page ${p.slug}`, detail: `into new collection ${c.slug}` });
      }
      // A folder stub never overwrites a page that already stands for the folder.
      if (p.stub) {
        plan.unchanged++;
        continue;
      }
      const reasons: string[] = [];
      let diff: string[] | undefined;
      if (ctx.force) reasons.push('--force');
      if (!existing.published) reasons.push('not published');
      if (existing.title !== p.title) reasons.push(`title "${existing.title}" → "${p.title}"`);
      if (!reasons.length || slotted) {
        const liveBody = await bodyOf(existing);
        if (liveBody === null) reasons.push('content not readable');
        else if (slotted) {
          const changed = slotsDiffer(ctx, p, liveBody);
          if (changed.length) {
            reasons.push(changed.join(', '));
            diff = changed.flatMap((k) => [
              `@ ${k}`,
              ...textDiff(liveBody.sections[k] ?? '', p.sections[k] ?? ''),
            ]);
          }
        } else if (!sameText(p.body, liveBody.markdown)) {
          reasons.push('content');
          diff = textDiff(liveBody.markdown, p.body);
        }
        if (
          liveBody &&
          !reasons.length &&
          mediaChanged(p.body, ctx.scan.refs.get(p.file), urlsFor(p.file), liveBody.markdown)
        )
          reasons.push('media');
      }
      if (reasons.length) {
        // A slotted page is rewritten through its own markdown door; the
        // importer would flatten its slots into one document.
        if (slotted) plan.slotWrites.push(p);
        else sends.push({ page: p, why: 'update' });
        ctx.line({
          verb: 'update',
          what: `page ${p.slug}`,
          detail: `${reasons.join(', ')} ← ${p.file}`,
          ...(diff?.length ? { diff } : {}),
        });
      } else plan.unchanged++;
    }
    if (sends.length) plan.sends.set(c, sends);
    for (const p of scoped)
      if (p.unknown.length)
        ctx.line({
          verb: 'warn',
          what: `page ${p.slug}`,
          detail: `front matter not understood, not sent: ${p.unknown.join(', ')}`,
        });
  }

  if (ctx.prune) planPrune(ctx, live, plan, openapiCollections);
  return plan;
}

/**
 * `--prune`: what the folder no longer has.
 *
 * Never on a narrowed run, never a collection an OpenAPI import owns, never a
 * slug or collection the manifest says to `keep`, and never a page with a kept
 * page underneath it — deleting a parent takes its children to the trash with
 * it, and "I removed one file" must not cost a subtree. Pages go to the trash,
 * where they can be restored.
 */
function planPrune(
  ctx: SpaceCtx,
  live: DocsLive,
  plan: DocsPlan,
  openapiCollections: Set<string>,
): void {
  if (!ctx.only.all) {
    ctx.line({
      verb: 'skip',
      what: 'prune',
      detail: 'not with --only — a narrowed run never deletes',
    });
    return;
  }
  // A file marked `draft: true` still owns its address: marking a live page as
  // a draft must not send it to the trash.
  const keep = new Set([...(ctx.spec.keep ?? []), ...ctx.scan.drafts]);
  const wanted = new Set(ctx.scan.collections.flatMap((c) => c.pages.map((p) => p.slug)));
  const managed = new Set([...plan.collectionOf.values()].filter(Boolean).map((c) => c!.id));
  const protectedCols = new Set(
    live.collections
      .filter(
        (c) =>
          openapiCollections.has(c.name.toLowerCase()) ||
          openapiCollections.has(c.slug) ||
          keep.has(c.slug) ||
          keep.has(c.name),
      )
      .map((c) => c.id),
  );
  const doomed = new Set(
    live.pages
      .filter((p) => !wanted.has(p.slug) && !keep.has(p.slug) && !protectedCols.has(p.collectionId))
      .map((p) => p.id),
  );
  const children = new Map<string, LivePage[]>();
  for (const p of live.pages)
    if (p.parentId) children.set(p.parentId, [...(children.get(p.parentId) ?? []), p]);
  const keepsSomething = (id: string): boolean =>
    (children.get(id) ?? []).some((c) => !doomed.has(c.id) || keepsSomething(c.id));
  for (const p of live.pages) {
    if (!doomed.has(p.id)) continue;
    if (keepsSomething(p.id)) {
      ctx.line({
        verb: 'skip',
        what: `prune ${p.slug}`,
        detail: 'has pages under it that are kept',
      });
      continue;
    }
    plan.prunePages.push(p);
    ctx.line({ verb: 'prune', what: `page ${p.slug}`, detail: 'no file — to the trash' });
  }
  const prunedIds = new Set(plan.prunePages.map((p) => p.id));
  for (const c of live.collections) {
    if (managed.has(c.id) || protectedCols.has(c.id) || c.isDefault) continue;
    const rest = live.pages.filter((p) => p.collectionId === c.id && !prunedIds.has(p.id));
    if (rest.length) continue;
    plan.pruneCollections.push(c);
    ctx.line({ verb: 'prune', what: `collection ${c.slug}`, detail: 'no folder' });
  }
}
