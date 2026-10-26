import type { Check } from '../conformance';
import { descriptionProblem, isPresetDescription } from './boilerplate';
import {
  attr,
  canonicalOf,
  check,
  describeProbe,
  hostOf,
  metaOf,
  sameUrl,
  some,
  tags,
  type Get,
  type Probe,
} from './probe';

/** A redirect needs a Location and nothing else; more than this is a page nobody sees. */
const REDIRECT_BODY_LIMIT = 1024;

/**
 * `root-redirect`: a space's root either renders or moves permanently, cheaply.
 *
 * `GET /docs` answered `307` with a 66 KB HTML body and a canonical naming
 * `/docs` (FMU-B06). A 307 says "this is temporary, keep asking me", so a
 * crawler keeps the root as the indexed URL and never settles on the page it
 * lands on; the body is bytes every visitor downloads and throws away. A 301
 * or 308 with an empty body, or the front page rendered in place, are both fine.
 */
export async function rootRedirect(get: Get, roots: string[]): Promise<Check> {
  const title = 'Space roots render, or redirect permanently with no body';
  const matters =
    'A temporary (302/307) redirect keeps the root as the indexed address and the destination as a guest; a heavy redirect body is downloaded by every visitor and shown to none.';
  const bad: string[] = [];
  const good: string[] = [];
  for (const root of [...new Set(roots)]) {
    const p = await get(root, { accept: 'text/html' });
    if (!p.ok) {
      bad.push(`${root} → ${p.error}`);
      continue;
    }
    if (p.status === 200) {
      good.push(`${root} renders`);
      continue;
    }
    if (p.status < 300 || p.status >= 400) {
      bad.push(`${root} → ${p.status}`);
      continue;
    }
    const to = p.headers.get('location') ?? '';
    const bytes = Buffer.byteLength(p.text);
    const problems: string[] = [];
    if (p.status !== 301 && p.status !== 308) problems.push(`${p.status} is temporary`);
    if (bytes > REDIRECT_BODY_LIMIT) problems.push(`${bytes}-byte body`);
    if (to) {
      const target = new URL(to, root).toString();
      const landed = await get(target, { accept: 'text/html' });
      const canonical = landed.ok ? canonicalOf(landed.text, target) : undefined;
      if (canonical && !sameUrl(canonical, target))
        problems.push(`its target ${target} names canonical ${canonical}`);
    }
    if (problems.length) bad.push(`${root} → ${p.status} ${to}: ${problems.join(', ')}`);
    else good.push(`${root} → ${p.status} ${to}`);
  }
  if (bad.length === 0 && good.length === 0)
    return check('root-redirect', title, 'skip', 'No space root to check.', '');
  return check(
    'root-redirect',
    title,
    bad.length ? 'fail' : 'pass',
    bad.length ? some(bad) : some(good),
    bad.length ? matters : '',
  );
}

/**
 * `meta-description`: every page says what it is, in words somebody wrote.
 *
 * Checked across the crawl sample, not just the page given, because the
 * preset fallbacks live on the pages nobody opens while testing — a space
 * index, a blog home, a generated reference landing (FMU-B08, FMU-B09).
 */
export function metaDescription(pages: Probe[]): Check {
  const title = 'Pages carry a real meta and og:description';
  const html = pages.filter((p): p is Extract<Probe, { ok: true }> => p.ok && p.status === 200);
  if (html.length === 0)
    return check('meta-description', title, 'skip', 'No page answered 200 to read.', '');
  const bad: string[] = [];
  for (const p of html) {
    const meta = descriptionProblem(metaOf(p.text, 'description'));
    const og = descriptionProblem(metaOf(p.text, 'og:description'));
    if (meta) bad.push(`${p.url}: description ${meta}`);
    else if (og) bad.push(`${p.url}: og:description ${og}`);
  }
  return check(
    'meta-description',
    title,
    bad.length ? 'fail' : 'pass',
    bad.length
      ? `${bad.length} of ${html.length}: ${some(bad)}`
      : `${html.length} page(s) described.`,
    bad.length
      ? 'The description is what a search result and every link preview show. A missing one is chosen by the crawler; a template sentence tells the reader nothing about this page.'
      : '',
  );
}

const IMAGE_TYPE = /^image\/|^application\/octet-stream/i;

/**
 * `favicon`: the icons the page and the host advertise are images.
 *
 * `GET /docs/favicon.ico` on a customer's domain answered a 404 with a 104 KB
 * HTML page (FMU-B17). Browsers, feed readers and link unfurlers ask for these
 * addresses on their own; a 100 KB error page per ask is load, and a missing
 * icon is a blank tab. An asset-shaped path that is not there should be a tiny
 * 404, not the site's whole not-found page.
 */
