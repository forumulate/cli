import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runDoctor as runFullDoctor, READER_API_SEGMENT, BASE_CHECK_IDS } from './doctor';

/**
 * These tests are about the single-page checks; the site-wide ones (a sitemap
 * crawl, llms.txt, …) have their own suite in doctor/extended.test.ts and would
 * only add "no stub" failures to every table here.
 */
const runDoctor = (input: Parameters<typeof runFullDoctor>[0]) =>
  runFullDoctor({ only: [...BASE_CHECK_IDS], ...input });

type Reply = { status?: number; body?: string; headers?: Record<string, string> };

/** A fetch that answers from a path→reply table, so every check is reachable. */
function fakeFetch(table: Record<string, Reply>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const ua = ((init?.headers ?? {}) as Record<string, string>)['user-agent'] ?? '';
    const key = ua.includes('Googlebot') && table[`${url}#bot`] ? `${url}#bot` : url;
    const reply = table[key];
    if (!reply) throw new Error(`no stub for ${url}`);
    return {
      status: reply.status ?? 200,
      headers: new Headers(reply.headers ?? {}),
      text: async () => reply.body ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const SITE = 'https://acme.example/docs';
const OK_HTML = (extra = '') =>
  `<!doctype html><html><head><link rel="canonical" href="https://acme.example/docs"/>${extra}</head><body>hi</body></html>`;

const FEED_LINK =
  '<link rel="alternate" type="application/rss+xml" href="https://acme.example/docs/rss.xml"/>';

const healthy: Record<string, Reply> = {
  'https://acme.example/api/health': { body: '{"status":"ok"}' },
  'https://acme.example/docs': {
    body: OK_HTML(FEED_LINK),
    headers: { 'cache-control': 'public, max-age=60' },
  },
  'https://acme.example/robots.txt': {
    body: 'User-agent: *\nAllow: /\nSitemap: https://acme.example/sitemap.xml\n',
  },
  'https://acme.example/docs/rss.xml': { body: '<rss/>' },
};
const state = (r: Awaited<ReturnType<typeof runDoctor>>, id: string) =>
  r.checks.find((c) => c.id === id)?.state;

describe('forumulate doctor', () => {
  it('passes a site that is set up correctly', async () => {
    const r = await runDoctor({ url: SITE, fetchImpl: fakeFetch(healthy) });
    expect(r.failed).toBe(0);
    expect(r.passed).toBeGreaterThan(5);
  });

  // The customer's health endpoint answered `Internal Server Error` as text
  // during a deploy. The integration guide promises JSON, and a careful
  // client's retry logic reads a 500 as permanent.
  it('fails a health endpoint that answers plain text', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/api/health': { status: 500, body: 'Internal Server Error' },
      }),
    });
    expect(state(r, 'health')).toBe('fail');
  });

  // A canonical pointing at the platform hands the customer's search authority
  // to the platform.
  it('fails a canonical that names another host', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/docs': {
          body: '<link rel="canonical" href="https://forumulate.com/p/acme/guides"/>',
          headers: { 'cache-control': 'public' },
        },
      }),
    });
    expect(state(r, 'canonical')).toBe('fail');
  });

  // Public docs behind a login are invisible to readers and to crawlers; this
  // is the failure that is hardest to notice from inside a signed-in session.
  it('fails a public page that redirects to sign-in', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/docs': {
          status: 307,
          headers: { location: '/atlas-signin?next=/docs' },
        },
      }),
    });
    expect(state(r, 'public-read')).toBe('fail');
  });

  // Cloudflare's Email Obfuscation injects an un-nonced decoder the CSP then
  // refuses, so every address renders as [email protected].
  it("notices a proxy rewriting the page's email addresses", async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/docs': {
          body: OK_HTML(
            '<script src="/cdn-cgi/scripts/x/cloudflare-static/email-decode.min.js"></script>',
          ),
          headers: { 'cache-control': 'public' },
        },
      }),
    });
    expect(state(r, 'html-untouched')).toBe('fail');
  });

  it('fails a robots.txt that disallows the path being checked', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/robots.txt': { body: 'User-agent: *\nDisallow: /docs\n' },
      }),
    });
    expect(state(r, 'robots')).toBe('fail');
  });

  it('ignores a Disallow aimed at one named crawler', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/robots.txt': {
          body: 'User-agent: BadBot\nDisallow: /docs\n\nUser-agent: *\nAllow: /\nSitemap: https://acme.example/s.xml\n',
        },
      }),
    });
    expect(state(r, 'robots')).toBe('pass');
  });

  // A WAF rule or bot challenge that answers crawlers differently removes the
  // site from search with nothing in any log to say so.
  it('fails when a crawler is answered differently from a reader', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/docs#bot': { status: 403, body: 'error 1010' },
      }),
    });
    expect(state(r, 'crawler-access')).toBe('fail');
  });

  it('fails a document served with no-store', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/docs': { body: OK_HTML(), headers: { 'cache-control': 'no-store' } },
      }),
    });
    expect(state(r, 'cache-headers')).toBe('fail');
  });

  /*
   * The check that could not fail.
   *
   * `get()` reports ok whenever the fetch RESOLVED, and the old body test was
   * only "does this parse to an object". Our API answers its errors as JSON, so
   * a 404 — which is what a customer's own host gives for `/api/health`, since
   * it does not route our API at all — parsed to an object and was reported
   * green. The two cases below are the ones that were silently passing.
   */
  it('does not pass a health endpoint that 404s with a JSON error body', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/api/health': {
          status: 404,
          body: '{"message":"Route GET:/api/health not found","statusCode":404}',
        },
      }),
    });
    expect(state(r, 'health')).not.toBe('pass');
  });

  // A reader host is not obliged to route our API, so an absent route on a
  // DEFAULTED base is a skip that names the real endpoint — not a failure for
  // something the customer does not operate.
  it('says where the API is when the reader host does not route it', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/api/health': { status: 404, body: '{}' },
      }),
    });
    expect(state(r, 'health')).toBe('skip');
    expect(r.checks.find((c) => c.id === 'health')?.matters).toMatch(/--api-base/);
  });

  // ...but an EXPLICIT --api-base is a base the caller asserts serves the API,
  // so a 404 there is a real failure.
  it('fails an explicitly given api base that does not answer', async () => {
    const r = await runDoctor({
      url: SITE,
      apiBase: 'https://api.acme.example',
      fetchImpl: fakeFetch({
        ...healthy,
        'https://api.acme.example/api/health': { status: 404, body: '{}' },
      }),
    });
    expect(state(r, 'health')).toBe('fail');
  });

  it('fails a 500 whose body happens to be JSON', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/api/health': { status: 500, body: '{"statusCode":500}' },
      }),
    });
    expect(state(r, 'health')).toBe('fail');
  });

  it('fails a feed the page advertises and does not serve', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({ ...healthy, 'https://acme.example/docs/rss.xml': { status: 404 } }),
    });
    expect(state(r, 'feeds')).toBe('fail');
  });

  /*
   * A docs surface has no feed and is not meant to have one. The blanket
   * `<path>/rss.xml` probe called that a skipped 404, which in the report reads
   * as a defect — the customer asked why their docs were being marked down for
   * missing a thing docs do not have. The page's own `<link rel="alternate">`
   * is the contract: no advertisement, nothing to check.
   */
  it('does not warn about a missing feed on a surface that advertises none', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...healthy,
        'https://acme.example/docs': {
          body: OK_HTML(),
          headers: { 'cache-control': 'public, max-age=60' },
        },
      }),
    });
    expect(state(r, 'feeds')).toBe('skip');
    expect(r.checks.find((c) => c.id === 'feeds')?.detail).toMatch(/advertises no feed/);
  });
});

