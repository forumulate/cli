import type { Check } from './conformance';

/**
 * Everything that is wrong with a live site, from the outside.
 *
 * A customer putting their docs on a custom domain has to verify by hand that
 * the health endpoint answers JSON, that the canonical link points at their
 * host rather than ours, that a logged-out reader gets the page rather than a
 * sign-in, that the feeds exist where their readers will look, that redirects
 * actually redirect, and that nothing in the path is rewriting their HTML.
 * Each of those is a sentence in a checklist somebody reads once and forgets,
 * and all of them were things this customer discovered after going live.
 *
 * So they are a command. It takes a URL and nothing else, speaks plain HTTP, and
 * is the same report whether it is pointed at us, at a staging mount, or at a
 * competitor — a doctor that only works on its author's deployment is a
 * checklist with extra steps.
 */
export interface DoctorInput {
  /** A reader URL on the site to examine, e.g. https://example.com/docs */
  url: string;
  /** The API base, when it is not the same origin (defaults to the site's). */
  apiBase?: string;
  fetchImpl?: typeof fetch;
}

export interface DoctorReport {
  url: string;
  checks: Check[];
  passed: number;
  failed: number;
  warnings: number;
}

/** A crawler-ish UA: some CDNs answer bots differently, which is the point. */
const CRAWLER_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

