import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { ForumulateClient } from '@forumulate/sdk';
import type { LiveCollection, LivePage, LivePost } from './types';

/**
 * Every call the publisher makes, through `@forumulate/sdk`.
 *
 * Two things every customer publisher re-learned are built in here once:
 *
 *  - A 429 is a pause, not a failure. Reading 38 pages as fast as the event
 *    loop allows is indistinguishable from a scraper (an earlier publisher met
 *    this after its import had already landed, and reported a crash on work
 *    that succeeded). Retries honour `Retry-After`, then back off.
 *  - Writes are paced. Per-page reorder is one request per page, and
 *    a publisher that fires 400 of them at once spends the rest of the run in
 *    429s.
 *
 * And one that is ours: a dry run CANNOT write. Every mutating method checks
 * `readOnly` and throws, so a planning bug fails loudly instead of quietly
 * publishing.
 */
export interface ApiOptions {
  client: ForumulateClient;
  /** Whether a token is present — decides authenticated vs public reads. */
  authed: boolean;
  readOnly: boolean;
  /** Minimum gap between writes, ms. */
  paceMs: number;
  /** Multipart upload is the one call the SDK's JSON `request` cannot make. */
  upload?: (path: string, form: FormData) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

const sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
type Q = Record<string, string | number | boolean | undefined>;
export const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

export class PublishApi {
  private lastWrite = 0;
  /** Writes this run made, for the summary — and for a test to assert none happened. */
  writes = 0;
  constructor(readonly opts: ApiOptions) {}

  private async call<T>(
    method: string,
    path: string,
    body?: unknown,
    query?: Q,
    headers?: Record<string, string>,
  ): Promise<T> {
    const sleep = this.opts.sleep ?? sleeper;
    const write = method !== 'GET';
    if (write && this.opts.readOnly) throw new Error(`dry run tried to write: ${method} ${path}`);
    for (let attempt = 0; ; attempt++) {
      if (write) {
        const wait = this.lastWrite + this.opts.paceMs - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastWrite = Date.now();
      }
      try {
        const res = await this.opts.client.request<T>(method, path, { body, query, headers });
        if (write) this.writes++;
        return res;
      } catch (e) {
        const status = (e as { status?: number }).status;
        // 429 and the transient 5xx a deploy produces; never a 4xx that means "no".
        if ((status === 429 || status === 502 || status === 503) && attempt < 5) {
          await sleep(2000 * (attempt + 1));
          continue;
        }
        throw e;
      }
    }
  }
  get<T>(path: string, query?: Q) {
    return this.call<T>('GET', path, undefined, query);
  }
  post<T>(path: string, body: unknown = {}, headers?: Record<string, string>) {
    return this.call<T>('POST', path, body, undefined, headers);
  }
  patch<T>(path: string, body: unknown) {
    return this.call<T>('PATCH', path, body);
  }
  put<T>(path: string, body: unknown) {
    return this.call<T>('PUT', path, body);
  }
  del<T>(path: string) {
    return this.call<T>('DELETE', path);
  }

  /** Walk a cursor-paged list to the end. */
  async all<T>(path: string, key: string, query: Q = {}): Promise<T[]> {
    const out: T[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 1000; i++) {
      const res = await this.get<Record<string, unknown>>(path, {
        ...query,
        ...(cursor ? { cursor } : {}),
      });
      out.push(...((res[key] as T[]) ?? []));
      const page = res.page as
        { hasMore?: boolean; has_more?: boolean; nextCursor?: string | null } | undefined;
      cursor = page?.nextCursor ?? undefined;
      if (!(page?.hasMore ?? page?.has_more) || !cursor) break;
    }
    return out;
  }

  // ── Resolution ─────────────────────────────────────────────────────────────

  async orgId(ref: string): Promise<string> {
    if (isUuid(ref) || !this.opts.authed) return ref;
    const { orgs } = await this.get<{ orgs: { id: string; slug: string }[] }>('/orgs');
    const hit = orgs.find((o) => o.slug === ref || o.id === ref);
    if (!hit)
      throw new Error(
        `No organization "${ref}" for this token (it sees: ${orgs.map((o) => o.slug).join(', ') || 'none'})`,
      );
    return hit.id;
  }