/*
 * A path-mounted host serves the platform's API under its own mount.
 *
 * Reporting a 404 at `<host>/api/health` as a PASS was the original bug — that
 * path belongs to the customer, not to us. Skipping it was the fix, and the
 * customer who caught the pass then asked the obvious next question: their
 * section answers at `<mount>/_api`, which IS ours, so check that instead of
 * giving up. A skip is only honest once we have actually asked.
 */
describe('doctor on a path-mounted host', () => {
  const mounted = (reply: Reply): Record<string, Reply> => ({
    ...healthy,
    // The customer's own origin does not route ours.
    'https://acme.example/api/health': { status: 404, body: '{"error":{"code":"not_found"}}' },
    'https://acme.example/docs/_api/health': reply,
  });

  it('checks the platform mount instead of skipping, and passes on a healthy one', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch(mounted({ body: '{"status":"ok"}' })),
    });
    expect(state(r, 'health')).toBe('pass');
    expect(r.checks.find((c) => c.id === 'health')?.detail).toContain('/docs/_api/health');
  });

  it('fails when the mounted API is unhealthy, rather than calling it a skip', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch(mounted({ status: 503, body: 'down' })),
    });
    expect(state(r, 'health')).toBe('fail');
  });

  it('still skips — and says where to look — when neither answers', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch(mounted({ status: 404, body: 'nope' })),
    });
    expect(state(r, 'health')).toBe('skip');
    expect(r.checks.find((c) => c.id === 'health')?.matters).toContain('--api-base');
  });

  /*
   * The customer's own `/api/health` need not 404 to be none of our business.
   *
   * A site that answers its root `/api/*` with its own catch-all — an HTML 200,
   * or its own 403 — was reported as a FAILING health endpoint: a red line in
   * the report about a route the customer does not operate and we do not serve.
   * The mount is the address that is ours, whatever the host said first.
   */
  it('asks the mount when the host answers /api/health with its own page', async () => {
    const r = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch({
        ...mounted({ body: '{"status":"ok"}' }),
        'https://acme.example/api/health': { status: 200, body: '<!doctype html><html></html>' },
      }),
    });
    expect(state(r, 'health')).toBe('pass');
    expect(r.checks.find((c) => c.id === 'health')?.detail).toContain('/docs/_api/health');
  });
});

