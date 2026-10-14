import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { differingKeys, holds } from './compare';
import { spacePath, type SpaceCtx } from './context';
import type { PublishApi } from './api';
import type { LiveCollection, PlanLine, SiteSpec } from './types';

/**
 * The manifest's other half: everything about a space that is not a page.
 *
 * Each of these is compared before it is written, the way pages are: a PATCH
 * of a theme that already holds every key is a write with nothing in it, and a
 * publisher that writes on every run cannot tell anybody what changed.
 */

/** `settings`, `name`, `visibility`: `PATCH /orgs/{o}/spaces/{s}` merges settings at the top level. */
export async function syncSpace(ctx: SpaceCtx, apply: boolean): Promise<void> {
  const { spec } = ctx;
  if (!ctx.only.part('settings', spec) || (!spec.settings && !spec.name && !spec.visibility))
    return;
  if (!ctx.api.opts.authed) {
    ctx.line({ verb: 'patch', what: 'space settings', detail: 'cannot compare without a token' });
    return;
  }
  const { space } = await ctx.api.get<{
    space: { name: string; visibility: string; settings: Record<string, unknown> };
  }>(spacePath(ctx, ''));
  const body: Record<string, unknown> = {};
  if (spec.name && spec.name !== space.name) body.name = spec.name;
  if (spec.visibility && spec.visibility !== space.visibility) body.visibility = spec.visibility;
  const keys = spec.settings ? differingKeys(space.settings, spec.settings) : [];
  if (keys.length) body.settings = Object.fromEntries(keys.map((k) => [k, spec.settings![k]]));
  if (!Object.keys(body).length) return;
  ctx.line({
    verb: 'patch',
    what: 'space',
    detail: [
      ...Object.keys(body).filter((k) => k !== 'settings'),
      ...keys.map((k) => `settings.${k}`),
    ].join(', '),
  });
  if (apply) await ctx.api.patch(spacePath(ctx, ''), body);
}

/** `theme`: `PATCH …/theme` deep-merges, so only the differing top-level keys are sent. */
export async function syncTheme(ctx: SpaceCtx, apply: boolean): Promise<void> {
  const want = ctx.spec.theme;
  if (!want || !ctx.only.part('theme', ctx.spec)) return;
  let current: Record<string, unknown> | undefined;
  if (ctx.api.opts.authed)
    current = (await ctx.api.get<{ theme: Record<string, unknown> }>(spacePath(ctx, '/theme')))
      .theme;
  else {
    const r = await ctx.api
      .get<{ theme?: Record<string, unknown> }>(`/public/orgs/${ctx.org}/spaces/${ctx.spaceId}`)
      .catch(() => ({ theme: undefined }));
    current = r.theme;
  }
  const keys = differingKeys(current, want);
  if (!keys.length) return;
  ctx.line({ verb: 'patch', what: 'theme', detail: keys.join(', ') });
  if (apply)
    await ctx.api.patch(
      spacePath(ctx, '/theme'),
      Object.fromEntries(keys.map((k) => [k, want[k]])),
    );
}

/**
 * `openapi`: an API reference from a spec file or URL, through the importer
 * that builds it atomically and converges when re-run against a changed spec.
 * The collection it lands in is found by name, or created.
 */
export async function syncOpenApi(
  ctx: SpaceCtx,
  apply: boolean,
  manifestFile: string | null,
  collections: LiveCollection[],
): Promise<void> {
  if (!ctx.only.part('openapi', ctx.spec)) return;
  for (const entry of ctx.spec.openapi ?? []) {
    const { spec: file, url, collection, ...rest } = entry;
    let spec: unknown;
    if (file) {
      const abs = resolve(manifestFile ? dirname(manifestFile) : ctx.root, file);
      const text = readFileSync(abs, 'utf8');
      spec = /\.json$/i.test(abs) ? JSON.parse(text) : parseYaml(text);
    }
    const target = collections.find(
      (c) => c.name.toLowerCase() === collection.toLowerCase() || c.slug === collection,
    );
    const what = `openapi ${file ?? url} → "${collection}"`;
    if (!ctx.api.opts.authed) {
      ctx.line({
        verb: 'import',
        what,
        detail: target ? 'replace (not compared without a token)' : 'into a new collection',
      });
      continue;
    }
    const body = {
      ...rest,
      ...(spec ? { spec } : { url }),
      onExisting: (rest.onExisting as string) ?? 'replace',
    };
    if (!apply) {
      if (!target) {
        ctx.line({ verb: 'import', what, detail: 'into a new collection' });
        continue;
      }
      // The importer's own dry run: writes nothing, reports collisions first.
      const r = await ctx.api.opts.client.request<{
        created: number;
        replaced: number;
        collisions?: string[];
      }>('POST', spacePath(ctx, '/docs/openapi/import'), {
        body: { ...body, collectionId: target.id, dryRun: true },
      });
      ctx.line({
        verb: 'import',
        what,
        detail: `${r.created} new, ${r.replaced} replaced${r.collisions?.length ? `, collisions: ${r.collisions.join(', ')}` : ''}`,
      });
      continue;
    }
    const id =
      target?.id ??
      (
        await ctx.api.post<{ collection: LiveCollection }>(spacePath(ctx, '/collections'), {
          name: collection,
        })
      ).collection.id;
    const r = await ctx.api.post<{ created: number; replaced: number; warnings?: string[] }>(
      spacePath(ctx, '/docs/openapi/import'),
      { ...body, collectionId: id },
    );
    ctx.line({ verb: 'import', what, detail: `${r.created} new, ${r.replaced} replaced` });
    for (const w of r.warnings ?? []) ctx.line({ verb: 'warn', what, detail: w });
  }
}

