import { describe, it, expect } from 'vitest';
import { makeGet } from './probe';
import { canonicalBothAddresses, consentTag, whiteLabelLeaks } from './address-checks';
import { cacheConsistency, sitemapCrawl } from './crawl';
import { favicon, llmsProblems, llmsTxt, metaDescription, rootRedirect } from './page-checks';
import { descriptionProblem, isHeadingSoup } from './boilerplate';
import { deriveRoots, discoverPrimary, extendedChecks } from './extended';

type Reply = { status?: number; body?: string; headers?: Record<string, string> };

/** A fetch answering from a URL → reply table; anything unlisted is a refused connection. */
function fakeFetch(table: Record<string, Reply>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const reply = table[url];
    if (!reply) throw new Error(`no stub for ${url}`);
    return {
      status: reply.status ?? 200,
      headers: new Headers(reply.headers ?? {}),
      text: async () => reply.body ?? '',
    } as unknown as Response;
  }) as unknown as typeof fetch;
}
const getFor = (t: Record<string, Reply>) => makeGet({ fetchImpl: fakeFetch(t) });

const page = (canonical: string, extra = '', lang = 'en') =>
  `<!doctype html><html lang="${lang}"><head><link rel="canonical" href="${canonical}"/>` +
  `<meta name="description" content="How to install the SDK and make a first call."/>` +
  `<meta property="og:description" content="How to install the SDK and make a first call."/>${extra}</head><body>hi</body></html>`;

const PUBLIC = { 'cache-control': 'public, s-maxage=60' };
const PRIVATE = { 'cache-control': 'private, no-store' };

describe('canonical-both-addresses', () => {
  it('passes when both copies name the primary', async () => {
    const get = getFor({
      'https://acme.example/docs/a': { body: page('https://acme.example/docs/a') },
      'https://platform.example/p/acme/docs/a': { body: page('https://acme.example/docs/a') },
    });
    const c = await canonicalBothAddresses(get, [
      { urls: ['https://acme.example/docs/a', 'https://platform.example/p/acme/docs/a'] },
    ]);
    expect(c.state).toBe('pass');
  });

  // FMU-B01: the platform copy 308s to a third address that names itself.
  it('fails a platform copy that redirects to a self-canonical page', async () => {
    const get = getFor({
      'https://acme.example/legal/privacy': { body: page('https://acme.example/legal/privacy') },
      'https://platform.example/p/acme/legal/privacy': {
        status: 308,
        headers: { location: '/legal/acme/privacy' },
      },
      'https://platform.example/legal/acme/privacy': {
        body: page('https://platform.example/legal/acme/privacy'),
      },
    });
    const c = await canonicalBothAddresses(get, [
      {
        expected: 'https://acme.example/legal/privacy',
        urls: [
          'https://acme.example/legal/privacy',
          'https://platform.example/p/acme/legal/privacy',
        ],
      },
    ]);
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('via https://platform.example/legal/acme/privacy');
  });

  it('skips when only one address is known', async () => {
    expect((await canonicalBothAddresses(getFor({}), [])).state).toBe('skip');
  });

  it('asks the platform for the primary address of a platform copy', async () => {
    const get = getFor({
      'https://platform.example/api/public/domains/primary?org=acme&space=docs': {
        body: JSON.stringify({ primary: { origin: 'https://acme.example', basePath: '/docs' } }),
      },
    });
    const set = await discoverPrimary(
      get,
      'https://platform.example/p/acme/docs/install',
      'platform.example',
      'https://platform.example/api',
    );
    expect(set).toEqual({
      expected: 'https://acme.example/docs/install',
      urls: ['https://platform.example/p/acme/docs/install', 'https://acme.example/docs/install'],
    });
  });
});