/*
 * A SITE domain is mounted at the ROOT of the host, not under a path.
 *
 * The first version of the mount probe guessed one address — the first path
 * segment — which is right for `acme.com/docs/…` and wrong for a domain whose
 * whole host is the site: there the first segment is a SPACE or a PAGE, and
 * `acme.com/getting-started/_api/health` is nothing. Those customers got the
 * same skip the probe was added to remove, which is the defect as filed.
 */
describe('doctor on a site-mode custom domain', () => {
  const sitePage = (url: string): Record<string, Reply> => ({
    'https://acme.example/api/health': { status: 404, body: '{"error":{"code":"not_found"}}' },
    'https://acme.example/_api/health': { body: '{"status":"ok"}' },
    [url]: { body: OK_HTML(), headers: { 'cache-control': 'public, max-age=60' } },
    'https://acme.example/robots.txt': {
      body: 'User-agent: *\nAllow: /\nSitemap: https://acme.example/sitemap.xml\n',
    },
  });

  it('checks the root mount when the first segment is a page, not a mount', async () => {
    const url = 'https://acme.example/getting-started';
    const r = await runDoctor({ url, fetchImpl: fakeFetch(sitePage(url)) });
    expect(state(r, 'health')).toBe('pass');
    expect(r.checks.find((c) => c.id === 'health')?.detail).toContain(
      'https://acme.example/_api/health',
    );
  });

  it('checks the root mount on the host root, where there is no segment to guess', async () => {
    const url = 'https://acme.example/';
    const r = await runDoctor({ url, fetchImpl: fakeFetch(sitePage(url)) });
    expect(state(r, 'health')).toBe('pass');
  });

  it('fails an unhealthy root mount rather than skipping', async () => {
    const url = 'https://acme.example/';
    const r = await runDoctor({
      url,
      fetchImpl: fakeFetch({
        ...sitePage(url),
        'https://acme.example/_api/health': { status: 503, body: 'down' },
      }),
    });
    expect(state(r, 'health')).toBe('fail');
    expect(r.checks.find((c) => c.id === 'health')?.detail).toContain('503');
  });
});

/*
 * D-4: five screenshots in Forumulate's own documentation answered 404, and
 * the customer is who noticed. A page with a dead picture still answers 200,
 * so only asking for the bytes finds it.
 */
