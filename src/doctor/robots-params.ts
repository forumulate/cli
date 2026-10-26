import type { Check } from '../conformance';
import { check } from './probe';

/**
 * `robots-params`: the `Disallow` lines that keep crawlers off the re-cut
 * addresses of a mounted space's lists (SEO spec §1, item 5).
 *
 * A reader page offers its sort, order, scope, period, filter, solved and
 * range choices as GET forms, which crawlers do not submit — but an address
 * already in a crawler's queue, a backlink, or another site's
 * `?sort=name&order=desc` link still reaches it. Those copies say `noindex`
 * (or name the uncut page as canonical), and are still a crawl each. The host's
 * robots.txt is the one place that can say "do not even fetch these", and for
 * a space mounted on somebody else's domain (`acme.com/community`) it is THEIR
 * file — we cannot write it. So the doctor prints the lines to paste.
 *
 * Advisory, never a failure: a site that wants those copies crawled is making
 * a choice. Passes once every line for this host is already in its robots.txt.
 * Judged by HTTP alone, so it is the same for any host the doctor is pointed at.
 */

/**
 * The query keys a reader list is re-cut by — the web reader's
 * `VARIANT_PARAMS` (apps/web/src/lib/reader-variant-robots.ts). Never `page`
 * (a page of a list is a document of its own) and never a search.
 */
export const VARIANT_PARAMS = [
  'sort',
  'order',
  'scope',
  'period',
  'window',
  'filter',
  'solved',
  'range',
  'replies',
  'release',
] as const;

/**
 * The lines for one mount. `*` and the `?` are robots wildcards (RFC 9309 §2.2.3
 * — Google, Bing and every major crawler read them): `/community*?*sort=` is any
 * address under the mount whose query names `sort`, first or not.
 */
export function disallowLines(mountPath: string): string[] {
  const mount = mountPath.replace(/\/+$/, '');
  const at = mount ? `${mount}*` : '/*';
  return VARIANT_PARAMS.map((p) => `Disallow: ${at}?*${p}=`);
}

/** The roots grouped by the origin whose robots.txt would carry them. */
export function linesByOrigin(roots: readonly string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const root of roots) {
    let u: URL;
    try {
      u = new URL(root);
    } catch {
      continue;
    }
    const list = out.get(u.origin) ?? [];
    for (const l of disallowLines(u.pathname)) if (!list.includes(l)) list.push(l);
    out.set(u.origin, list);
  }
  return out;
}

/** Does robots.txt already say `line` (any case, any spacing after the colon)? */
function has(robots: string, line: string): boolean {
  const want = line.replace(/^disallow:\s*/i, '').trim();
  return robots
    .split(/\r?\n/)
    .some((l) => /^\s*disallow:/i.test(l) && l.replace(/^\s*disallow:\s*/i, '').trim() === want);
}

export function robotsParams(
  roots: readonly string[],
  /** The origin whose robots.txt was read. */
  origin: string,
  robots: string | undefined,
): Check {
  const title = "robots.txt keeps crawlers off a space's sorted and filtered copies";
  const byOrigin = linesByOrigin(roots);
  if (!byOrigin.size)
    return check('robots-params', title, 'skip', 'No space root to suggest lines for.', '');
  const ownLines = byOrigin.get(origin) ?? [];
  const missing = robots === undefined ? ownLines : ownLines.filter((l) => !has(robots, l));
  const others = [...byOrigin].filter(([o]) => o !== origin);
  if (!missing.length && !others.length)
    return check('robots-params', title, 'pass', `All ${ownLines.length} lines are in ${origin}/robots.txt.`, '');
  const block = (o: string, lines: string[]) =>
    [`# ${o}/robots.txt`, 'User-agent: *', ...lines].map((l) => `  ${l}`).join('\n');
  const parts = [
    ...(missing.length ? [block(origin, missing)] : []),
    ...others.map(([o, lines]) => block(o, lines)),
  ];
  return check(
    'robots-params',
    title,
    'skip',
    `Suggested — add to the host's robots.txt (the pages already say noindex or name their canonical; this saves the crawl):\n${parts.join('\n')}`,
    "Every sorted, scoped or filtered copy of a list is a fetch a crawler spends instead of a page that can rank.",
  );
}