export async function runDoctor(input: DoctorInput): Promise<DoctorReport> {
  const doFetch = input.fetchImpl ?? fetch;
  const site = new URL(input.url);
  const origin = site.origin;
  /*
   * An EMPTY `apiBase` is not an api base.
   *
   * `doctor` is handed `process.env.FORUMULATE_URL`, and an exported-but-empty
   * variable — `FORUMULATE_URL= forumulate doctor …`, which is how a shell
   * clears one for a single command — arrived as `''`. `'' ?? origin` is `''`,
   * so the health probe fetched `/api/health` with no origin at all and the
   * check failed with "Failed to parse URL". A blank value means "say
   * nothing", exactly as an unset one does.
   */
  const stated = input.apiBase?.trim() || undefined;
  const apiBase = (stated ?? origin).replace(/\/$/, '');
  const checks: Check[] = [];
  const add = (id: string, title: string, state: Check['state'], detail: string, matters: string) =>
    checks.push({ id, title, state, detail, matters });

  const get = async (url: string, headers: Record<string, string> = {}): Promise<Probe> => {
    try {
      const res = await doFetch(url, { headers, redirect: 'manual' });
      const text = res.status < 400 || res.status >= 500 ? await res.text() : await res.text();
      return { ok: true as const, res, text };
    } catch (e) {
      return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
    }
  };

  /*
   * 1. Health answers JSON, in every state.
   *
   * This check could not fail, and a customer caught it. `get()` reports
   * `ok: true` whenever the FETCH resolved — it says nothing about the status —
   * and the body test was only `parsed && typeof parsed === 'object'`. Our API
   * answers its errors as JSON, so a 404 and a 500 both parsed to an object and
   * both were reported as a pass. On their domain `/api/health` is not routed
   * at all: a 404 with a JSON error envelope, reported green. A health check
   * that passes while the thing it checks is absent is worse than no check,
   * because it is the one line in the report somebody trusts.
   *
   * Two things follow. The status has to be read. And on a reader URL the
   * default probe is the WRONG origin to ask: a customer's host serves their
   * docs, not our API, and `/api` there is theirs — so before giving up we ask
   * the platform's OWN mount on this host (see `mountCandidates`), and only a
   * mount that does not answer is a skip. Reachability of the platform is
   * already proven by the page fetch below; this check is about the API.
   */
  // "Nobody told us": unset, or blank, which are the same thing.
  const defaultedApiBase = stated === undefined;
  const directUrl = `${apiBase}/api/health`;
  const health = await get(directUrl, { accept: 'application/json' });
  let verdict = healthVerdict(health, directUrl);

  /*
   * The platform's own API, under the mount this address is served at.
   *
   * Only reached when the host's own `/api/health` did not answer healthily
   * AND nobody named an `--api-base` — on a customer's domain that path is
   * theirs, so whatever it said is not a report about us.
   */
  const tried: string[] = [];
  let mountVerdict: Verdict | null = null;
  if (verdict.state !== 'pass' && defaultedApiBase) {
    for (const mount of mountCandidates(site)) {
      const url = `${origin}${mount}/${READER_API_SEGMENT}/health`;
      tried.push(url);
      const probe = await get(url, { accept: 'application/json' });
      const mounted = healthVerdict(probe, url);
      if (mounted.state === 'pass') {
        mountVerdict = {
          state: 'pass',
          detail: `${probe.ok ? probe.res.status : 200} from ${url} — the platform's own mount under this address.`,
          matters: HEALTH_MATTERS,
        };
        break;
      }
      // A mount that answers 5xx IS ours and IS unhealthy. Anything else
      // (404, a refused connection) only means this was not the mount.
      if (probe.ok && probe.res.status >= 500) {
        mountVerdict = {
          state: 'fail',
          detail: `${probe.res.status} from ${url}.`,
          matters: 'The API serving this section is unhealthy, whatever the reader pages do.',
        };
        break;
      }
    }
  }

  if (mountVerdict) {
    verdict = mountVerdict;
  } else if (defaultedApiBase && health.ok && health.res.status === 404) {
    verdict = {
      state: 'skip',
      detail: `404 — ${apiBase} does not route /api/health, and ${tried.length ? tried.join(' nor ') : 'no mount'} did not answer either. This host serves the reader; the API it is served by has its own origin.`,
      matters: 'Re-run with --api-base <origin> to check the API that serves this site.',
    };
  }
  add('health', 'Health endpoint answers JSON', verdict.state, verdict.detail, verdict.matters);

  // 2. A logged-out reader gets the page, not a sign-in.
  const anon = await get(site.toString(), { accept: 'text/html' });
  const html = anon.ok ? anon.text : '';
  if (!anon.ok) {
    add(
      'public-read',
      'A logged-out reader can read the page',
      'fail',
      anon.error,
      'Public docs behind a login are invisible to readers and to crawlers.',
    );
  } else if (anon.res.status >= 300 && anon.res.status < 400) {
    const to = anon.res.headers.get('location') ?? '';
    const login = /sign-?in|login|auth/i.test(to);
    add(
      'public-read',
      'A logged-out reader can read the page',
      login ? 'fail' : 'pass',
      `${anon.res.status} → ${to}`,
      login
        ? 'A public page that redirects to sign-in is a login wall; crawlers index nothing.'
        : '',
    );
  } else {
    add(
      'public-read',
      'A logged-out reader can read the page',
      anon.res.status === 200 ? 'pass' : 'fail',
      `${anon.res.status}`,
      'Public docs must answer an anonymous GET.',
    );
  }

  // 3. The canonical link names THIS host.
  const canonical =
    /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i.exec(html)?.[1] ??
    /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i.exec(html)?.[1];
  if (!html) {
    add('canonical', 'Canonical link points at this host', 'skip', 'No HTML to read.', '');
  } else if (!canonical) {
    add(
      'canonical',
      'Canonical link points at this host',
      'fail',
      'No rel=canonical in the document.',
      'Without one, two hosts serving the same page compete, and the wrong one can win.',
    );
  } else {
    const same = safeHost(canonical) === site.host;
    add(
      'canonical',
      'Canonical link points at this host',
      same ? 'pass' : 'fail',
      canonical,
      same
        ? ''
        : 'Search engines credit the canonical host, so a platform URL here hands your authority to the platform.',
    );
  }

  // 4. Nothing in the path is rewriting the HTML.
  if (html) {
    const rewritten = html.includes('/cdn-cgi/scripts/') && html.includes('email-decode');
    const scrambled = html.includes('data-cfemail');
    add(
      'html-untouched',
      'No proxy is rewriting the markup',
      rewritten || scrambled ? 'fail' : 'pass',
      rewritten || scrambled
        ? 'Cloudflare Email Obfuscation is rewriting addresses on this page.'
        : 'No rewritten email addresses.',
      'The injected decoder has no CSP nonce, so it is refused and every address renders as [email protected] with a dead link. Turn Email Obfuscation off for these paths.',
    );
  }

  // 5. The document is cacheable, and says so.
  if (anon.ok) {
    const cc = anon.res.headers.get('cache-control') ?? '';
    const bad = /no-store/i.test(cc) || cc === '';
    add(
      'cache-headers',
      'The document carries a usable Cache-Control',
      bad ? 'fail' : 'pass',
      cc || '(none)',
      'Without one, every reader pays full origin latency and a CDN in front of it does nothing.',
    );
  }

  // 6. Crawlers are let in, and told where to look.
  const robots = await get(`${origin}/robots.txt`, { 'user-agent': CRAWLER_UA });
  if (!robots.ok || robots.res.status !== 200) {
    add(
      'robots',
      'robots.txt is served',
      'fail',
      robots.ok ? `${robots.res.status}` : robots.error,
      'Without it a crawler guesses, and some guess "do not index".',
    );
  } else {
    const blocked = blocksPath(robots.text, site.pathname);
    add(
      'robots',
      'robots.txt allows this path',
      blocked ? 'fail' : 'pass',
      blocked ? `Disallowed by robots.txt: ${site.pathname}` : `Allows ${site.pathname || '/'}`,
      'A Disallow here means the page is never indexed, however good it is.',
    );
    add(
      'sitemap',
      'robots.txt names a sitemap',
      /^\s*sitemap:/im.test(robots.text) ? 'pass' : 'fail',
      /^\s*sitemap:/im.test(robots.text) ? 'Declared.' : 'No Sitemap: line.',
      'A crawler finds pages faster when it is handed the list.',
    );
  }

  // 7. As a crawler, the same page.
  const asBot = await get(site.toString(), { accept: 'text/html', 'user-agent': CRAWLER_UA });
  if (asBot.ok) {
    add(
      'crawler-access',
      'A crawler gets the same answer as a reader',
      asBot.res.status === (anon.ok ? anon.res.status : 200) ? 'pass' : 'fail',
      `reader ${anon.ok ? anon.res.status : '?'}, crawler ${asBot.res.status}`,
      'A WAF rule or bot challenge that answers crawlers differently removes the site from search without telling anybody.',
    );
  }

  /*
   * 8. The feed a reader will look for is the one the page ADVERTISES.
   *
   * This probed `<path>/rss.xml` unconditionally and called a 404 a skip — so on
   * a docs section, which has no feed and is not supposed to have one, the
   * report carried a warning that read like a defect and the detail said only
   * "404". The customer asked, reasonably, why their docs were being marked
   * down for missing a thing docs do not have.
   *
   * The page's own `<link rel="alternate">` is the contract: if a surface names
   * a feed, that feed must answer, and if it names none there is nothing to
   * check. That is both the honest report and the stricter one — it now catches
   * an ADVERTISED feed that 404s, which the blanket probe could not distinguish
   * from a surface that simply has no feed.
   */
  const advertised = feedHref(html, origin);
  if (advertised) {
    const feed = await get(advertised, { accept: 'application/rss+xml' });
    if (!feed.ok) {
      add(
        'feeds',
        'The feed this page advertises is served',
        'fail',
        feed.error,
        'A feed link that does not resolve breaks every aggregator that followed it.',
      );
    } else {
      add(
        'feeds',
        'The feed this page advertises is served',
        feed.res.status === 200 ? 'pass' : 'fail',
        `${feed.res.status} for ${advertised}`,
        feed.res.status === 200
          ? ''
          : 'The page tells readers and aggregators this URL is its feed, so a non-200 is a broken promise, not a missing feature.',
      );
    }
  } else if (html) {
    add(
      'feeds',
      'The feed this page advertises is served',
      'skip',
      'This page advertises no feed. Docs surfaces do not publish one; blogs, changelogs, forums and status pages do.',
      '',
    );
  }

  /*
   * Every picture the page shows, fetched.
   *
   * Five screenshots in OUR own documentation answered 404 for weeks, and a
   * customer is the one who listed them back to us. Nothing noticed, because
   * markup that references a dead image is still valid markup and the page
   * still answers 200 — the only way to find it is to ask for the bytes. So
   * that is what this does, on the page it was pointed at.
   */
  const images = [...new Set(imageSrcs(html, site.toString()))].slice(0, IMAGE_LIMIT);
  if (!html) {
    add('images', 'Every picture on the page loads', 'skip', 'No HTML to read.', '');
  } else if (images.length === 0) {
    add('images', 'Every picture on the page loads', 'skip', 'This page shows no images.', '');
  } else {
    const dead: string[] = [];
    for (const src of images) {
      // GET, not HEAD: a CDN in front of a bucket may answer HEAD differently,
      // and a reader's browser issues a GET.
      const img = await get(src, { accept: 'image/*' });
      const status = img.ok ? img.res.status : 0;
      const alive = status >= 200 && status < 400;
      if (!alive) dead.push(`${src} → ${img.ok ? status : img.error}`);
    }
    add(
      'images',
      'Every picture on the page loads',
      dead.length === 0 ? 'pass' : 'fail',
      dead.length === 0
        ? `${images.length} image${images.length === 1 ? '' : 's'} answered.`
        : dead.join('; '),
      dead.length === 0
        ? ''
        : 'A page that renders with holes in it reads as abandoned, and nothing about a 200 page says its pictures are gone.',
    );
  }

  return {
    url: input.url,
    checks,
    passed: checks.filter((c) => c.state === 'pass').length,
    failed: checks.filter((c) => c.state === 'fail').length,
    warnings: checks.filter((c) => c.state === 'skip').length,
  };
}