describe('doctor: the pictures on the page', () => {
  const page = OK_HTML(
    `${FEED_LINK}<meta property="og:image" content="https://cdn.test/card.png"/>`,
  ).replace(
    '<body>hi</body>',
    '<body><img src="/img/alive.png"/><img src="https://cdn.test/gone.png"/>' +
      '<img src="data:image/gif;base64,R0lGOD"/>' +
      '<picture><source srcset="/img/alive.png 1x, /img/wide.png 2x"/></picture></body>',
  );
  const table = (overrides: Record<string, Reply>) => ({
    ...healthy,
    'https://acme.example/docs': { body: page, headers: { 'cache-control': 'public, max-age=60' } },
    'https://acme.example/img/alive.png': { body: 'png' },
    'https://acme.example/img/wide.png': { body: 'png' },
    'https://cdn.test/card.png': { body: 'png' },
    ...overrides,
  });

  it('fails, and names the one that is gone', async () => {
    const report = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch(table({ 'https://cdn.test/gone.png': { status: 404, body: 'nope' } })),
    });
    const images = report.checks.find((c) => c.id === 'images')!;
    expect(images.state).toBe('fail');
    expect(images.detail).toContain('https://cdn.test/gone.png → 404');
    expect(images.detail).not.toContain('alive.png');
  });

  it('checks the social card and the srcset candidates, and skips a data URI', async () => {
    const report = await runDoctor({
      url: SITE,
      fetchImpl: fakeFetch(table({ 'https://cdn.test/gone.png': { body: 'png' } })),
    });
    const images = report.checks.find((c) => c.id === 'images')!;
    expect(images.state).toBe('pass');
    // alive, gone, wide, card — the data: URI carries its own bytes.
    expect(images.detail).toBe('4 images answered.');
  });

  it('says so plainly when a page shows no pictures', async () => {
    const report = await runDoctor({ url: SITE, fetchImpl: fakeFetch(healthy) });
    const images = report.checks.find((c) => c.id === 'images')!;
    expect(images.state).toBe('skip');
    expect(images.detail).toContain('no images');
  });
});

/**
 * An exported-but-empty `FORUMULATE_URL` is not an api base.
 *
 * `FORUMULATE_URL= forumulate doctor …` is how a shell clears the variable for
 * one command, and it arrived as `''`: `'' ?? origin` is `''`, so the health
 * probe fetched `/api/health` with no origin and the check failed with "Failed
 * to parse URL". Caught by running the PUBLISHED cli against production.
 */
describe('a blank api base', () => {
  it('is treated as unset, so the probe has an origin', async () => {
    const seen: string[] = [];
    const report = await runDoctor({
      url: 'https://acme.test/docs',
      apiBase: '   ',
      fetchImpl: (async (u: string) => {
        seen.push(String(u));
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      }) as unknown as typeof fetch,
    });
    expect(seen.some((u) => u.startsWith('https://acme.test/api/health'))).toBe(true);
    expect(report.checks.find((c) => c.id === 'health')?.detail).not.toContain('parse URL');
  });
});

/*
 * The mount segment is copied, not imported — this package publishes with one
 * dependency and will not pull the platform's shared bundle onto a customer's
 * machine for four characters. The cost of copying is drift, and drift here is
 * silent: every probe 404s and every report says "skip". So the copy is pinned
 * to the declaration it was copied from.
 */
// The declaration moved to a zod-free leaf (913fb7cb8); space-addressing re-exports it.
const DECLARED_IN = path.join(__dirname, '..', '..', 'shared', 'src', 'reader-api-segment.ts');

/*
 * Skipped only where the declaration is absent: the public mirror of this
 * package is built without the platform's packages. In the monorepo it always
 * exists, so the pin still holds wherever the two could drift.
 */
describe('the reader API segment', () => {
  it.skipIf(!existsSync(DECLARED_IN))('is the same string the platform declares', () => {
    const src = readFileSync(DECLARED_IN, 'utf8');
    const declared = /READER_API_SEGMENT\s*=\s*'([^']+)'/.exec(src)?.[1];
    expect(declared, 'READER_API_SEGMENT is no longer declared where this reads it').toBeTruthy();
    expect(READER_API_SEGMENT).toBe(declared);
  });
});
