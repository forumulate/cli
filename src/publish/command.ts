import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { contentHash, lookupAsset, PublishApi } from './api';
import type { ApiClient } from './client';
import { Selector, spacePath, type SpaceCtx } from './context';
import { matchCollections, planDocs, type DocsLive } from './docs-plan';
import { applyDocs, applyPrune, applySlots, dryRunImports, knownUrls } from './docs-apply';
import { reconcileDocs } from './docs-reconcile';
import { syncMonitors, syncOpenApi, syncSite, syncSpace, syncTheme, warnMissingDescription } from './extras';
import { syncAbout } from './about';
import { findManifest, loadManifest } from './manifest';
import { publishPosts } from './posts';
import { scanSpace } from './scan';
import { syncTags } from './tags';
import type { LivePage, Manifest, PlanLine, SpaceSpec } from './types';
import { conflictText, studioConflicts, type StudioConflict } from './studio-edits';
import { syncRedirects } from './redirects';
import { PREVIEW_NAME, ciSource, sendPreview, type PreviewResult } from './preview';

/**
 * `forumulate publish <folder>` — a folder of Markdown, and optionally a
 * manifest, made into a live presence; and the same command run again changes
 * only what changed.
 *
 * Four customers wrote this themselves before we did (a Python script, two
 * converter-plus-publisher pairs, ~400 lines of TypeScript), and every one of
 * them did the same seven things: front matter to collections and pages,
 * idempotent re-runs, prune, reorder, read back, dry run, the OpenAPI
 * reference. That is the spec of this command.
 *
 * Three modes over ONE planner: `--dry-run` plans against the live space and
 * writes nothing (a token is optional — without one it reads the public
 * space); a real run applies the plan; and then the planner runs once more
 * against what is now live, and anything it would still change is reported as
 * a failure. That last pass is the read-back: a publish that answered 200 and
 * changed nothing is the failure every one of those scripts was eventually
 * written to catch.
 */
export interface PublishOptions {
  folder: string;
  org?: string;
  space?: string;
  manifest?: string;
  dryRun: boolean;
  prune: boolean;
  force: boolean;
  verify: boolean;
  only?: string[];
  paceMs: number;
  json: boolean;
  /** Print what changed inside each updated piece (`--diff`). */
  diff?: boolean;
  /**
   * The space a manifest-less folder (or a one-space manifest that names
   * none) publishes into — what git sync passes: the space the repository is
   * connected to. Unlike `space`, it never overrides one the manifest names.
   */
  defaultSpace?: string;
  /** Which command is speaking, for the words of the summary. */
  command?: 'publish' | 'sync';
  /** `--purge` (FMU-D04). Undefined: the server's background purge, unreported. */
  purge?: 'page' | 'space' | 'none';
  /**
   * `--preview <name>` (FMU-F01): plan as a publish would, then send the pages
   * to a preview of that name instead of publishing them. Implies a plan: no
   * page, setting or theme is written.
   */
  preview?: string;
  /** `--preview-ttl <days>`: ask for a shorter-lived preview link. */
  previewTtlDays?: number;
}

/** Everything a run decided, for a caller that keeps it (the git sync job stores it). */
export interface PublishReport {
  dryRun: boolean;
  lines: { space: string; line: PlanLine }[];
  errors: string[];
  unverified: { space: string; line: PlanLine }[];
  writes: number;
  /** Count per verb that changes something (`create`, `update`, …). */
  counts: Record<string, number>;
  /** Pieces that already matched the folder. */
  unchanged: number;
  /** Every purge the server reported for this run, per space (FMU-D04). */
  purged: Record<string, unknown>[];
  /** Pages the run refused to overwrite: edited in the studio since (FMU-D18). */
  conflicts: StudioConflict[];
  /** `--preview`: each space's preview link and summary (FMU-F01). */
  previews: PreviewResult[];
}

export interface PublishDeps {
  client: ApiClient;
  authed: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  upload?: (path: string, form: FormData) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
  /** Handed the whole result at the end, whatever the output format. */
  report?: (r: PublishReport) => void;
}