type Probe = { ok: true; res: Response; text: string } | { ok: false; error: string };

type Verdict = { state: Check['state']; detail: string; matters: string };

const HEALTH_MATTERS = 'A caller cannot tell an outage from a bug.';

/** What one health probe, on its own, says about the API behind it. */
function healthVerdict(probe: Probe, url: string): Verdict {
  if (!probe.ok) return { state: 'fail', detail: probe.error, matters: HEALTH_MATTERS };
  const { status } = probe.res;
  if (status < 200 || status >= 300) {
    return {
      state: 'fail',
      detail: `${status} from ${url}: ${probe.text.slice(0, 80)}`,
      matters: 'A health endpoint that does not answer 2xx is down, whatever its body parses as.',
    };
  }
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(probe.text);
  } catch {
    parsed = null;
  }
  if (!parsed || typeof parsed !== 'object') {
    return {
      state: 'fail',
      detail: `${status} with a non-JSON body: ${probe.text.slice(0, 80)}`,
      matters:
        'A plain-text 500 reads as a permanent bug, so a careful client stops retrying a few-minute outage.',
    };
  }
  return { state: 'pass', detail: `${status} with a JSON body.`, matters: '' };
}

/**
 * The segment a hosted reader's API answers under. Underscore-prefixed on
 * purpose: slugs are `^[a-z0-9]+(?:-[a-z0-9]+)*$`, so no space, collection or
 * page can be called `_api` and this can never shadow somebody's content.
 *
 * A SECOND copy of a string the platform's shared package owns, which is the drift that
 * would make this probe wrong and silent. It is copied rather than imported
 * because this package publishes to npm with one dependency and should not pull
 * the platform's shared bundle onto a customer's machine to learn four
 * characters. `doctor.test.ts` reads the declaration out of
 * `packages/shared/src/space-addressing.ts` and fails if the two ever differ.
 */
