import type { Check } from '../conformance';
import {
  canonicalOf,
  check,
  describeProbe,
  hostOf,
  pool,
  sameUrl,
  some,
  type Get,
  type Probe,
} from './probe';

/**
 * `sitemap-crawl`: every address the site hands a crawler, fetched.
 *
 * The sitemap is the list a search engine trusts most, so an entry that
 * redirects, 404s, names a different canonical or sits on another host is a
 * page the site is asking to have indexed and then refusing to be. A space root
 * that 307s to its first page was listed as itself (FMU-B06); a platform copy
 * that 308s elsewhere named itself canonical (FMU-B01). Each is invisible from
 * the page a person happens to open, and obvious once every listed URL is asked.
 *
 * The pages fetched here are also the SAMPLE the other site-wide checks judge
 * (cache headers, descriptions), so the crawl is done once.
 */

/** How many sitemap documents (index included) one run will read. */
const SITEMAP_DOC_LIMIT = 25;

export interface CrawlResult {
  check: Check;
  /** Every listed URL that was fetched, with its answer. */
  pages: Probe[];
}

/** `Sitemap:` lines of robots.txt, else the conventional address. */
export function sitemapsFromRobots(robots: string, origin: string): string[] {
  const named = [...robots.matchAll(/^\s*sitemap:\s*(\S+)/gim)].map((m) => m[1]!);
  return named.length ? named : [`${origin}/sitemap.xml`];
}

function locs(xml: string): string[] {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) =>
    m[1]!.replace(/&amp;/g, '&'),
  );
}

/**
 * Read sitemaps (following a sitemap index), returning the URL lists per
 * document, so the sample can draw from every space rather than exhaust the
 * first one: a site with a 900-page reference and a 4-page legal space would
 * otherwise never have its legal pages looked at.
 */
export async function readSitemaps(
  get: Get,
  start: string[],
): Promise<{ lists: { sitemap: string; urls: string[] }[]; problems: string[] }> {
  const lists: { sitemap: string; urls: string[] }[] = [];
  const problems: string[] = [];
  const queue = [...new Set(start)];
  const seen = new Set<string>();
  while (queue.length && seen.size < SITEMAP_DOC_LIMIT) {
    const url = queue.shift()!;
    if (seen.has(url)) continue;
    seen.add(url);
    const p = await get(url, { accept: 'application/xml,text/xml' });
    if (!p.ok || p.status !== 200) {
      problems.push(`${url} → ${describeProbe(p)}`);
      continue;
    }
    if (/<sitemapindex\b/i.test(p.text)) queue.push(...locs(p.text));
    else lists.push({ sitemap: url, urls: locs(p.text) });
  }
  return { lists, problems };
}

/** Up to `limit` URLs, round-robin across the sitemaps so every space is represented. */
export function sample(lists: { urls: string[] }[], limit: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; out.length < limit; i++) {
    let any = false;
    for (const l of lists) {
      const u = l.urls[i];
      if (u === undefined) continue;
      any = true;
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
        if (out.length >= limit) break;
      }
    }
    if (!any) break;
  }
  return out;
}

export async function sitemapCrawl(
  get: Get,
  origin: string,
  robots: string | undefined,
  limit: number,
): Promise<CrawlResult> {
  const title = 'Every URL in the sitemap answers 200, as itself';
  const matters =
    'A sitemap entry that redirects, 404s or names another canonical is a page the site asks to have indexed and then disowns; search engines lower their trust in the whole list.';
  const { lists, problems } = await readSitemaps(get, sitemapsFromRobots(robots ?? '', origin));
  if (lists.length === 0) {
    return {
      check: check(
        'sitemap-crawl',
        title,
        'fail',
        problems.length ? `No sitemap could be read: ${some(problems)}` : 'No sitemap found.',
        matters,
      ),
      pages: [],
    };
  }
  const total = lists.reduce((n, l) => n + l.urls.length, 0);
  const urls = sample(lists, limit);
  const siteHost = hostOf(origin);
  const pages = await pool(urls, 6, (u) => get(u, { accept: 'text/html' }));
  const bad: string[] = [...problems];
  for (const p of pages) {
    if (hostOf(p.url) !== siteHost) {
      bad.push(`${p.url} is on another host than the sitemap (${siteHost})`);
      continue;
    }
    if (!p.ok) {
      bad.push(`${p.url} → ${p.error}`);
      continue;
    }
    if (p.status >= 300 && p.status < 400) {
      bad.push(`${p.url} → ${p.status} ${p.headers.get('location') ?? ''} (list the final URL)`);
      continue;
    }
    if (p.status !== 200) {
      bad.push(`${p.url} → ${p.status}`);
      continue;
    }
    const canonical = canonicalOf(p.text, p.url);
    if (canonical && !sameUrl(canonical, p.url)) bad.push(`${p.url} names canonical ${canonical}`);
  }
  const scope = `${pages.length} of ${total} listed URL${total === 1 ? '' : 's'} across ${lists.length} sitemap${lists.length === 1 ? '' : 's'}`;
  return {
    check: check(
      'sitemap-crawl',
      title,
      bad.length ? 'fail' : 'pass',
      bad.length
        ? `${bad.length} problem(s) in ${scope}: ${some(bad)}`
        : `${scope}: all 200, all self-canonical.`,
      bad.length ? matters : '',
    ),
    pages,
  };
}

