import type { Check } from '../conformance';
import {
  canonicalOf,
  check,
  describeProbe,
  follow,
  hostOf,
  sameUrl,
  some,
  type Get,
} from './probe';

/**
 * Checks about a page that lives at more than one address.
 *
 * A hosted docs platform serves every published page twice: on its own host
 * (`platform.example/p/<org>/<space>/<page>`) and on the customer's domain.
 * Search engines must be told, by BOTH copies, that the customer's address is
 * the real one. The platform copy of a LEGAL page redirected to a third
 * address that named itself canonical (FMU-B01), so the customer's legal pages
 * competed with a copy on our host. Nothing on the customer's domain showed it.
 */

/** One page at its several addresses: the primary (canonical) one first when known. */
export interface AddressSet {
  /** What the canonical of every copy should be, when it is known. */
  expected?: string;
  urls: string[];
}

export async function canonicalBothAddresses(get: Get, sets: AddressSet[]): Promise<Check> {
  const title = 'Every address of a page names the same canonical';
  const usable = sets.filter((s) => s.urls.length >= 2 || s.expected);
  if (usable.length === 0)
    return check(
      'canonical-both-addresses',
      title,
      'skip',
      'Only one address of this page is known. Pass --also <the other address>, or --site <slug> to have them looked up.',
      '',
    );
  const bad: string[] = [];
  const good: string[] = [];
  for (const set of usable) {
    const before = bad.length;
    const seen: { url: string; canonical?: string; final: string }[] = [];
    for (const url of [...new Set(set.urls)]) {
      const { hops, final } = await follow(get, url, { accept: 'text/html' });
      const landed = hops.length > 1 && final.ok ? final.url : url;
      if (!final.ok || final.status !== 200) {
        bad.push(`${url} → ${describeProbe(final)}`);
        continue;
      }
      seen.push({ url, final: landed, canonical: canonicalOf(final.text, landed) });
    }
    const expected = set.expected ?? seen.find((s) => s.canonical)?.canonical;
    for (const s of seen) {
      const via = s.final !== s.url ? ` (via ${s.final})` : '';
      if (!s.canonical) bad.push(`${s.url}${via} declares no canonical`);
      else if (expected && !sameUrl(s.canonical, expected))
        bad.push(`${s.url}${via} names ${s.canonical}, expected ${expected}`);
    }
    if (seen.length && bad.length === before)
      good.push(`${seen.map((s) => s.url).join(' and ')} → ${expected}`);
  }
  return check(
    'canonical-both-addresses',
    title,
    bad.length ? 'fail' : 'pass',
    bad.length ? some(bad) : some(good),
    bad.length
      ? 'Two copies with different canonicals compete in search, and the platform copy can outrank the customer’s own domain.'
      : '',
  );
}

/**
 * Strip what a browser does not show and a reader cannot click: scripts,
 * styles, and `<link>` tags (preloads, stylesheets). A white-label site may
 * well load its JavaScript from the platform's CDN — that is infrastructure,
 * not branding — so only the markup a person sees, and the links they follow,
 * are judged.
 */