  /** The space by id or slug, or null when it does not exist. */
  async space(
    org: string,
    ref: string,
  ): Promise<{ id: string; slug: string; type: string; orgId: string } | null> {
    if (!this.opts.authed) {
      try {
        const r = await this.get<{
          space: { id: string; slug: string; type: string };
          organization: { id: string };
        }>(`/public/orgs/${org}/spaces/${ref}`);
        return { ...r.space, orgId: r.organization.id };
      } catch (e) {
        if ((e as { status?: number }).status === 404) return null;
        throw e;
      }
    }
    const spaces = await this.all<{ id: string; slug: string; type: string }>(
      `/orgs/${org}/spaces`,
      'spaces',
      { limit: 500 },
    );
    const hit = spaces.find((s) => s.id === ref || s.slug === ref);
    return hit ? { ...hit, orgId: org } : null;
  }

  // ── Docs state ─────────────────────────────────────────────────────────────

  /**
   * Collections and pages as they are now. Anonymous reads see only what is
   * published — the plan says so rather than presenting a partial view as whole.
   */
  async docs(
    org: string,
    space: string,
  ): Promise<{
    collections: LiveCollection[];
    pages: LivePage[];
    fieldKeys: string[];
    publicRows: Map<string, Record<string, unknown>>;
  }> {
    const publicRows = new Map<string, Record<string, unknown>>();
    if (!this.opts.authed) {
      const r = await this.get<{
        shape?: { params?: { key: string }[] };
        collections: (LiveCollection & {
          pages?: (LivePage & Record<string, unknown> & { children?: unknown[] })[];
        })[];
      }>(`/public/orgs/${org}/spaces/${space}`);
      const pages: LivePage[] = [];
      const flatten = (
        rows: (Record<string, unknown> & { children?: unknown[] })[],
        collectionId: string,
      ) => {
        for (const p of rows) {
          publicRows.set(String(p.id), p);
          pages.push({
            id: String(p.id),
            slug: String(p.slug),
            title: String(p.title),
            collectionId,
            parentId: (p.parentId as string | null) ?? null,
            sortKey: String(p.sortKey ?? ''),
            published: p.hasLive !== false,
          });
          if (Array.isArray(p.children)) flatten(p.children as never, collectionId);
        }
      };
      for (const c of r.collections ?? []) flatten((c.pages ?? []) as never, c.id);
      const collections = (r.collections ?? []).map((c, i) => ({
        id: c.id,
        slug: c.slug,
        name: c.name,
        isDefault: Boolean(c.isDefault),
        sortKey: String(i).padStart(6, '0'),
        nav: c.nav,
      }));
      return {
        collections,
        pages,
        fieldKeys: (r.shape?.params ?? []).map((p) => p.key),
        publicRows,
      };
    }
    const [collections, rows, shape] = await Promise.all([
      this.all<LiveCollection>(`/orgs/${org}/spaces/${space}/collections`, 'collections', {
        limit: 500,
      }),
      this.all<LivePage & { status?: string; versionKey?: string; locale?: string }>(
        `/orgs/${org}/spaces/${space}/pages`,
        'pages',
        { limit: 1000 },
      ),
      this.get<{ shape?: { params?: { key: string }[] } }>(
        `/orgs/${org}/spaces/${space}/shape`,
      ).catch(() => ({ shape: undefined })),
    ]);
    // Versions and translations are clones carrying the same slug; the
    // publisher writes the primary, so it reads the primary.
    const pages = rows
      .filter(
        (p) => (p.versionKey ?? 'default') === 'default' && (p.locale ?? 'default') === 'default',
      )
      .map((p) => ({
        ...p,
        published: p.status ? p.status === 'published' : p.published !== false,
      }));
    return {
      collections,
      pages,
      fieldKeys: (shape.shape?.params ?? []).map((p) => p.key),
      publicRows,
    };
  }

  /** Every page's markdown, in one paged walk when authenticated. */
  async markdownById(org: string, space: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!this.opts.authed) return out;
    const items = await this.all<{ id: string; markdown?: string }>(
      `/orgs/${org}/spaces/${space}/items`,
      'items',
      { limit: 50, include: 'body' },
    );
    for (const i of items) if (typeof i.markdown === 'string') out.set(i.id, i.markdown);
    return out;
  }

