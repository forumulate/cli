import { parseArgs, flag, all, has } from '../api/args';
import { Http } from '../api/http';
import { apiBaseFromEnv, siteFromEnv } from '../api-base';
import { readConfig, setting } from '../commands/config';
import { resolveToken } from '../credentials';
import { EXIT, EXIT_CODES_HELP, exitCodeForError } from '../exit-codes';
import { BASE_CHECK_IDS, runDoctor, type DoctorReport } from '../doctor';
import { DEFAULT_PLATFORM_HOST, DEFAULT_SAMPLE_LIMIT, EXTENDED_CHECK_IDS } from './extended';
import { addressSetsFor, resolveSite } from './site';
import { makeGet } from './probe';
import type { AddressSet } from './address-checks';
import { READER_AUTH_ATLAS_CHECK, readerAuthAtlasCheck } from './reader-auth-atlas';

export const DOCTOR_CHECK_IDS: readonly string[] = [
  ...BASE_CHECK_IDS,
  ...EXTENDED_CHECK_IDS,
  READER_AUTH_ATLAS_CHECK,
];

export const DOCTOR_HELP = `forumulate doctor — check a live site from the outside

Usage:
  forumulate doctor <readerUrl> [flags]
  forumulate doctor --site <slug|id> [--org <slug|id>] [flags]

Plain HTTP, no token needed for a URL: the same report against our platform, a
staging mount or any other docs host. --site asks the API for every address of
every space on a site (needs a token), and checks each copy.

Flags:
  --site <slug|id>     every member space, at its custom domain AND its
                       platform copy (token: FORUMULATE_TOKEN or \`login\`)
  --org <slug|id>      the org --site is in (default: FORUMULATE_ORG / config)
  --also <url>         another address of the same page, e.g. the platform copy
                       of a custom-domain page (repeatable)
  --only a,b           run just these checks (ids below)
  --json               the full report as JSON on stdout (nothing else there)
  --api-base <origin>  where /api/health lives, when not on the page's host
  --platform-host <h>  the hosting platform's hostname, for white-label and
                       canonical checks (default: FORUMULATE_URL's host, else
                       ${DEFAULT_PLATFORM_HOST})
  --limit <n>          sitemap URLs to sample (default ${DEFAULT_SAMPLE_LIMIT})
  --timeout <ms>       per-request timeout (default 15000)

Checks (id — what fails it):
  health                    /api/health not 2xx JSON (also tried under the mount)
  public-read               a logged-out reader is sent to sign-in
  canonical                 the page's canonical names another host
  html-untouched            a proxy rewrites the markup (email obfuscation)
  cache-headers             no Cache-Control, or no-store, on the page
  robots / sitemap          robots.txt missing, disallows the path, no Sitemap:
  crawler-access            a crawler gets a different status than a reader
  feeds                     an advertised feed does not answer 200
  images                    a picture on the page does not load
  canonical-both-addresses  a page's copies (custom domain, platform) name
                            different canonicals, or not the primary address
  sitemap-crawl             a sitemap URL redirects, 404s, is on another host or
                            names another canonical
  cache-consistency         pages of one space cached differently (public vs
                            private/no-store) with no x-forumulate-cache-reason
  root-redirect             a space root answers 302/307, or a redirect with a
                            body over 1 KB, or lands on a page canonical elsewhere
  meta-description          missing description/og:description, template text
                            ("Guides and reference, in a nested tree."), or
                            headings run together
  llms-txt                  /llms.txt missing, no H1, preset summary, links on
                            another host, slugs in titles, no sections/descriptions
  favicon                   /favicon.ico or <link rel=icon> not an image; an
                            asset path answering a large HTML page
  consent-tag               a consent manager (any CMP: Cookie Munch, Cookiebot,
                            OneTrust, Osano, Termly, Usercentrics, Didomi,
                            iubenda, Complianz, TCF) not told the page language
  white-label-leaks         a custom-domain page or its .md twin links to the
                            platform host
  robots-params             (advice) prints the Disallow lines that keep crawlers
                            off each mount's ?sort= / ?period= / ?range= copies
  reader-auth-atlas         (advice, needs --org and a token) the organization
                            uses Atlas but signs readers in another way (an
                            external_jwt route): prints the relink and the switch
                            to the Atlas reader provider (readerAuth: atlas)

Examples:
  forumulate doctor https://docs.acme.com/docs
  forumulate doctor https://acme.com/legal/privacy --also https://forumulate.com/p/acme/legal/privacy
  forumulate doctor --site main --org acme --json > doctor.json
  forumulate doctor https://acme.com/docs --only sitemap-crawl,root-redirect

In CI: packages/cli/examples/github-action-doctor.yml runs this on a schedule and
on every push, uploads the JSON report and fails the job on any FAIL.

${EXIT_CODES_HELP}
  doctor: 1 when any check FAILs; a SKIP is not a failure.`;

export interface DoctorCommandDeps {
  out: (line: string) => void;
  err: (line: string) => void;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  http?: Http;
  userAgent?: string;
  /** The global `--token` (FMU-DOC01); beats FORUMULATE_TOKEN and the stored token. */
  flagToken?: string;
}

const SWITCHES = new Set(['json', 'help', 'h']);