describe('sitemap-crawl', () => {
  const robots = 'Sitemap: https://acme.example/sitemap.xml\n';
  const index =
    '<sitemapindex><sitemap><loc>https://acme.example/docs/sitemap.xml</loc></sitemap></sitemapindex>';
  const urlset = (...u: string[]) =>
    `<urlset>${u.map((x) => `<url><loc>${x}</loc></url>`).join('')}</urlset>`;

  it('passes when every listed URL answers 200 as itself (through a sitemap index)', async () => {
    const get = getFor({
      'https://acme.example/sitemap.xml': { body: index },
      'https://acme.example/docs/sitemap.xml': { body: urlset('https://acme.example/docs/a') },
      'https://acme.example/docs/a': { body: page('https://acme.example/docs/a') },
    });
    const r = await sitemapCrawl(get, 'https://acme.example', robots, 50);
    expect(r.check.state).toBe('pass');
    expect(r.pages).toHaveLength(1);
  });

  it('fails a listed URL that redirects, 404s, or names another canonical', async () => {
    const get = getFor({
      'https://acme.example/sitemap.xml': {
        body: urlset(
          'https://acme.example/docs',
          'https://acme.example/docs/gone',
          'https://acme.example/docs/b',
        ),
      },
      'https://acme.example/docs': { status: 307, headers: { location: '/docs/a' } },
      'https://acme.example/docs/gone': { status: 404 },
      'https://acme.example/docs/b': { body: page('https://other.example/docs/b') },
    });
    const r = await sitemapCrawl(get, 'https://acme.example', robots, 50);
    expect(r.check.state).toBe('fail');
    expect(r.check.detail).toContain('307');
    expect(r.check.detail).toContain('404');
    expect(r.check.detail).toContain('names canonical https://other.example/docs/b');
  });

  it('fails when there is no sitemap at all', async () => {
    const r = await sitemapCrawl(getFor({}), 'https://acme.example', '', 50);
    expect(r.check.state).toBe('fail');
  });
});

describe('cache-consistency', () => {
  const probe = (url: string, headers: Record<string, string>) =>
    ({ ok: true, url, status: 200, headers: new Headers(headers), text: '' }) as const;

  it('passes a space whose pages are all public', () => {
    const c = cacheConsistency([
      probe('https://acme.example/legal', PUBLIC),
      probe('https://acme.example/legal/terms', PUBLIC),
    ]);
    expect(c.state).toBe('pass');
  });

  // FMU-B05: the legal index public, every legal document no-store.
  it('fails a space whose documents are no-store beside a public index', () => {
    const c = cacheConsistency([
      probe('https://acme.example/legal', PUBLIC),
      probe('https://acme.example/legal/terms', PRIVATE),
      probe('https://acme.example/docs/a', PRIVATE),
    ]);
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('acme.example/legal');
    expect(c.detail).not.toContain('docs/a');
  });

  it('takes a page that states its reason at its word', () => {
    const c = cacheConsistency([
      probe('https://acme.example/legal', PUBLIC),
      probe('https://acme.example/legal/terms', {
        ...PRIVATE,
        'x-forumulate-cache-reason': 'legal-acceptance',
      }),
    ]);
    expect(c.state).toBe('pass');
  });
});

describe('root-redirect', () => {
  it('passes a root that renders, and a bodiless 308', async () => {
    const get = getFor({
      'https://acme.example/docs': { body: page('https://acme.example/docs') },
      'https://acme.example/blog': { status: 308, headers: { location: '/blog/home' } },
      'https://acme.example/blog/home': { body: page('https://acme.example/blog/home') },
    });
    const c = await rootRedirect(get, ['https://acme.example/docs', 'https://acme.example/blog']);
    expect(c.state).toBe('pass');
  });

  // FMU-B06: 307 with a 66 KB body.
  it('fails a temporary redirect with a page-sized body', async () => {
    const get = getFor({
      'https://acme.example/docs': {
        status: 307,
        headers: { location: '/docs/intro' },
        body: 'x'.repeat(66_000),
      },
      'https://acme.example/docs/intro': { body: page('https://acme.example/docs/intro') },
    });
    const c = await rootRedirect(get, ['https://acme.example/docs']);
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('307 is temporary');
    expect(c.detail).toContain('66000-byte body');
  });
});