  /** One published page's markdown, the way a reader (or an agent) gets it. */
  async publicMarkdown(org: string, space: string, pageId: string): Promise<string | null> {
    try {
      const res = await this.opts.client.request<Response>(
        'GET',
        `/public/orgs/${org}/spaces/${space}/pages/${pageId}.md`,
        { raw: true },
      );
      return await res.text();
    } catch (e) {
      const status = (e as { status?: number }).status;
      if (status === 404) return null;
      if (status === 429) {
        await (this.opts.sleep ?? sleeper)(3000);
        return this.publicMarkdown(org, space, pageId);
      }
      throw e;
    }
  }

  async pageMeta(org: string, space: string, pageId: string): Promise<Record<string, unknown>> {
    const r = await this.get<{ metadata: Record<string, unknown> }>(
      `/orgs/${org}/spaces/${space}/pages/${pageId}/metadata`,
    );
    return r.metadata ?? {};
  }

  // ── Posts state ────────────────────────────────────────────────────────────

  async posts(org: string, space: string, type: string): Promise<LivePost[] | null> {
    if (this.opts.authed) {
      const items = await this.all<LivePost & { markdown?: string }>(
        `/orgs/${org}/spaces/${space}/items`,
        'items',
        { limit: 50, include: 'sections,body' },
      );
      return items.filter((i) => i.slug);
    }
    if (type !== 'BLOG') return null;
    const rows = await this.all<{ id: string; slug: string; title: string }>(
      `/public/orgs/${org}/spaces/${space}/blog`,
      'articles',
      { limit: 100 },
    );
    return rows.map((r) => ({ ...r, published: true }));
  }

  async shape(
    org: string,
    space: string,
  ): Promise<{
    sections: { key: string; required?: boolean; role?: string; schemaProperty?: string }[];
    params: { key: string }[];
  }> {
    if (!this.opts.authed) {
      const r = await this.get<{ shape?: { sections?: never[]; params?: never[] } }>(
        `/public/orgs/${org}/spaces/${space}`,
      ).catch(() => ({ shape: undefined }));
      return { sections: r.shape?.sections ?? [], params: r.shape?.params ?? [] };
    }
    const r = await this.get<{ shape: { sections?: never[]; params?: never[] } }>(
      `/orgs/${org}/spaces/${space}/shape`,
    );
    return { sections: r.shape?.sections ?? [], params: r.shape?.params ?? [] };
  }

  // ── Assets ─────────────────────────────────────────────────────────────────

  async assets(org: string, space: string): Promise<Map<string, string>> {
    if (!this.opts.authed) return new Map();
    const rows = await this.all<{ filename: string; url: string }>(
      `/orgs/${org}/spaces/${space}/assets`,
      'assets',
      { limit: 500 },
    );
    return new Map(rows.map((a) => [a.filename, a.url]));
  }

  /**
   * Upload once, by content. The stored name carries a hash of the bytes, so a
   * re-run finds the asset it uploaded last time instead of storing a copy per
   * run — and a changed image gets a new name, so no cache serves the old one.
   */
  async upload(
    org: string,
    space: string,
    abs: string,
    existing: Map<string, string>,
  ): Promise<string> {
    const name = assetName(abs);
    const known = existing.get(name);
    if (known) return known;
    if (this.opts.readOnly) throw new Error(`dry run tried to upload ${abs}`);
    if (!this.opts.upload) throw new Error('asset upload is not available in this environment');
    const form = new FormData();
    form.set('file', new Blob([readFileSync(abs)]), name);
    const res = (await this.opts.upload(`/orgs/${org}/spaces/${space}/assets`, form)) as {
      asset?: { url: string };
    };
    if (!res.asset?.url) throw new Error(`upload of ${abs} answered without an asset url`);
    this.writes++;
    existing.set(name, res.asset.url);
    return res.asset.url;
  }
}

/** `<12 hex of sha256>-<file name>` — the stored name an asset is found by. */
export function assetName(abs: string): string {
  const hash = createHash('sha256').update(readFileSync(abs)).digest('hex').slice(0, 12);
  return `${hash}-${basename(abs).replace(/[^\w.-]+/g, '-')}`;
}

/** A short, stable key for `Idempotency-Key`: the same write retried is one write. */
export function idemKey(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 40);
}