/**
 * The space a URL belongs to, for grouping: its first path segment, which is
 * where a path-mounted space lives (`/docs`, `/legal`). Pages at the root of a
 * site domain group together under `/`. Coarse, and that is fine — a
 * difference between two spaces is a choice; a difference inside one is what
 * this is looking for.
 */
export function groupOf(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split('/').filter(Boolean);
    // A short reader prefix followed by owner and space (`/p/<org>/<space>/…`)
    // is how a multi-tenant host addresses a space; grouping by `/p` alone
    // would compare every tenant's pages with every other's.
    if (segs.length >= 4 && segs[0]!.length <= 3) return `${u.host}/${segs.slice(0, 3).join('/')}`;
    return `${u.host}/${segs[0] ?? ''}`;
  } catch {
    return url;
  }
}

/** `public` (a shared cache may keep it) or `private` (it may not), by the directives that decide it. */
export function cacheClass(cc: string | null): 'public' | 'private' | 'none' {
  if (!cc) return 'none';
  if (/\b(?:private|no-store)\b/i.test(cc)) return 'private';
  if (/\b(?:public|s-maxage)\b/i.test(cc)) return 'public';
  return 'private';
}

/** Headers a site may send to say a page is uncached on purpose (and why). */
const REASON_HEADERS = ['x-forumulate-cache-reason', 'x-cache-reason', 'x-cache-control-reason'];

/**
 * `cache-consistency`: the pages of one space are cached the same way.
 *
 * Every legal document answered `private, no-cache, no-store` to a reader with
 * no cookie at all, while the legal index beside it was `public, s-maxage=10`
 * (FMU-B05). Neither header is wrong on its own; the difference is the defect —
 * either something is gated and should say so, or a code path forgot the
 * public header and every reader pays a full origin render. A page that sends
 * a reason header is taken at its word.
 */
export function cacheConsistency(pages: Probe[]): Check {
  const title = 'Pages within a space are cached alike';
  const groups = new Map<string, { url: string; cls: string; cc: string }[]>();
  for (const p of pages) {
    if (!p.ok || p.status !== 200) continue;
    if (REASON_HEADERS.some((h) => p.headers.get(h))) continue;
    const cc = p.headers.get('cache-control');
    const g = groupOf(p.url);
    groups.set(g, [
      ...(groups.get(g) ?? []),
      { url: p.url, cls: cacheClass(cc), cc: cc ?? '(none)' },
    ]);
  }
  if (groups.size === 0)
    return check('cache-consistency', title, 'skip', 'No sampled pages answered 200.', '');
  const odd: string[] = [];
  for (const [g, rows] of groups) {
    const classes = [...new Set(rows.map((r) => r.cls))];
    if (classes.length < 2) continue;
    // Every side of the split is named. Which side is the bug is the site's
    // call (usually the private one — a published page has no reason to be),
    // and a "majority" of three legal documents is evidence of nothing.
    const sides = classes.map((cls) => {
      const of = rows.filter((r) => r.cls === cls);
      return `${of.length} ${cls} ("${of[0]!.cc}": ${some(
        of.map((r) => r.url),
        3,
      )})`;
    });
    odd.push(`${g}: ${sides.join(' vs ')}`);
  }
  return check(
    'cache-consistency',
    title,
    odd.length ? 'fail' : 'pass',
    odd.length
      ? some(odd)
      : `${[...groups.values()].reduce((n, r) => n + r.length, 0)} pages in ${groups.size} space(s), one rule each.`,
    odd.length
      ? 'A published page answering no-store to an anonymous reader is rendered at the origin for every visit. If it is gated on purpose, say so with an x-forumulate-cache-reason header.'
      : '',
  );
}