/** `monitors`: matched by name; created, patched where they differ, pruned with `--prune`. */
export async function syncMonitors(ctx: SpaceCtx, apply: boolean): Promise<void> {
  const want = ctx.spec.monitors;
  if (!want || !ctx.only.part('monitors', ctx.spec)) return;
  if (ctx.type !== 'STATUS') {
    ctx.errors.push(`monitors belong on a STATUS space; ${ctx.spec.space} is ${ctx.type}`);
    return;
  }
  if (!ctx.api.opts.authed) {
    ctx.line({
      verb: 'patch',
      what: 'monitors',
      detail: `${want.length} declared — cannot compare without a token`,
    });
    return;
  }
  const live = await ctx.api.all<
    Record<string, unknown> & { id: string; name: string; requestHeaderNames?: string[] }
  >(spacePath(ctx, '/status/monitors'), 'monitors', { limit: 500 });
  const byName = new Map(live.map((m) => [m.name, m]));
  for (const m of want) {
    const name = String(m.name);
    const current = byName.get(name);
    if (!current) {
      ctx.line({ verb: 'create', what: `monitor ${name}`, detail: String(m.url ?? m.kind ?? '') });
      if (apply) await ctx.api.post(spacePath(ctx, '/status/monitors'), m);
      continue;
    }
    // Header VALUES are write-only (the API answers with their names), so a
    // monitor is compared on the names and re-sent only when those differ.
    const comparable = { ...m };
    const headers = comparable.requestHeaders as Record<string, string> | undefined;
    delete comparable.requestHeaders;
    const keys = differingKeys(current, comparable);
    if (
      headers &&
      !holds([...(current.requestHeaderNames ?? [])].sort(), Object.keys(headers).sort())
    )
      keys.push('requestHeaders');
    if (!keys.length) continue;
    ctx.line({ verb: 'patch', what: `monitor ${name}`, detail: keys.join(', ') });
    if (apply)
      await ctx.api.patch(
        spacePath(ctx, `/status/monitors/${current.id}`),
        Object.fromEntries(keys.map((k) => [k, m[k]])),
      );
  }
  if (!ctx.prune || !ctx.only.all) return;
  const declared = new Set(want.map((m) => String(m.name)));
  for (const m of live) {
    if (declared.has(m.name)) continue;
    ctx.line({
      verb: 'prune',
      what: `monitor ${m.name}`,
      detail: 'not in the manifest — its history goes with it',
    });
    if (apply) await ctx.api.del(spacePath(ctx, `/status/monitors/${m.id}`));
  }
}

/** `site`: `PATCH /orgs/{o}/sites/{id}` deep-merges `config`, so only differing keys are sent. */
export async function syncSite(
  api: PublishApi,
  org: string,
  site: SiteSpec,
  apply: boolean,
  line: (l: PlanLine) => void,
): Promise<void> {
  if (!api.opts.authed) {
    line({
      verb: 'patch',
      what: `site ${site.slug ?? site.id}`,
      detail: 'cannot compare without a token',
    });
    return;
  }
  const sites = await api.all<{
    id: string;
    slug: string;
    name: string;
    config: Record<string, unknown>;
  }>(`/orgs/${org}/sites`, 'sites', { limit: 500 });
  const live = sites.find((s) => s.id === site.id || s.slug === site.slug);
  if (!live)
    throw new Error(
      `No site "${site.slug ?? site.id}" in this organization (it has: ${sites.map((s) => s.slug).join(', ') || 'none'})`,
    );
  const body: Record<string, unknown> = {};
  if (site.name && site.name !== live.name) body.name = site.name;
  const keys = site.config ? differingKeys(live.config, site.config) : [];
  if (keys.length) body.config = Object.fromEntries(keys.map((k) => [k, site.config![k]]));
  if (!Object.keys(body).length) return;
  line({
    verb: 'patch',
    what: `site ${live.slug}`,
    detail: [...(body.name ? ['name'] : []), ...keys.map((k) => `config.${k}`)].join(', '),
  });
  if (apply) await api.patch(`/orgs/${org}/sites/${live.id}`, body);
}