export const READER_API_SEGMENT = '_api';

/**
 * Where the platform's own API lives on a customer's host, most specific first.
 *
 * The first version of this guessed ONE address — the first path segment — and
 * a customer on a site domain got a skip anyway, which is the defect as filed.
 * The two mounts are different shapes:
 *
 *  - a PATH-mounted section is `acme.com/docs/…`, forwarded to us by the
 *    customer's edge under that prefix, so health is `acme.com/docs/_api/health`
 *    and `acme.com/_api/health` never reaches us;
 *  - a SITE domain is mounted at the ROOT of the host, so health is
 *    `acme.com/_api/health`, and the first path segment is a space or a page —
 *    `acme.com/getting-started/_api/health` is nothing at all.
 *
 * Nothing in a URL distinguishes them from outside, which is the whole reason
 * the first guess was wrong, so both are asked and the first that answers wins.
 * A root URL on a path-mounted domain has no segment, so it asks one address.
 */
function mountCandidates(site: URL): string[] {
  const first = site.pathname.replace(/\/+$/, '').split('/').filter(Boolean)[0];
  return first ? [`/${first}`, ''] : [''];
}

/** How many distinct pictures one page's report will fetch. */
const IMAGE_LIMIT = 25;

/**
 * Every image this document asks a browser to load, absolute.
 *
 * `<img src>` and `<source srcset>`, plus the social card in `og:image` — that
 * last one is never seen by a reader, so it is exactly the sort of URL that
 * rots unnoticed. `data:` URIs carry their own bytes and are skipped.
 */
