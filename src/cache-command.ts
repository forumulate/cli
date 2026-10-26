import { flag, has, parseArgs } from './api/args';
import { setting } from './commands/config';
import { isUuid, resolveChild, type CommandDeps } from './commands/context';
import { EXIT, EXIT_CODES_HELP } from './exit-codes';

/**
 * `forumulate cache purge` — the cache, and only the cache (FMU-B04).
 *
 * "Purge" in this API meant three things: a page's permanent deletion, a
 * space's permanent deletion, and a cache flush filed under Consent. The CLI
 * now has one verb for the flush, calling the `Cache_*` operations; deleting
 * for good is `spaces destroy` / `items destroy` and asks for the slug.
 */
export const CACHE_HELP = `forumulate cache — drop cached copies of published pages

Usage:
  forumulate cache purge --space <id|slug> [--page <id|slug>] [--org <id|slug>] [--json]
  forumulate cache purge --org <id|slug> --all-spaces [--json]

  Drops cached copies — our web tier and every CDN the org has configured
  (Cloudflare, Fastly, Bunny, KeyCDN, or a purge webhook) — and prints which
  addresses went and which CDN took them (\`edge: none\` when no CDN fronts them).
  NOTHING IS DELETED: content, drafts and history are untouched. To delete a
  trashed page or space for good, see \`forumulate items destroy\` /
  \`forumulate spaces destroy\`.

  --page          one page (its slug and id addresses on every domain)
  --space         the whole space: every page, locale variant and old address
  --all-spaces    every space in the org (with --org)

Examples:
  forumulate cache purge --space docs
  forumulate cache purge --space docs --page getting-started --json

${EXIT_CODES_HELP}`;

interface PurgeAnswer {
  purged: string;
  urls?: string[];
  urlCount?: number;
  edge?: string;
  edges?: { name: string; account: string; urls: number; ok: boolean; error?: string }[];
  webTier?: boolean;
}

export async function runCache(argv: string[], deps: CommandDeps): Promise<number> {
  const p = parseArgs(argv, new Set(['json', 'help', 'all-spaces']));
  const [verb] = p.positionals;
  if (has(p, 'help') || !verb) {
    deps.out(CACHE_HELP);
    return verb || has(p, 'help') ? EXIT.OK : EXIT.USAGE;
  }
  if (verb !== 'purge') {
    deps.err(`Unknown cache verb "${verb}". Usage: forumulate cache purge --space <id|slug> [--page …]`);
    return EXIT.USAGE;
  }
  const org = setting('org', flag(p, 'org'), deps.env, deps.config);
  if (!org) {
    deps.err('Which organization? Pass --org, set FORUMULATE_ORG, or `forumulate config set org …`.');
    return EXIT.USAGE;
  }
  const spaceRef = setting('space', flag(p, 'space'), deps.env, deps.config);
  const pageRef = flag(p, 'page');
  let path: string;
  if (has(p, 'all-spaces') && !flag(p, 'space')) path = `/orgs/${encodeURIComponent(org)}/cache/purge`;
  else {
    if (!spaceRef) {
      deps.err('Which space? Pass --space <id|slug> (or --all-spaces for the whole org).');
      return EXIT.USAGE;
    }
    const spaceId = await resolveChild(deps, 'space', org, spaceRef);
    const base = `/orgs/${encodeURIComponent(org)}/spaces/${spaceId}`;
    path = pageRef ? `${base}/pages/${await pageId(deps, base, pageRef)}/cache/purge` : `${base}/cache/purge`;
  }
  const res = await deps.http.send({ method: 'POST', path });
  const answer = res.data as PurgeAnswer;
  if (has(p, 'json')) {
    deps.out(JSON.stringify(answer, null, 2));
    return EXIT.OK;
  }
  deps.out(
    `Purged ${answer.purged}: ${answer.urlCount ?? answer.urls?.length ?? 0} address(es), edge ${answer.edge ?? 'none'}${answer.webTier ? ', web tier refreshed' : ''}.`,
  );
  for (const e of answer.edges ?? [])
    deps.out(`  ${e.ok ? 'ok    ' : 'FAILED'} ${e.name} (${e.account}) ${e.urls} url(s)${e.error ? ` — ${e.error}` : ''}`);
  if ((answer.edge ?? 'none') === 'none')
    deps.err('No CDN fronts these addresses (or none is configured): only our web tier was refreshed.');
  return (answer.edges ?? []).some((e) => !e.ok) ? EXIT.FAILED : EXIT.OK;
}

/** A page id from an id or a slug, looked up in the space's page list. */
async function pageId(deps: CommandDeps, base: string, ref: string): Promise<string> {
  if (isUuid(ref)) return ref;
  const res = await deps.http.send({ method: 'GET', path: `${base}/pages`, query: { limit: '1000' } });
  const body = res.data as { pages?: { id: string; slug: string }[]; data?: { id: string; slug: string }[] };
  const hit = (body.pages ?? body.data ?? []).find((r) => r.slug === ref);
  if (!hit) throw Object.assign(new Error(`No page "${ref}" in this space.`), { status: 404 });
  return hit.id;
}
