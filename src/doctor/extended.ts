import type { Check } from '../conformance';
import {
  canonicalBothAddresses,
  consentTag,
  whiteLabelLeaks,
  type AddressSet,
} from './address-checks';
import { cacheConsistency, sitemapCrawl } from './crawl';
import { favicon, llmsTxt, metaDescription, rootRedirect } from './page-checks';
import { check, hostOf, type Get, type Probe } from './probe';
import { robotsParams } from './robots-params';

/**
 * The site-wide checks added for FMU-D14, run after the single-page ones.
 *
 * Every one of them is a defect an integrator found on a live site after
 * readers did, and every one is judged from the outside, by HTTP alone, so the
 * report is the same whether it is pointed at our platform, a staging mount or
 * any other docs host. The only thing a check knows about "the platform" is
 * its hostname, which is an input (`--platform-host`, else the host of
 * FORUMULATE_URL, else forumulate.com) — never a constant in the logic.
 */

/** Every check id this file can produce, in report order. `--only` validates against it. */
export const EXTENDED_CHECK_IDS = [
  'canonical-both-addresses',
  'sitemap-crawl',
  'cache-consistency',
  'root-redirect',
  'meta-description',
  'llms-txt',
  'favicon',
  'consent-tag',
  'white-label-leaks',
  'robots-params',
] as const;

export const DEFAULT_PLATFORM_HOST = 'forumulate.com';
/** URLs one run fetches from the sitemaps; enough to see a pattern, few enough for CI. */
export const DEFAULT_SAMPLE_LIMIT = 60;

export interface ExtendedInput {
  /** The page judged: where the asked-for address landed after redirects. */
  url: string;
  /** The address as given, before any redirect. */
  requestedUrl?: string;
  /** The page's HTML as an anonymous reader got it ('' when it did not answer). */
  html: string;
  /** robots.txt, when it answered 200. */
  robots?: string;
  get: Get;
  platformHost: string;
  /** The platform's API base (`https://forumulate.com/api`), for the primary-address lookup. */
  platformApi?: string;
  /** Other addresses of this page/space, from `--also` or `--site`. */
  addressSets?: AddressSet[];
  /** Space roots to check, from `--site`; derived from the URL otherwise. */
  roots?: string[];
  limit?: number;
  /** Run only these ids (undefined: all). */
  only?: ReadonlySet<string>;
}

/**
 * A platform copy's address shape: `/<prefix>/<org>/<space>/<rest>`, where the
 * prefix is a short reader route (`/p/`, `/b/`, `/f/` …). Read only on the
 * platform host, where that shape is the platform's own convention.
 */
const PLATFORM_COPY = /^\/([a-z]{1,3})\/([^/]+)\/([^/]+)(\/.*)?$/;

/** The roots a URL's space is served at: the mount (first segment), or the platform copy's space root. */
export function deriveRoots(url: string, platformHost: string): string[] {
  const u = new URL(url);
  const path = u.pathname.replace(/\/+$/, '');
  if (hostOf(url) === platformHost.toLowerCase()) {
    const m = PLATFORM_COPY.exec(path);
    if (m) return [`${u.origin}/${m[1]}/${m[2]}/${m[3]}`];
  }
  const first = path.split('/').filter(Boolean)[0];
  return [first ? `${u.origin}/${first}` : u.origin];
}

/**
 * The customer's address of a platform-hosted page, asked of the platform.
 *
 * Only for a URL on the platform host in the platform-copy shape: the public
 * primary-domain lookup answers where the space's readers are sent, which is
 * what both copies must name as canonical. Any failure is "unknown", and the
 * check then compares the copies it has with each other.
 */
export async function discoverPrimary(
  get: Get,
  url: string,
  platformHost: string,
  platformApi: string | undefined,
): Promise<AddressSet | undefined> {
  if (!platformApi || hostOf(url) !== platformHost.toLowerCase()) return undefined;
  const u = new URL(url);
  const m = PLATFORM_COPY.exec(u.pathname.replace(/\/+$/, ''));
  if (!m) return undefined;
  const q = new URLSearchParams({
    org: decodeURIComponent(m[2]!),
    space: decodeURIComponent(m[3]!),
  });
  const p = await get(`${platformApi.replace(/\/+$/, '')}/public/domains/primary?${q}`, {
    accept: 'application/json',
  });
  if (!p.ok || p.status !== 200) return undefined;
  try {
    const primary = (
      JSON.parse(p.text) as { primary?: { origin?: string; basePath?: string } | null }
    ).primary;
    if (!primary?.origin) return undefined;
    const expected = `${primary.origin.replace(/\/+$/, '')}${primary.basePath ?? ''}${m[4] ?? ''}`;
    return { expected, urls: [url, expected] };
  } catch {
    return undefined;
  }
}

export async function extendedChecks(input: ExtendedInput): Promise<Check[]> {
  const want = (id: string) => !input.only || input.only.has(id);
  const { get, url, html, platformHost } = input;
  const origin = new URL(url).origin;
  const roots = input.roots?.length
    ? input.roots
    : deriveRoots(input.requestedUrl ?? url, platformHost);
  const out: Check[] = [];

  if (want('canonical-both-addresses')) {
    const sets = [...(input.addressSets ?? [])];
    if (sets.length === 0) {
      // The address the user GAVE: a platform copy that redirects (the legal
      // page went `/p/<org>/legal/<doc>` → `/legal/<org>/<doc>`) has lost the
      // org/space shape by the time it lands.
      const asked = input.requestedUrl ?? url;
      const found = await discoverPrimary(get, asked, platformHost, input.platformApi);
      if (found) sets.push(found);
    }
    out.push(await canonicalBothAddresses(get, sets));
  }

  // One crawl feeds three checks; it is skipped only when none of them is asked for.
  let pages: Probe[] = [];
  if (want('sitemap-crawl') || want('cache-consistency') || want('meta-description')) {
    const crawl = await sitemapCrawl(
      get,
      origin,
      input.robots,
      input.limit ?? DEFAULT_SAMPLE_LIMIT,
    );
    pages = crawl.pages;
    if (want('sitemap-crawl')) out.push(crawl.check);
  }
  if (want('cache-consistency')) out.push(cacheConsistency(pages));
  if (want('root-redirect')) out.push(await rootRedirect(get, roots));
  if (want('meta-description')) {
    // The page that was asked about is judged too, even when no sitemap lists it.
    const self: Probe[] = html
      ? [{ ok: true, url, status: 200, headers: new Headers(), text: html }]
      : [];
    const listed = pages.some((p) => p.url === url);
    out.push(metaDescription(listed ? pages : [...self, ...pages]));
  }
  if (want('llms-txt'))
    out.push(
      await llmsTxt(
        get,
        origin,
        roots.filter((r) => r !== origin),
        platformHost,
      ),
    );
  if (want('favicon')) {
    out.push(
      html
        ? await favicon(
            get,
            url,
            html,
            roots.filter((r) => r !== origin),
          )
        : check('favicon', 'The favicon resolves to an image', 'skip', 'No HTML to read.', ''),
    );
  }
  if (want('consent-tag'))
    out.push(
      html
        ? consentTag(html)
        : check(
            'consent-tag',
            'The consent banner is told the page language',
            'skip',
            'No HTML to read.',
            '',
          ),
    );
  if (want('white-label-leaks')) out.push(await whiteLabelLeaks(get, url, html, platformHost));
  // SEO §1: the Disallow lines for each mount's sorted / filtered copies.
  if (want('robots-params')) out.push(robotsParams(roots, origin, input.robots));
  return out;
}
