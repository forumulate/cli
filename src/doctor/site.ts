import type { Http } from '../api/http';
import type { AddressSet } from './address-checks';
import { readSitemaps, sitemapsFromRobots } from './crawl';
import type { Get } from './probe';

/**
 * `doctor --site <slug|id>`: every address of every space on a site, from the API.
 *
 * From a URL alone the doctor sees one copy of a page. The defects that bit
 * the integrator were in the OTHER copy — the platform address of a legal page
 * naming itself canonical (FMU-B01) — which nobody opens because readers never
 * get there. The API knows every address a space is served at (its
 * `readerEndpoints`: the customer's domain first, then the platform's), so this
 * asks it, and the checks then compare the copies.
 */

export interface ReaderEndpoint {
  url: string;
  kind?: string;
  primary?: boolean;
}

export interface ResolvedSpace {
  id: string;
  /** Primary first. */
  endpoints: ReaderEndpoint[];
}

export interface ResolvedSite {
  id: string;
  slug?: string;
  name?: string;
  spaces: ResolvedSpace[];
  /** The address the report is run against: the first space's primary root. */
  url?: string;
  /** Spaces whose addresses could not be read, and why. */
  problems: string[];
}

interface SiteRow {
  id: string;
  slug?: string;
  name?: string;
  spaceIds?: string[];
}

export async function resolveSite(http: Http, org: string, site: string): Promise<ResolvedSite> {
  const enc = encodeURIComponent;
  const { data } = await http.send({ method: 'GET', path: `/orgs/${enc(org)}/sites` });
  const rows = ((data as { sites?: SiteRow[]; data?: SiteRow[] }).sites ??
    (data as { data?: SiteRow[] }).data ??
    []) as SiteRow[];
  const row = rows.find((s) => s.id === site || s.slug === site);
  if (!row) {
    const known = rows.map((s) => s.slug ?? s.id).join(', ') || 'none';
    throw Object.assign(new Error(`No site "${site}" in ${org}. Sites: ${known}.`), {
      status: 404,
    });
  }
  const spaces: ResolvedSpace[] = [];
  const problems: string[] = [];
  for (const spaceId of row.spaceIds ?? []) {
    try {
      const res = await http.send({
        method: 'GET',
        path: `/orgs/${enc(org)}/spaces/${enc(spaceId)}/reader-auth`,
      });
      const endpoints = (
        (res.data as { readerEndpoints?: ReaderEndpoint[] }).readerEndpoints ?? []
      ).filter((e) => typeof e.url === 'string' && /^https?:/.test(e.url));
      // Primary first, whatever order the answer used.
      endpoints.sort((a, b) => Number(!!b.primary) - Number(!!a.primary));
      if (endpoints.length) spaces.push({ id: spaceId, endpoints });
      else problems.push(`${spaceId}: no reader addresses (private, or not published)`);
    } catch (e) {
      problems.push(`${spaceId}: ${(e as Error).message}`);
    }
  }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    spaces,
    url: spaces[0]?.endpoints[0]?.url,
    problems,
  };
}

const trim = (u: string) => u.replace(/\/+$/, '');

/**
 * The address sets the two-address check compares: each space's ROOT at every
 * address, and one real PAGE per space — the first its sitemap lists under the
 * primary root — mapped onto every other address by its path below the root.
 * A root alone would miss the legal-page defect, which only pages had.
 */
export async function addressSetsFor(get: Get, site: ResolvedSite): Promise<AddressSet[]> {
  const sets: AddressSet[] = [];
  // One sitemap read per host: a site's spaces usually share one domain.
  const urlsByOrigin = new Map<string, string[]>();
  for (const space of site.spaces) {
    if (space.endpoints.length < 2) continue;
    const roots = space.endpoints.map((e) => trim(e.url));
    const primary = roots[0]!;
    sets.push({ expected: primary, urls: roots });
    const origin = new URL(primary).origin;
    if (!urlsByOrigin.has(origin)) {
      const r = await get(`${origin}/robots.txt`);
      const robots = r.ok && r.status === 200 ? r.text : '';
      const { lists } = await readSitemaps(get, sitemapsFromRobots(robots, origin));
      urlsByOrigin.set(
        origin,
        lists.flatMap((l) => l.urls),
      );
    }
    const page = urlsByOrigin
      .get(origin)!
      .find((u) => u.startsWith(`${primary}/`) && u.length > primary.length + 1);
    if (!page) continue;
    const rest = page.slice(primary.length);
    sets.push({ expected: page, urls: roots.map((r) => `${r}${rest}`) });
  }
  return sets;
}