export function visibleMarkup(html: string): string {
  return html
    .replace(/<script\b[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[\s\S]*?<\/style>/gi, '')
    .replace(/<link\b[^>]*>/gi, '')
    .replace(/<meta\b[^>]*>/gi, '');
}

/** Platform URLs with a path: a bare-origin link is a "powered by" badge, which is a setting, not a leak. */
export function platformMentions(text: string, platformHost: string): string[] {
  const host = platformHost.replace(/[.]/g, '\\.');
  const re = new RegExp(`https?://(?:www\\.)?${host}(/[^\\s"'<>)\\]\`]+)`, 'gi');
  return [
    ...new Set(
      [...text.matchAll(re)].map((m) => m[0]).filter((u) => !/^https?:\/\/[^/]+\/?$/.test(u)),
    ),
  ];
}

/**
 * `white-label-leaks`: a page on the customer's domain does not send its
 * readers, or its agents, back to the platform's host.
 *
 * The Markdown twin of a reference page on a white-label domain ended with a
 * "For AI agents" block pointing at the platform's API host for llms-full.txt
 * and MCP, while the same files existed on the customer's domain (FMU-B15).
 * The HTML looked clean; the agent-facing copy was the leak. Both are read.
 */
export async function whiteLabelLeaks(
  get: Get,
  pageUrl: string,
  html: string,
  platformHost: string,
): Promise<Check> {
  const title = 'No platform URLs on a custom-domain page';
  const host = hostOf(pageUrl);
  if (!host || host === platformHost.toLowerCase() || host === `www.${platformHost.toLowerCase()}`)
    return check(
      'white-label-leaks',
      title,
      'skip',
      `${pageUrl} is on the platform host itself.`,
      '',
    );
  const leaks: string[] = platformMentions(visibleMarkup(html), platformHost).map(
    (u) => `HTML: ${u}`,
  );
  const u = new URL(pageUrl);
  const mdUrl = `${u.origin}${u.pathname.replace(/\/+$/, '')}.md`;
  const md = await get(mdUrl, { accept: 'text/markdown,text/plain' });
  const isMd =
    md.ok && md.status === 200 && !/text\/html/i.test(md.headers.get('content-type') ?? '');
  if (isMd) for (const m of platformMentions(md.text, platformHost)) leaks.push(`${mdUrl}: ${m}`);
  return check(
    'white-label-leaks',
    title,
    leaks.length ? 'fail' : 'pass',
    leaks.length
      ? some(leaks)
      : `No ${platformHost} links in the page${isMd ? ' or its Markdown twin' : ''}.`,
    leaks.length
      ? `A white-label site that links readers or agents to ${platformHost} exposes the platform behind it and splits its traffic; serve the same resources under the customer's domain.`
      : '',
  );
}

/**
 * Consent managers, and where each one is told which language to speak.
 *
 * Matched on the vendor's loader host or global, so a CMP is recognised
 * whether it is a `<script>` in the HTML, a preload of a script a framework
 * injects later, or a config object in a serialized payload. The language
 * hints are each vendor's documented attribute or query parameter; a vendor
 * not listed here is still found by the generic hints below.
 */
const CMPS: { name: string; match: RegExp }[] = [
  { name: 'Cookie Munch', match: /cookiemunch\.(?:net|com)/i },
  { name: 'Cookiebot', match: /consent\.cookiebot\.(?:com|eu)|uc\.js/i },
  { name: 'OneTrust', match: /otSDKStub|cdn\.cookielaw\.org|onetrust\.com/i },
  { name: 'Osano', match: /cmp\.osano\.com/i },
  { name: 'Termly', match: /app\.termly\.io/i },
  { name: 'Usercentrics', match: /usercentrics\.eu/i },
  { name: 'Didomi', match: /sdk\.privacy-center\.org|didomi/i },
  { name: 'iubenda', match: /cdn\.iubenda\.com/i },
  { name: 'Complianz', match: /complianz/i },
  { name: 'TCF CMP', match: /__tcfapi/ },
];

/**
 * Where a CMP's language is stated, across vendors: `data-culture` (Cookie
 * Munch, Cookiebot), `data-language` (OneTrust's `data-document-language`,
 * Usercentrics), `data-lang`, a `culture`/`language` key in a serialized
 * config, or a `?culture=`/`?language=`/`?lang=`/`?hl=` loader parameter.
 */
const LANGUAGE_HINTS = [
  /data-(?:document-)?(?:culture|language|lang)\s*=\s*\\?["']([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)/g,
  /\\?["'](?:culture|language|lang|uiLanguage)\\?["']\s*:\s*\\?["']([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)/g,
  /[?&](?:culture|language|lang|hl)=([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})?)/g,
];

/**
 * How far around a vendor mention a language hint still belongs to it. Small
 * on purpose: a framework's serialized payload also carries the PAGE's
 * language a few kilobytes away, and reading that as the banner's would pass
 * exactly the page this check exists to fail.
 */
const HINT_WINDOW = 600;

export function findCmps(html: string): { name: string; at: number[] }[] {
  const out: { name: string; at: number[] }[] = [];
  for (const cmp of CMPS) {
    const re = new RegExp(
      cmp.match.source,
      cmp.match.flags.includes('g') ? cmp.match.flags : `${cmp.match.flags}g`,
    );
    const at = [...html.matchAll(re)].map((m) => m.index ?? 0);
    if (at.length) out.push({ name: cmp.name, at });
  }
  return out;
}

export function languageHints(html: string, at: number[]): string[] {
  const found = new Set<string>();
  for (const i of at) {
    const win = html.slice(Math.max(0, i - HINT_WINDOW), i + HINT_WINDOW);
    for (const re of LANGUAGE_HINTS)
      for (const m of win.matchAll(new RegExp(re.source, re.flags))) found.add(m[1]!.toLowerCase());
  }
  return [...found];
}

const primary = (tag: string) => tag.toLowerCase().split(/[-_]/)[0]!;

/**
 * `consent-tag`: the cookie banner speaks the page's language.
 *
 * The CMP tag carried no culture, so the banner followed the BROWSER's
 * language rather than the page's (FMU-B17, S05): a German reader on the
 * English page got a German banner over English text, and on a translated
 * page the banner and the page disagree for everyone whose browser is set to
 * anything else. Consent shown in a language the page is not in is a consent
 * a regulator can question. No CMP on the page is a skip, not a pass.
 */
export function consentTag(html: string): Check {
  const title = 'The consent banner is told the page language';
  const cmps = findCmps(html);
  if (cmps.length === 0)
    return check('consent-tag', title, 'skip', 'No consent manager found on this page.', '');
  const lang = /<html\b[^>]*\blang\s*=\s*["']?([A-Za-z-]+)/i.exec(html)?.[1]?.toLowerCase();
  const names = cmps.map((c) => c.name).join(', ');
  const matters =
    'A banner that follows the browser rather than the page asks for consent in a language the page is not written in.';
  if (!lang)
    return check(
      'consent-tag',
      title,
      'fail',
      `${names} found, but the page declares no <html lang>.`,
      matters,
    );
  const hints = languageHints(
    html,
    cmps.flatMap((c) => c.at),
  );
  if (hints.length === 0)
    return check(
      'consent-tag',
      title,
      'fail',
      `${names} is given no language (no data-culture / data-language / language parameter); the banner will follow the browser, while the page is "${lang}".`,
      matters,
    );
  const wrong = hints.filter((h) => primary(h) !== primary(lang));
  return check(
    'consent-tag',
    title,
    wrong.length ? 'fail' : 'pass',
    wrong.length
      ? `${names} is told "${wrong.join(', ')}" on a "${lang}" page.`
      : `${names} is told "${hints.join(', ')}", matching the page ("${lang}").`,
    wrong.length ? matters : '',
  );
}
