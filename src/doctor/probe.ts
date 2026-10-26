import type { Check } from '../conformance';

/**
 * The HTTP and HTML plumbing every doctor check shares.
 *
 * One `get`, so every request the doctor makes has the same three properties:
 * it never follows a redirect on its own (a redirect is usually the thing being
 * checked, and `fetch`'s default hides both the status and the body), it gives
 * up after a fixed time (one hung address must not hang a CI job), and it never
 * throws (a refused connection is a finding, not a crash).
 */
export type Probe =
  | { ok: true; url: string; status: number; headers: Headers; text: string }
  | { ok: false; url: string; error: string };

export interface ProbeOptions {
  fetchImpl: typeof fetch;
  /** Per-request budget. A crawl of a hundred pages must not wait on one forever. */
  timeoutMs?: number;
}

export const DEFAULT_TIMEOUT_MS = 15_000;

export function makeGet(opts: ProbeOptions) {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return async (url: string, headers: Record<string, string> = {}): Promise<Probe> => {
    const ctl = typeof AbortController === 'function' ? new AbortController() : undefined;
    const timer = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : undefined;
    try {
      const res = await opts.fetchImpl(url, {
        headers,
        redirect: 'manual',
        ...(ctl ? { signal: ctl.signal } : {}),
      });
      const text = await res.text();
      return { ok: true, url, status: res.status, headers: res.headers, text };
    } catch (e) {
      const aborted = e instanceof Error && e.name === 'AbortError';
      return {
        ok: false,
        url,
        error: aborted
          ? `no answer within ${timeoutMs} ms`
          : e instanceof Error
            ? e.message
            : String(e),
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
}

export type Get = ReturnType<typeof makeGet>;

/**
 * Run `fn` over `items`, at most `limit` at a time, in input order.
 *
 * Bounded on purpose: the doctor runs from a laptop or a CI runner against a
 * customer's production site, and a hundred simultaneous requests is how a
 * health check becomes the incident it was meant to catch.
 */
export async function pool<T, R>(
  items: T[],
  limit: number,
  fn: (t: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Follow redirects by hand (bounded), keeping every hop — the hops are what a check judges. */
export async function follow(
  get: Get,
  url: string,
  headers: Record<string, string> = {},
  maxHops = 5,
): Promise<{ hops: Probe[]; final: Probe }> {
  const hops: Probe[] = [];
  let at = url;
  for (let i = 0; i <= maxHops; i++) {
    const p = await get(at, headers);
    hops.push(p);
    if (!p.ok || p.status < 300 || p.status >= 400) return { hops, final: p };
    const loc = p.headers.get('location');
    if (!loc) return { hops, final: p };
    at = new URL(loc, at).toString();
  }
  return { hops, final: hops[hops.length - 1]! };
}

/** One attribute's value from one tag's source, quoted or not. */
function attrOf(tag: string, name: string): string | undefined {
  const m = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

export function tags(html: string, name: string): string[] {
  return html.match(new RegExp(`<${name}\\b[^>]*>`, 'gi')) ?? [];
}

export const attr = attrOf;

/** `<link rel="canonical">`, absolute against `base`, or undefined. */
export function canonicalOf(html: string, base: string): string | undefined {
  for (const t of tags(html, 'link')) {
    const rel = (attrOf(t, 'rel') ?? '').toLowerCase().split(/\s+/);
    if (!rel.includes('canonical')) continue;
    const href = attrOf(t, 'href');
    if (!href) continue;
    try {
      return new URL(decodeEntities(href), base).toString();
    } catch {
      return href;
    }
  }
  return undefined;
}

/** `<meta name|property=X content=…>`. */
export function metaOf(html: string, key: string): string | undefined {
  for (const t of tags(html, 'meta')) {
    const k = (attrOf(t, 'name') ?? attrOf(t, 'property') ?? '').toLowerCase();
    if (k === key.toLowerCase()) return decodeEntities(attrOf(t, 'content') ?? '');
  }
  return undefined;
}

/** The document's declared language (`<html lang>`), lower-cased, or undefined. */
export function htmlLang(html: string): string | undefined {
  const t = tags(html, 'html')[0];
  return t ? attrOf(t, 'lang')?.toLowerCase() : undefined;
}

export function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

export function hostOf(href: string): string | undefined {
  try {
    return new URL(href).host.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Compare two URLs the way a search engine would: no fragment, no trailing slash. */
export function sameUrl(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const norm = (u: string) => {
    try {
      const x = new URL(u);
      x.hash = '';
      return `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '') || '/'}${x.search}`;
    } catch {
      return u;
    }
  };
  return norm(a) === norm(b);
}

export function describeProbe(p: Probe): string {
  return p.ok ? `${p.status}` : p.error;
}

/** A check under construction: the shape `runDoctor` reports. */
export function check(
  id: string,
  title: string,
  state: Check['state'],
  detail: string,
  matters = '',
): Check {
  return { id, title, state, detail, matters };
}

/** At most `n` items of a list in a detail line, and how many were left out. */
export function some(list: string[], n = 5): string {
  const shown = list.slice(0, n).join('; ');
  return list.length > n ? `${shown}; …and ${list.length - n} more` : shown;
}