/** `forumulate doctor …` → an exit code. */
export async function runDoctorCommand(argv: string[], deps: DoctorCommandDeps): Promise<number> {
  const p = parseArgs(argv, SWITCHES);
  if (has(p, 'help') || has(p, 'h')) {
    deps.out(DOCTOR_HELP);
    return EXIT.OK;
  }
  const env = deps.env ?? process.env;
  const json = has(p, 'json');
  const usage = (why: string) => {
    deps.err(why);
    deps.err('Usage: forumulate doctor <readerUrl> | --site <slug|id> [--org …]  (doctor --help)');
    return EXIT.USAGE;
  };

  const only = all(p, 'only')
    .flatMap((v) => v.split(','))
    .map((v) => v.trim())
    .filter(Boolean);
  const unknown = only.filter((id) => !DOCTOR_CHECK_IDS.includes(id));
  if (unknown.length)
    return usage(
      `Unknown check id(s): ${unknown.join(', ')}. Known: ${DOCTOR_CHECK_IDS.join(', ')}.`,
    );

  const limit = flag(p, 'limit') === undefined ? undefined : Number(flag(p, 'limit'));
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0))
    return usage('--limit takes a positive whole number.');
  const timeout = flag(p, 'timeout') === undefined ? undefined : Number(flag(p, 'timeout'));
  if (timeout !== undefined && !(Number.isInteger(timeout) && timeout > 0))
    return usage('--timeout takes a positive number of milliseconds.');

  let url = p.positionals[0];
  if (p.positionals.length > 1) return usage(`One URL at a time; got ${p.positionals.join(' ')}.`);
  if (url !== undefined) {
    try {
      const parsed = new URL(url);
      if (!/^https?:$/.test(parsed.protocol)) throw new Error('not http');
    } catch {
      return usage(`"${url}" is not an http(s) URL.`);
    }
  }

  const siteUrl = siteFromEnv(env);
  const platformHost = (
    flag(p, 'platform-host') ??
    (siteUrl ? new URL(siteUrl).host : undefined) ??
    DEFAULT_PLATFORM_HOST
  ).toLowerCase();
  const fetchImpl = deps.fetchImpl ?? fetch;
  const addressSets: AddressSet[] = [];
  let roots: string[] | undefined;

  const site = flag(p, 'site');
  // The organization's own checks (reader-auth-atlas) need an org and a token;
  // `--site` needs both anyway.
  const orgFlag = flag(p, 'org');
  const orgRef = site || orgFlag ? setting('org', orgFlag, env, readConfig(env)) : undefined;
  const apiHttp = () => {
    const baseUrl = apiBaseFromEnv(env);
    return (
      deps.http ??
      new Http({
        baseUrl,
        token: resolveToken(baseUrl, env, deps.flagToken),
        userAgent: deps.userAgent ?? '@forumulate/cli',
        fetch: fetchImpl,
      })
    );
  };
  if (site) {
    const org = orgRef;
    if (!org)
      return usage('--site needs --org <slug|id> (or FORUMULATE_ORG, or `config set org`).');
    const http = apiHttp();
    try {
      const resolved = await resolveSite(http, org, site);
      for (const problem of resolved.problems) deps.err(`note: ${problem}`);
      if (!url) url = resolved.url;
      if (!url) {
        deps.err(`Site ${site} has no space with a public address to check.`);
        return EXIT.NOT_FOUND;
      }
      roots = resolved.spaces.flatMap((s) => s.endpoints.map((e) => e.url.replace(/\/+$/, '')));
      const get = makeGet({ fetchImpl, timeoutMs: timeout });
      addressSets.push(...(await addressSetsFor(get, resolved)));
    } catch (e) {
      const err = e as { status?: number; message?: string };
      deps.err(`Could not read site ${site}: ${err.message ?? String(e)}`);
      return exitCodeForError(e);
    }
  }
  if (!url) return usage('Give a reader URL, or --site <slug|id>.');

  const also = all(p, 'also');
  if (also.length) addressSets.push({ urls: [url, ...also] });

  const report = await runDoctor({
    url,
    apiBase: flag(p, 'api-base') ?? siteUrl,
    fetchImpl,
    only: only.length ? only : undefined,
    platformHost,
    // The platform the copies are compared against: the configured API when
    // one is, else the API of whichever host --platform-host named.
    platformApi:
      env.FORUMULATE_API_URL?.trim() || env.FORUMULATE_URL?.trim()
        ? apiBaseFromEnv(env)
        : `https://${platformHost}/api`,
    addressSets: addressSets.length ? addressSets : undefined,
    roots,
    limit,
    timeoutMs: timeout,
  });
  // FMU-X01: the organization's reader sign-in, from the API's own recommendation.
  if (orgRef && (!only.length || only.includes(READER_AUTH_ATLAS_CHECK))) {
    const c = await readerAuthAtlasCheck(apiHttp(), orgRef);
    report.checks.push(c);
    if (c.state === 'pass') report.passed += 1;
    else if (c.state === 'fail') report.failed += 1;
    else report.warnings += 1;
  }
  if (json) deps.out(JSON.stringify(report, null, 2));
  else printReport(report, deps.out);
  return report.failed > 0 ? EXIT.FAILED : EXIT.OK;
}

export function printReport(report: DoctorReport, out: (l: string) => void): void {
  out(`Checking ${report.url}`);
  for (const c of report.checks) {
    const mark = c.state === 'pass' ? 'PASS' : c.state === 'fail' ? 'FAIL' : 'SKIP';
    out(`  ${mark}  ${c.id}  ${c.title}`);
    // A detail may be several lines (robots-params prints a robots.txt block).
    for (const line of c.detail.split('\n')) out(`        ${line}`);
    if (c.state === 'fail' && c.matters) out(`        why it matters: ${c.matters}`);
  }
  out(`${report.passed} passed, ${report.failed} failed, ${report.warnings} skipped`);
}
