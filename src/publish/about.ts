import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { differingKeys } from './compare';
import { spacePath, type SpaceCtx } from './context';

/**
 * `about:` in forumulate.yaml — an About page's parts, as content-as-code.
 *
 *     spaces:
 *       - path: about
 *         space: about
 *         create: { type: ABOUT, name: About }
 *         about:
 *           mission: Make work lighter.
 *           values: [{ title: Ship small }, { title: Write it down }]
 *           team: { source: authors, keys: [ada, grace], founders: [ada] }
 *           company: { legalName: Acme Software GmbH, vatId: DE123456789 }
 *
 * or `about: about.yaml` (a file beside the manifest holding the same map).
 * The folder's own Markdown is the story page, published like any page. Only
 * the top-level keys that differ from what the space holds are sent, through
 * `PUT …/about` (PATCH semantics), so a re-run that changes nothing writes
 * nothing; `null` in the manifest clears a part. Every reference is checked by
 * the API, and a 422 names the key.
 */
export async function syncAbout(
  ctx: SpaceCtx,
  apply: boolean,
  manifestFile: string | null,
): Promise<void> {
  const raw = ctx.spec.about;
  if (raw === undefined || !ctx.only.part('about', ctx.spec)) return;
  if (ctx.type !== 'ABOUT') {
    ctx.errors.push(`about: belongs on an ABOUT space; ${ctx.spec.space} is ${ctx.type}`);
    return;
  }
  let want: Record<string, unknown>;
  if (typeof raw === 'string') {
    const abs = resolve(manifestFile ? dirname(manifestFile) : ctx.root, raw);
    const text = readFileSync(abs, 'utf8');
    const parsed: unknown = /\.json$/i.test(abs) ? JSON.parse(text) : parseYaml(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      ctx.errors.push(`about: ${raw} must hold a map of About parts`);
      return;
    }
    want = parsed as Record<string, unknown>;
  } else want = raw;
  if (!ctx.api.opts.authed) {
    ctx.line({
      verb: 'patch',
      what: 'about',
      detail: `${Object.keys(want).join(', ')} — cannot compare without a token`,
    });
    return;
  }
  const current = await ctx.api.get<Record<string, unknown>>(spacePath(ctx, '/about'));
  const keys = differingKeys(current, want);
  if (!keys.length) return;
  ctx.line({ verb: 'patch', what: 'about', detail: keys.join(', ') });
  if (apply)
    await ctx.api.put(
      spacePath(ctx, '/about'),
      Object.fromEntries(keys.map((k) => [k, want[k]])),
    );
}
