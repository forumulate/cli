import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ForumulateClient } from '@forumulate/sdk';
import { PublishApi } from './api';
import { Selector, type SpaceCtx } from './context';
import { matchCollections, planDocs, type DocsLive } from './docs-plan';
import { applyDocs, applyPrune, dryRunImports, knownUrls } from './docs-apply';
import { reconcileDocs } from './docs-reconcile';
import { syncMonitors, syncOpenApi, syncSite, syncSpace, syncTheme } from './extras';
import { findManifest, loadManifest } from './manifest';
import { publishPosts } from './posts';
import { scanSpace } from './scan';
import type { LivePage, Manifest, PlanLine, SpaceSpec } from './types';

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
}

export interface PublishDeps {
  client: ForumulateClient;
  authed: boolean;
  out: (line: string) => void;
  err: (line: string) => void;
  upload?: (path: string, form: FormData) => Promise<unknown>;
  env?: NodeJS.ProcessEnv;
  sleep?: (ms: number) => Promise<void>;
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
  if (!deps.authed && !opts.dryRun) {
    deps.err(
      'Publishing needs a token: `forumulate login`, or FORUMULATE_TOKEN in CI. `--dry-run` works without one against a public space.',
    );
    return 1;
  }

  const only = new Selector(opts.only);
  const lines: { space: string; line: PlanLine }[] = [];
  const errors: string[] = [];
  const print = (space: string) => (l: PlanLine) => {
    lines.push({ space, line: l });
    if (!opts.json && (l.verb !== 'same' || process.env.VERBOSE))
      deps.out(`  ${l.verb.padEnd(7)} ${l.what}${l.detail ? `   ${l.detail}` : ''}`);
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
  if (opts.json) {
    deps.out(
      JSON.stringify(
        { dryRun: opts.dryRun, lines, errors, unverified, writes: writer.writes },
        null,
        2,
      ),
    );
  } else {
    deps.out('');
    const parts = ACTION.map((v) => [v, count(v)] as const)
      .filter(([, n]) => n)
      .map(([v, n]) => `${n} ${v}`);
    deps.out(
      parts.length ? parts.join(', ') : 'Nothing to change — the space already matches the folder.',
    );
    for (const e of errors) deps.err(`error: ${e}`);
    if (opts.dryRun)
      deps.out(
        `--dry-run: nothing was written${deps.authed ? '' : ' (read anonymously: published content only)'}.`,
      );
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
  }
  return errors.length || unverified.length ? 1 : 0;
}

interface RunCtx extends Omit<PublishOptions, 'manifest' | 'only'> {
  root: string;
  orgId: string;
  only: Selector;
  manifest: Manifest;
  errors: string[];
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
      : { ...empty, fieldKeys: [] as string[] };
  const kind = backing === 'page' ? 'docs' : 'posts';
  const scan = scanSpace(run.root, spec, kind, docsLive.fieldKeys);
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
  };
  if (mode !== 'verify')
    for (const w of scan.warnings) run.line({ verb: 'warn', what: spec.path || '.', detail: w });
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
  const existingAssets = isNew ? new Map<string, string>() : await api.assets(org, live.id);
  if (backing === 'topic' && !isNew) await publishPosts(ctx, apply, existingAssets);
  else if (backing === 'topic')
    for (const p of scan.posts)
      run.line({ verb: 'create', what: `post ${p.slug}`, detail: `← ${p.file}` });

  if (backing === 'page') {
    const openapiCollections = new Set((spec.openapi ?? []).map((o) => o.collection.toLowerCase()));
    let markdown: Map<string, string> | null = null;
    const bodyOf = async (p: LivePage) => {
      if (!api.opts.authed) return api.publicMarkdown(org, live!.id, p.id);
      markdown ??= await api.markdownById(org, live!.id);
      return markdown.get(p.id) ?? null;
    };
    const plan = await planDocs(ctx, docsLive, bodyOf, openapiCollections);
    const metaOf = (id: string) =>
      api.opts.authed ? api.pageMeta(org, live!.id, id) : Promise.resolve(null);
    const bulkOrder = { available: undefined as boolean | undefined };
    if (!apply) {
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
      const fresh = await api.docs(org, live.id);
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
}