type Mode = 'plan' | 'apply' | 'verify';
const ACTION: PlanLine['verb'][] = ['create', 'update', 'meta', 'move', 'order', 'prune', 'patch'];

export async function runPublish(opts: PublishOptions, deps: PublishDeps): Promise<number> {
  const root = resolve(opts.folder);
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    deps.err(`${opts.folder} is not a folder`);
    return 1;
  }
  const manifest = loadManifest(findManifest(root, opts.manifest));
  const org = opts.org ?? manifest.org ?? (deps.env ?? process.env).FORUMULATE_ORG;
  if (!org) {
    deps.err(
      'Which organization? Pass --org <id|slug>, set FORUMULATE_ORG, or put `org:` in forumulate.yaml.',
    );
    return 1;
  }
  if (opts.defaultSpace && manifest.spaces.length === 1 && !manifest.spaces[0]!.space)
    manifest.spaces[0]!.space = opts.defaultSpace;
  if (opts.space) {
    if (manifest.spaces.length > 1) {
      deps.err(
        '--space names one space; this manifest has several — narrow with --only <folder> instead.',
      );
      return 1;
    }
    manifest.spaces[0]!.space = opts.space;
  }
  const missing = manifest.spaces.find((s) => !s.space);
  if (missing) {
    deps.err(
      `Which space${missing.path ? ` for ${missing.path}/` : ''}? Pass --space <id|slug> or put \`space:\` in the manifest.`,
    );
    return 1;
  }
  if (opts.preview !== undefined) {
    if (!PREVIEW_NAME.test(opts.preview)) {
      deps.err('--preview takes a name: letters, digits, `.`, `_` and `-`, up to 64 (`pr-123`).');
      return 2;
    }
    if (!deps.authed) {
      deps.err('A preview needs a token: `forumulate login`, or FORUMULATE_TOKEN in CI.');
      return 3;
    }
    // A preview publishes nothing: everything else in the run is a plan.
    opts = { ...opts, dryRun: true };
  }
  if (!deps.authed && !opts.dryRun) {
    deps.err(
      'Publishing needs a token: `forumulate login`, or FORUMULATE_TOKEN in CI. `--dry-run` works without one against a public space.',
    );
    return 1;
  }

  const only = new Selector(opts.only);
  const lines: { space: string; line: PlanLine }[] = [];
  const errors: string[] = [];
  const purged: Record<string, unknown>[] = [];
  const conflicts: StudioConflict[] = [];
  const previews: PreviewResult[] = [];
  const print = (space: string) => (l: PlanLine) => {
    lines.push({ space, line: l });
    if (opts.json || (l.verb === 'same' && !process.env.VERBOSE)) return;
    deps.out(`  ${l.verb.padEnd(7)} ${l.what}${l.detail ? `   ${l.detail}` : ''}`);
    if (opts.diff) for (const d of l.diff ?? []) deps.out(`            ${d}`);
  };
  const api = (readOnly: boolean) =>
    new PublishApi({
      client: deps.client,
      authed: deps.authed,
      readOnly,
      paceMs: opts.paceMs,
      upload: deps.upload,
      sleep: deps.sleep,
    });
  const writer = api(opts.dryRun);
  let orgId: string;
  try {
    orgId = await writer.orgId(org);
  } catch (e) {
    deps.err((e as Error).message);
    return 1;
  }

  const runAll = async (
    a: PublishApi,
    mode: Mode,
    sink: (space: string) => (l: PlanLine) => void,
  ) => {
    for (const spec of manifest.spaces) {
      if (!opts.json && mode !== 'verify')
        deps.out(
          `\nspace ${spec.space} ← ${spec.path || '.'}/${mode === 'plan' ? '   (dry run)' : ''}`,
        );
      try {
        await runSpace(a, mode, spec, {
          ...opts,
          root,
          orgId,
          only,
          manifest,
          errors,
          purged,
          conflicts,
          previews,
          line: sink(spec.space!),
        });
      } catch (e) {
        const err = e as { status?: number; code?: string; message?: string };
        errors.push(
          `${spec.space}: ${err.status ? `${err.status} ` : ''}${err.code ? `(${err.code}) ` : ''}${err.message ?? String(e)}`,
        );
      }
    }
    if (manifest.site && only.part('site')) {
      try {
        await syncSite(a, orgId, manifest.site, mode === 'apply', sink('site'));
      } catch (e) {
        errors.push(`site: ${(e as Error).message}`);
      }
    }
  };

  await runAll(writer, opts.dryRun ? 'plan' : 'apply', print);

  // Read back: plan again against what is live now. Anything still to do failed.
  let unverified: { space: string; line: PlanLine }[] = [];
  if (!opts.dryRun && opts.verify && errors.length === 0) {
    const again: { space: string; line: PlanLine }[] = [];
    await runAll(api(true), 'verify', (space) => (l) => again.push({ space, line: l }));
    unverified = again.filter((x) => ACTION.includes(x.line.verb));
  }

  const count = (v: PlanLine['verb']) => lines.filter((l) => l.line.verb === v).length;
  const counts = Object.fromEntries(
    ACTION.map((v) => [v, count(v)] as const).filter(([, n]) => n),
  );
  const unchanged = count('same');
  const result: PublishReport = {
    dryRun: opts.dryRun,
    lines,
    errors,
    unverified,
    writes: writer.writes,
    counts,
    unchanged,
    purged,
    conflicts,
    previews,
  };
  deps.report?.(result);
  const sync = opts.command === 'sync';
  // `--json` is printed by the caller once the run is recorded (it adds the
  // run id and diffUrl); a caller with no `report` gets it here as before.
  if (opts.json && !deps.report) {
    deps.out(JSON.stringify(result, null, 2));
  } else if (opts.json) {
    /* the caller prints the summary */
  } else {
    deps.out('');
    const parts = ACTION.map((v) => [v, count(v)] as const)
      .filter(([, n]) => n)
      .map(([v, n]) => `${n} ${v}`);
    deps.out(
      parts.length ? parts.join(', ') : 'Nothing to change — the space already matches the folder.',
    );
    for (const e of errors) deps.err(`error: ${e}`);
    const anon = deps.authed ? '' : ' (read anonymously: published content only)';
    if (opts.dryRun && sync)
      deps.out(
        parts.length
          ? `Plan only — nothing was written${anon}. Run again with --apply to make these changes.`
          : `Plan only${anon}.`,
      );
    else if (opts.preview !== undefined) {
      deps.out('Preview only — nothing was published.');
      for (const p of previews) {
        const s = p.summary;
        deps.out(
          `preview ${p.name} (${p.space}): ${s.added} added, ${s.changed} changed, ${s.removed} removed — expires ${p.expiresAt.slice(0, 10)}`,
        );
        if (p.urls[0]) deps.out(`  ${p.urls[0]}`);
      }
    } else if (opts.dryRun) deps.out(`--dry-run: nothing was written${anon}.`);
    else if (!opts.verify) deps.out(`${writer.writes} write(s); read-back skipped (--no-verify).`);
    else if (errors.length)
      deps.out(`${writer.writes} write(s); read-back skipped because of the errors above.`);
    else if (unverified.length) {
      deps.err(`Read-back: ${unverified.length} change(s) did not land:`);
      for (const u of unverified)
        deps.err(
          `  ${u.space}  ${u.line.verb} ${u.line.what}${u.line.detail ? `  ${u.line.detail}` : ''}`,
        );
    } else deps.out(`${writer.writes} write(s); read back from the API — everything matches.`);
    for (const c of conflicts) deps.err(conflictText(c));
    if (conflicts.length)
      deps.err(
        'Nothing in those spaces was written. Pull the studio change into the file, or re-run with --force to overwrite it.',
      );
  }
  // 5 for a conflict, 1 for anything else that went wrong (FMU-D05).
  if (conflicts.length) return 5;
  return errors.length || unverified.length ? 1 : 0;
}