function imageSrcs(html: string, base: string): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    const href = raw?.trim();
    if (!href || /^data:/i.test(href)) return;
    try {
      out.push(new URL(href, base).toString());
    } catch {
      /* an unparseable src is the markup's problem, not a missing file */
    }
  };
  for (const tag of html.match(/<img\b[^>]*>/gi) ?? []) {
    push(tag.match(/\bsrc\s*=\s*["']([^"']+)["']/i)?.[1]);
  }
  for (const tag of html.match(/<source\b[^>]*>/gi) ?? []) {
    // A srcset is "url 2x, url 480w" — the descriptors are not part of the URL.
    for (const cand of (tag.match(/\bsrcset\s*=\s*["']([^"']+)["']/i)?.[1] ?? '').split(',')) {
      push(cand.trim().split(/\s+/)[0]);
    }
  }
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if (/\b(?:property|name)\s*=\s*["'](?:og:image|twitter:image)["']/i.test(tag)) {
      push(tag.match(/\bcontent\s*=\s*["']([^"']+)["']/i)?.[1]);
    }
  }
  return out;
}

/**
 * The feed this document declares, absolute, or null when it declares none.
 *
 * Matched on the `<link rel="alternate">` whose type is an RSS/Atom/JSON-feed
 * media type, rather than on a filename — a surface is free to serve its feed
 * at any address, and the point of reading the markup is to check the address
 * the page actually publishes.
 */
function feedHref(html: string, origin: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?alternate\b/i.test(tag)) continue;
    if (!/type\s*=\s*["'](?:application\/(?:rss\+xml|atom\+xml|feed\+json))["']/i.test(tag))
      continue;
    const href = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!href) continue;
    try {
      return new URL(href, origin).toString();
    } catch {
      return null;
    }
  }
  return null;
}

function safeHost(href: string): string | null {
  try {
    return new URL(href).host;
  } catch {
    return null;
  }
}

/**
 * Does robots.txt disallow this path for everyone?
 *
 * Only the `User-agent: *` group is read: a rule aimed at one named crawler is
 * a deliberate choice, and reporting it as a fault would train people to
 * ignore the report.
 */
function blocksPath(robots: string, pathname: string): boolean {
  const path = pathname || '/';
  let inStar = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const [field, ...rest] = line.split(':');
    const value = rest.join(':').trim();
    const key = (field ?? '').trim().toLowerCase();
    if (key === 'user-agent') inStar = value === '*';
    else if (inStar && key === 'disallow' && value && path.startsWith(value)) return true;
    else if (inStar && key === 'allow' && value && path.startsWith(value)) return false;
  }
  return false;
}