export async function favicon(
  get: Get,
  pageUrl: string,
  html: string,
  roots: string[],
): Promise<Check> {
  const title = 'The favicon resolves to an image';
  const origin = new URL(pageUrl).origin;
  const declared = tags(html, 'link')
    .filter((t) => /\bicon\b/i.test(attr(t, 'rel') ?? ''))
    .map((t) => attr(t, 'href'))
    .filter((h): h is string => !!h)
    .map((h) => new URL(h, pageUrl).toString());
  const required = [...new Set([`${origin}/favicon.ico`, ...declared])];
  // Under a mount the host's own favicon is the customer's, but the mount's
  // asset paths are ours: they must at least not answer with a page.
  const mounted = [...new Set(roots.map((r) => `${r.replace(/\/+$/, '')}/favicon.ico`))].filter(
    (u) => !required.includes(u),
  );
  const bad: string[] = [];
  for (const url of required) {
    const p = await get(url, { accept: 'image/*' });
    const type = p.ok ? (p.headers.get('content-type') ?? '') : '';
    if (!p.ok || p.status !== 200 || !IMAGE_TYPE.test(type))
      bad.push(
        `${url} → ${describeProbe(p)}${type ? ` ${type}` : ''}${p.ok ? ` (${Buffer.byteLength(p.text)} bytes)` : ''}`,
      );
  }
  for (const url of mounted) {
    const p = await get(url, { accept: 'image/*' });
    if (!p.ok) continue;
    const type = p.headers.get('content-type') ?? '';
    const bytes = Buffer.byteLength(p.text);
    if (p.status === 200 && IMAGE_TYPE.test(type)) continue;
    if (/html/i.test(type) && bytes > 2048)
      bad.push(`${url} → ${p.status} with a ${bytes}-byte HTML page`);
  }
  return check(
    'favicon',
    title,
    bad.length ? 'fail' : 'pass',
    bad.length ? some(bad) : `${required.length + mounted.length} icon address(es) answered.`,
    bad.length
      ? 'Browsers and link previews fetch the icon on their own; an HTML error page in its place is a blank tab and wasted bytes on every request.'
      : '',
  );
}

/** `Title (some-slug)`: the generator disambiguated two titles with a slug a reader never sees. */
const SLUG_LEAK = /\[[^\]]*\(([a-z0-9]+(?:-[a-z0-9]+)+)\)\]/;

/** One llms.txt judged against the llmstxt.org shape. */
export function llmsProblems(text: string, url: string, platformHost?: string): string[] {
  const lines = text.split(/\r?\n/);
  const first = lines.find((l) => l.trim());
  const out: string[] = [];
  if (!first || !/^#\s+\S/.test(first)) out.push('does not open with an H1 title');
  const quote = lines.find((l) => /^>\s*/.test(l));
  const summary = quote?.replace(/^>\s*/, '').trim();
  if (summary && isPresetDescription(summary)) out.push(`summary is preset text "${summary}"`);
  const links = [...text.matchAll(/^\s*[-*]\s*\[([^\]]*)\]\(([^)\s]+)\)(.*)$/gm)];
  if (links.length === 0) out.push('lists no links');
  // Links elsewhere are fine (a GitHub repo, a status page). Links back to
  // the PLATFORM from a file on the customer's own domain are the leak: the
  // agent is sent to a host the customer did not publish on (FMU-B15/B16).
  const host = hostOf(url);
  const platform = platformHost?.toLowerCase();
  const foreign =
    platform && host !== platform
      ? links
          .map((m) => m[2]!)
          .filter(
            (href) => /^https?:/i.test(href) && hostOf(href)?.replace(/^www\./, '') === platform,
          )
      : [];
  if (foreign.length) out.push(`links to the platform host: ${some(foreign, 3)}`);
  const leaks = links.filter((m) => SLUG_LEAK.test(`[${m[1]}]`)).map((m) => m[1]!);
  if (leaks.length) out.push(`titles carry slugs: ${some(leaks, 3)}`);
  const sections = lines.filter((l) => /^##\s+\S/.test(l)).length;
  const described = links.filter((m) => /^\s*:\s*\S/.test(m[3] ?? '')).length;
  if (links.length > 0 && sections === 0 && described === 0)
    out.push(`${links.length} links in one flat list with no sections and no descriptions`);
  return out;
}

/**
 * `llms-txt`: the file an AI agent reads first exists and is shaped for one.
 *
 * The space's llms.txt opened with "Published documentation for API Docs.",
 * listed pages in recent-edit order with no descriptions, and titled a clash
 * "Authentication (ref-authentication)" (FMU-B16). An agent picks pages from
 * this list by their descriptions; without them it fetches at random.
 */
export async function llmsTxt(
  get: Get,
  origin: string,
  roots: string[],
  platformHost?: string,
): Promise<Check> {
  const title = 'llms.txt is present and follows llmstxt.org';
  const candidates = [
    ...new Set([`${origin}/llms.txt`, ...roots.map((r) => `${r.replace(/\/+$/, '')}/llms.txt`)]),
  ];
  const found: string[] = [];
  const bad: string[] = [];
  for (const url of candidates) {
    const p = await get(url, { accept: 'text/plain,text/markdown' });
    if (!p.ok || p.status !== 200) continue;
    found.push(url);
    for (const problem of llmsProblems(p.text, url, platformHost)) bad.push(`${url} ${problem}`);
  }
  if (found.length === 0)
    return check(
      'llms-txt',
      title,
      'fail',
      `None of ${candidates.join(', ')} answered 200.`,
      'Agents look for /llms.txt before anything else; without it they crawl HTML and guess.',
    );
  return check(
    'llms-txt',
    title,
    bad.length ? 'fail' : 'pass',
    bad.length ? some(bad) : `${found.join(', ')}: well formed.`,
    bad.length
      ? 'An agent chooses which pages to read from this list; links with no descriptions, or back to the platform’s host, send it to the wrong ones.'
      : '',
  );
}