interface RunCtx extends Omit<PublishOptions, 'manifest' | 'only'> {
  root: string;
  orgId: string;
  only: Selector;
  manifest: Manifest;
  errors: string[];
  purged: Record<string, unknown>[];
  conflicts: StudioConflict[];
  previews: PreviewResult[];
  line: (l: PlanLine) => void;
}

async function runSpace(api: PublishApi, mode: Mode, spec: SpaceSpec, run: RunCtx): Promise<void> {
  const apply = mode === 'apply';
  let live = await api.space(run.orgId, spec.space!);
  if (!live) {
    if (!spec.create)
      throw new Error(
        `no space "${spec.space}" — add \`create: { type: DOCS }\` to the manifest to make it`,
      );
    run.line({
      verb: 'create',
      what: `space ${spec.space}`,
      detail: `${spec.create.type ?? 'DOCS'} "${spec.create.name ?? spec.space}"`,
    });
    if (!apply) {
      // Nothing to read: everything in the folder is a create.
      live = {
        id: '00000000-0000-0000-0000-000000000000',
        slug: spec.space!,
        type: spec.create.type ?? 'DOCS',
        orgId: run.orgId,
      };
    } else {
      const { space } = await api.post<{ space: { id: string; slug: string; type: string } }>(
        `/orgs/${run.orgId}/spaces`,
        {
          name: spec.create.name ?? spec.space,
          slug: spec.space,
          type: spec.create.type ?? 'DOCS',
          ...(spec.create.visibility ? { visibility: spec.create.visibility } : {}),
        },
      );
      live = { ...space, orgId: run.orgId };
    }
  }
  const isNew = live.id === '00000000-0000-0000-0000-000000000000';
  const org = api.opts.authed ? run.orgId : live.orgId;
  const backing = (await api.get<{ spaceType: { backing: string } }>(`/space-types/${live.type}`))
    .spaceType.backing;
  const empty: DocsLive = { collections: [], pages: [], publicRows: new Map() };
  const docsLive =
    backing === 'page' && !isNew
      ? await api.docs(org, live.id)
      : { ...empty, fieldKeys: [] as string[], slots: [] };
  const kind = backing === 'page' ? 'docs' : 'posts';
  const slots = backing === 'page' ? docsLive.slots : [];
  const scan = scanSpace(run.root, spec, kind, { fieldKeys: docsLive.fieldKeys, slots });
  const ctx: SpaceCtx = {
    api,
    org,
    spaceId: live.id,
    type: live.type,
    spec,
    scan,
    root: run.root,
    only: run.only,
    force: run.force && mode !== 'verify',
    prune: run.prune,
    dryRun: !apply,
    line: run.line,
    errors: run.errors,
    slots,
    purge: run.purge,
    purged: run.purged,
  };
  if (mode !== 'verify') {
    for (const s of scan.skipped)
      run.line({ verb: 'skip', what: s.file, detail: `${s.reason} — not content` });
    for (const w of scan.warnings) run.line({ verb: 'warn', what: spec.path || '.', detail: w });
  }
  if (backing !== 'page' && backing !== 'topic' && (scan.posts.length || scan.collections.length))
    run.line({
      verb: 'warn',
      what: spec.space!,
      detail: `a ${live.type} space does not take Markdown pieces — only its manifest settings are applied`,
    });

  if (!isNew) {
    await syncSpace(ctx, apply);
    await syncTheme(ctx, apply);
  }
  if (mode !== 'verify') await warnMissingDescription(ctx, isNew);
  const existingAssets = isNew ? new Map<string, string>() : await api.assets(org, live.id);
  // A plan uploads nothing; it names what a real run would, once per content.
  if (mode === 'plan') {
    const pending = new Map<string, string>();
    for (const [file, refs] of scan.refs) {
      if (!scan.slugByFile.has(file)) continue; // a draft's pictures wait for the post
      for (const abs of refs.values())
        if (!lookupAsset(existingAssets, abs)) pending.set(contentHash(abs), abs);
    }
    for (const abs of pending.values())
      run.line({
        verb: 'upload',
        what: abs.slice(run.root.length + 1) || abs,
        detail: 'new content — uploaded by a real run',
      });
  }
  if (backing === 'topic' && !isNew) await publishPosts(ctx, apply, existingAssets);
  else if (backing === 'topic')
    for (const p of scan.posts)
      run.line({ verb: 'create', what: `post ${p.slug}`, detail: `← ${p.file}` });
  if (!isNew) await syncTags(ctx, apply, existingAssets);
  else if (Object.keys({ ...scan.tags, ...(spec.tags ?? {}) }).length)
    run.line({ verb: 'create', what: 'tags', detail: 'described once the space exists' });

  if (backing === 'page') {
    const openapiCollections = new Set((spec.openapi ?? []).map((o) => o.collection.toLowerCase()));
    let bodies: Map<string, { markdown: string; sections: Record<string, string> }> | null =
      null;
    const bodyOf = async (p: LivePage) => {
      if (!api.opts.authed) {
        const markdown = await api.publicMarkdown(org, live!.id, p.id);
        return markdown === null ? null : { markdown, sections: {} };
      }
      bodies ??= await api.bodiesById(org, live!.id);
      return bodies.get(p.id) ?? null;
    };
    const plan = await planDocs(
      ctx,
      docsLive,
      bodyOf,
      openapiCollections,
      knownUrls(ctx, existingAssets),
    );
    // Studio edits since the last publish, before anything is written (FMU-D18).
    if (api.opts.authed && !isNew && !run.force && mode !== 'verify') {
      const found = await studioConflicts(ctx, plan, docsLive);
      for (const c of found) {
        run.line({ verb: 'conflict', what: `page ${c.slug}`, detail: `edited in studio by ${c.by} at ${c.at}` });
        run.conflicts.push(c);
      }
      if (found.length && apply) {
        run.errors.push(
          `${spec.space}: ${found.length} page(s) edited in the studio since the last publish — nothing written (--force overwrites)`,
        );
        return;
      }
    }
    const metaOf = (id: string) =>
      api.opts.authed ? api.pageMeta(org, live!.id, id) : Promise.resolve(null);
    const bulkOrder = { available: undefined as boolean | undefined };
    if (run.preview !== undefined && mode === 'plan' && !isNew) {
      // FMU-F01: the plan's pages go to a preview instead of the space.
      const sent = await sendPreview(ctx, plan, existingAssets, {
        name: run.preview,
        ttlDays: run.previewTtlDays,
        source: ciSource(process.env),
      });
      if (sent) run.previews.push(sent);
    } else if (!apply) {
      if (mode === 'plan' && api.opts.authed && !isNew) await dryRunImports(ctx, plan);
      await reconcileDocs(
        ctx,
        {
          live: docsLive,
          collectionOf: plan.collectionOf,
          metaOf,
          urlsFor: knownUrls(ctx, existingAssets),
          bulkOrder,
        },
        false,
      );
    } else {
      const urls = await applyDocs(ctx, plan, existingAssets);
      let fresh = await api.docs(org, live.id);
      if (plan.slotWrites.length) {
        await applySlots(ctx, plan, fresh.pages, urls);
        fresh = await api.docs(org, live.id);
      }
      const collectionOf = matchCollections(
        scan.collections,
        fresh.collections,
        spec.rootCollection,
      );
      await reconcileDocs(
        ctx,
        { live: fresh, collectionOf, metaOf, urlsFor: (f) => urls.get(f) ?? new Map(), bulkOrder },
        true,
      );
      await applyPrune(ctx, plan);
    }
    if (mode !== 'verify') {
      const cols = apply ? (await api.docs(org, live.id)).collections : docsLive.collections;
      await syncOpenApi(ctx, apply, run.manifest.file, cols);
    }
  }
  if (!isNew) await syncMonitors(ctx, apply);
  // `redirects:` in the manifest, merged into the space's table (FMU-F09).
  if (!isNew && mode !== 'verify') await syncRedirects(ctx, apply, run.manifest.file);
  // An About page's parts, after its story page has been published.
  if (!isNew) await syncAbout(ctx, apply, run.manifest.file);
  // `--purge space`: one purge of everything under the space, reported (FMU-D04).
  if (apply && run.purge === 'space' && api.opts.authed) {
    const answer = await api.post<Record<string, unknown>>(spacePath(ctx, '/cache/purge'));
    run.purged.push(answer);
  }
}