describe('meta-description', () => {
  const ok = (url: string, text: string) =>
    ({ ok: true, url, status: 200, headers: new Headers(), text }) as const;

  it('passes pages with written descriptions', () => {
    expect(metaDescription([ok('https://a.example/x', page('https://a.example/x'))]).state).toBe(
      'pass',
    );
  });

  it('fails a missing description, a preset one, and headings run together', () => {
    const preset = page('https://a.example/g').replace(
      /How to install the SDK and make a first call\./g,
      'Guides and reference, in a nested tree.',
    );
    const soup = page('https://a.example/r').replace(
      /How to install the SDK and make a first call\./g,
      'Acme API Analytics and operations Billing Authentication Programs and partners Partner portal Payouts…',
    );
    const c = metaDescription([
      ok('https://a.example/none', '<html><head></head></html>'),
      ok('https://a.example/g', preset),
      ok('https://a.example/r', soup),
    ]);
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('3 of 3');
  });

  it('tells a sentence from a list of headings', () => {
    expect(isHeadingSoup('What Acme is, and the objects you work with through its API.')).toBe(
      false,
    );
    expect(isHeadingSoup('PayoutsPartnersPrograms')).toBe(true);
    expect(descriptionProblem('Community discussions in Community.')).toContain('preset');
  });
});

describe('llms-txt', () => {
  const good =
    '# Acme docs\n\n> Install, call and operate the Acme API.\n\n## Guides\n\n- [Install](https://acme.example/docs/install.md): set up the SDK\n';
  it('passes a well-formed file', async () => {
    const get = getFor({ 'https://acme.example/docs/llms.txt': { body: good } });
    const c = await llmsTxt(
      get,
      'https://acme.example',
      ['https://acme.example/docs'],
      'platform.example',
    );
    expect(c.state).toBe('pass');
  });

  // FMU-B16 and B15 in one file.
  it('fails a preset summary, slug-leaking titles, a flat undescribed list and platform links', () => {
    const bad =
      '# API Docs\n\n> Published documentation for API Docs.\n\n- [Authentication (ref-authentication)](https://acme.example/docs/ref-authentication.md)\n- [All](https://platform.example/api/public/orgs/1/llms-full.txt)\n';
    const problems = llmsProblems(bad, 'https://acme.example/docs/llms.txt', 'platform.example');
    expect(problems.join(' | ')).toMatch(/preset/);
    expect(problems.join(' | ')).toMatch(/slugs/);
    expect(problems.join(' | ')).toMatch(/flat list/);
    expect(problems.join(' | ')).toMatch(/platform host/);
  });

  it('fails when no llms.txt answers', async () => {
    const c = await llmsTxt(getFor({}), 'https://acme.example', ['https://acme.example/docs']);
    expect(c.state).toBe('fail');
  });
});

describe('favicon', () => {
  const html = page('https://acme.example/docs/a', '<link rel="icon" href="/favicon.ico"/>');
  it('passes icons that are images, and a small 404 under the mount', async () => {
    const get = getFor({
      'https://acme.example/favicon.ico': {
        body: 'ico',
        headers: { 'content-type': 'image/x-icon' },
      },
      'https://acme.example/docs/favicon.ico': {
        status: 404,
        body: 'nf',
        headers: { 'content-type': 'text/plain' },
      },
    });
    const c = await favicon(get, 'https://acme.example/docs/a', html, [
      'https://acme.example/docs',
    ]);
    expect(c.state).toBe('pass');
  });

  // FMU-B17: an asset path answering a 104 KB HTML page.
  it('fails an asset path that answers a large HTML page', async () => {
    const get = getFor({
      'https://acme.example/favicon.ico': {
        body: 'ico',
        headers: { 'content-type': 'image/x-icon' },
      },
      'https://acme.example/docs/favicon.ico': {
        status: 404,
        body: '<html>'.padEnd(104_000, 'x'),
        headers: { 'content-type': 'text/html; charset=utf-8' },
      },
    });
    const c = await favicon(get, 'https://acme.example/docs/a', html, [
      'https://acme.example/docs',
    ]);
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('HTML page');
  });
});

