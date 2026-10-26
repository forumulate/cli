import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/** One outside link's verdict. */
export interface Verdict {
  ok: boolean;
  status: number;
  location?: string;
  reason?: 'external_unreachable' | 'external_redirect';
  /** When it was asked, ms since the epoch — for the cache. */
  at: number;
}

export type Fetcher = (
  url: string,
  init: { method: string; redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> },
) => Promise<{ status: number; headers: { get(name: string): string | null } }>;

export interface ExternalOptions {
  /** Hosts a redirect may land on and still pass: `same-host`, `docs.x.com`, `*.x.com`, `*`. */
  allowRedirects: string[];
  concurrency?: number;
  /** Gap between two requests to one host, ms. */
  perHostGapMs?: number;
  timeoutMs?: number;
  /** Where verdicts are kept between runs; null for none. */
  cacheFile?: string | null;
  okTtlMs?: number;
  brokenTtlMs?: number;
  fetch?: Fetcher;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** Where the verdicts live: `$XDG_CACHE_HOME/forumulate/link-check.json`. */
export function defaultCacheFile(env: NodeJS.ProcessEnv = process.env): string {
  const base = env.XDG_CACHE_HOME || join(homedir(), '.cache');
  return join(base, 'forumulate', 'link-check.json');
}

/**
 * Whether a redirect from `from` to `location` is one the caller accepts —
 * the same rule as the API's `redirectAllowed` (packages/shared docs-workflow),
 * mirrored because this package ships alone.
 */
export function redirectAllowed(from: string, location: string, allow: readonly string[]): boolean {
  let a: URL;
  let b: URL;
  try {
    a = new URL(from);
    b = new URL(location, from);
  } catch {
    return false;
  }
  const host = b.hostname.toLowerCase();
  for (const raw of allow) {
    const p = raw.trim().toLowerCase();
    if (!p) continue;
    if (p === 'same-host' && host === a.hostname.toLowerCase()) return true;
    if (p === '*') return true;
    if (p.startsWith('*.') && (host === p.slice(2) || host.endsWith(p.slice(1)))) return true;
    if (host === p) return true;
  }
  return false;
}

/**
 * Outside links, checked the way the API checks them (FMU-F05): no redirect is
 * followed — a 3xx passes only to an allowed host, else it is
 * `external_redirect` naming where it goes; `HEAD` first, `GET` when a host
 * refuses `HEAD`; a few requests at once and a gap between two to the same
 * host, so a docs folder with 300 links to one site is not a burst; and a
 * verdict file, so a second run in a minute asks nothing (a day for a working
 * link, an hour for a broken one).
 */
export class ExternalChecker {
  private readonly last = new Map<string, number>();
  private cache: Record<string, Verdict> = {};
  private readonly o: Required<Omit<ExternalOptions, 'fetch' | 'cacheFile'>> & {
    fetch: Fetcher;
    cacheFile: string | null;
  };

  constructor(opts: ExternalOptions) {
    this.o = {
      concurrency: 4,
      perHostGapMs: 300,
      timeoutMs: 10_000,
      okTtlMs: 86_400_000,
      brokenTtlMs: 3_600_000,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      now: () => Date.now(),
      ...opts,
      fetch: opts.fetch ?? (globalThis.fetch as unknown as Fetcher),
      cacheFile: opts.cacheFile === undefined ? null : opts.cacheFile,
    };
    if (this.o.cacheFile && existsSync(this.o.cacheFile)) {
      try {
        this.cache = JSON.parse(readFileSync(this.o.cacheFile, 'utf8')) as Record<string, Verdict>;
      } catch {
        this.cache = {};
      }
    }
  }

  async checkAll(urls: Iterable<string>): Promise<Map<string, Verdict>> {
    const queue = [...new Set(urls)];
    const out = new Map<string, Verdict>();
    const worker = async () => {
      for (let u = queue.shift(); u !== undefined; u = queue.shift()) out.set(u, await this.check(u));
    };
    await Promise.all(Array.from({ length: Math.min(this.o.concurrency, queue.length) }, worker));
    this.save();
    return out;
  }

  private fresh(v: Verdict | undefined): v is Verdict {
    if (!v) return false;
    return this.o.now() - v.at < (v.ok ? this.o.okTtlMs : this.o.brokenTtlMs);
  }

  async check(url: string): Promise<Verdict> {
    const hit = this.cache[url];
    if (this.fresh(hit)) return hit;
    const v = await this.ask(url);
    this.cache[url] = v;
    return v;
  }

  private async pace(url: string): Promise<void> {
    let host = '';
    try {
      host = new URL(url).host;
    } catch {
      return;
    }
    const due = (this.last.get(host) ?? 0) + this.o.perHostGapMs;
    this.last.set(host, Math.max(this.o.now(), due));
    const wait = due - this.o.now();
    if (wait > 0) await this.o.sleep(wait);
  }

  private async request(url: string, method: string) {
    await this.pace(url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.o.timeoutMs);
    try {
      return await this.o.fetch(url, {
        method,
        redirect: 'manual',
        signal: ctrl.signal,
        headers: { 'user-agent': 'forumulate-cli link check', accept: 'text/html,*/*;q=0.8' },
      });
    } finally {
      clearTimeout(timer);
    }
  }

  private async ask(url: string): Promise<Verdict> {
    const at = this.o.now();
    try {
      let res = await this.request(url, 'HEAD');
      if ([403, 405, 501].includes(res.status)) res = await this.request(url, 'GET');
      const status = res.status;
      if (status >= 200 && status < 300) return { ok: true, status, at };
      if (status >= 300 && status < 400) {
        const raw = res.headers.get('location') ?? '';
        let location = raw;
        try {
          location = new URL(raw, url).toString();
        } catch {
          /* kept as sent */
        }
        if (raw && redirectAllowed(url, location, this.o.allowRedirects))
          return { ok: true, status, location, at };
        return { ok: false, status, location, reason: 'external_redirect', at };
      }
      return { ok: false, status, reason: 'external_unreachable', at };
    } catch {
      return { ok: false, status: 0, reason: 'external_unreachable', at };
    }
  }

  private save(): void {
    if (!this.o.cacheFile) return;
    try {
      mkdirSync(dirname(this.o.cacheFile), { recursive: true });
      // Only verdicts still worth keeping, so the file does not grow forever.
      const keep = Object.fromEntries(Object.entries(this.cache).filter(([, v]) => this.fresh(v)));
      writeFileSync(this.o.cacheFile, JSON.stringify(keep));
    } catch {
      /* a cache that cannot be written is only a slower next run */
    }
  }
}