describe('consent-tag', () => {
  it('skips a page with no consent manager', () => {
    expect(consentTag(page('https://a.example/x')).state).toBe('skip');
  });

  it('passes a CMP told the page language (any vendor)', () => {
    const ot =
      '<script src="https://cdn.cookielaw.org/scripttemplates/otSDKStub.js" data-domain-script="x" data-document-language="de"></script>';
    expect(consentTag(page('https://a.example/x', ot, 'de')).state).toBe('pass');
    const cb =
      '<script id="Cookiebot" src="https://consent.cookiebot.com/uc.js" data-cbid="abc" data-culture="fr"></script>';
    expect(consentTag(page('https://a.example/x', cb, 'fr-FR')).state).toBe('pass');
  });

  // FMU-B17/S05: the tag carried no culture, so the banner followed the browser.
  it('fails a CMP given no language, and one given the wrong one', () => {
    const none = '<link rel="preload" href="https://cdn.cookiemunch.net/consent.js" as="script"/>';
    expect(consentTag(page('https://a.example/x', none)).state).toBe('fail');
    const wrong = '<script src="https://app.termly.io/resource-blocker/x?language=en"></script>';
    const c = consentTag(page('https://a.example/x', wrong, 'es'));
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('"en"');
  });
});

describe('white-label-leaks', () => {
  const platform = 'platform.example';
  it('passes a custom-domain page and twin with no platform links (scripts do not count)', async () => {
    const html = page(
      'https://acme.example/docs/a',
      '<script src="https://platform.example/_next/x.js"></script><a href="https://platform.example">Powered by</a>',
    );
    const get = getFor({
      'https://acme.example/docs/a.md': {
        body: '# A\n\nSee https://acme.example/docs/llms-full.txt',
        headers: { 'content-type': 'text/markdown' },
      },
    });
    expect((await whiteLabelLeaks(get, 'https://acme.example/docs/a', html, platform)).state).toBe(
      'pass',
    );
  });

  // FMU-B15: the "For AI agents" footer of the Markdown twin.
  it('fails platform URLs in the Markdown twin', async () => {
    const get = getFor({
      'https://acme.example/docs/a.md': {
        body: '## For AI agents\n- The whole space: https://platform.example/api/public/orgs/1/spaces/2/llms-full.txt\n- MCP: `claude mcp add x https://platform.example/api/public/orgs/1/spaces/2/mcp`',
        headers: { 'content-type': 'text/markdown' },
      },
    });
    const c = await whiteLabelLeaks(
      get,
      'https://acme.example/docs/a',
      page('https://acme.example/docs/a'),
      platform,
    );
    expect(c.state).toBe('fail');
    expect(c.detail).toContain('/mcp');
    expect(c.detail).not.toContain('mcp`');
  });

  it('skips the platform host itself', async () => {
    expect(
      (await whiteLabelLeaks(getFor({}), 'https://platform.example/p/a', '', platform)).state,
    ).toBe('skip');
  });
});

describe('the site-wide run', () => {
  it('derives the space root from a mount and from a platform copy', () => {
    expect(deriveRoots('https://acme.example/docs/a/b', 'platform.example')).toEqual([
      'https://acme.example/docs',
    ]);
    expect(deriveRoots('https://platform.example/p/acme/docs/x', 'platform.example')).toEqual([
      'https://platform.example/p/acme/docs',
    ]);
  });

  it('runs only what --only asks for', async () => {
    const checks = await extendedChecks({
      url: 'https://acme.example/docs/a',
      html: page('https://acme.example/docs/a'),
      get: getFor({}),
      platformHost: 'platform.example',
      only: new Set(['consent-tag']),
    });
    expect(checks.map((c) => c.id)).toEqual(['consent-tag']);
  });
});
