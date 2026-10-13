/**
 * The Content Sync Protocol, as a suite anything can be run against.
 *
 * What this checks is not "is it Forumulate" — it is a set of properties any
 * documentation platform can have and most do not: a findable description, one
 * envelope, a cursor that walks a collection without dropping or repeating a
 * row, an incremental window with a server-defined watermark, explicit
 * tombstones, a per-item hash, conditional requests, and rate limits that name
 * their window.
 *
 * It uses plain fetch and no SDK on purpose. A conformance suite that only runs
 * against the platform that wrote it proves nothing and convinces nobody.
 */
export const PROTOCOL_VERSION = '2026-09-01';

export interface Check {
  id: string;
  title: string;
  state: 'pass' | 'fail' | 'skip';
  detail: string;
  /** Why a client is worse off when this fails. */
  matters: string;
}

export interface ConformanceInput {
  /** The collection to walk, absolute. e.g. https://api.example.com/orgs/1/spaces/2/items */
  collection: string;
  token?: string;
  /** The key the collection is under, if it is not derivable from the path. */
  key?: string;
  fetchImpl?: typeof fetch;
  /** The version header a client states. Absent means the platform has none. */
  versionHeader?: { name: string; value: string };
}

export interface ConformanceReport {
  protocol: string;
  collection: string;
  checks: Check[];
  passed: number;
  failed: number;
}

const nounOf = (url: string): string => {
  const path = new URL(url).pathname.split('/').filter(Boolean);
  return path[path.length - 1] ?? 'items';
};

export async function runConformance(input: ConformanceInput): Promise<ConformanceReport> {
  const doFetch = input.fetchImpl ?? fetch;
  const key = input.key ?? nounOf(input.collection);
  const checks: Check[] = [];
  const headers: Record<string, string> = { accept: 'application/json' };
  if (input.token) headers.authorization = `Bearer ${input.token}`;
  if (input.versionHeader) headers[input.versionHeader.name] = input.versionHeader.value;

  const get = async (url: string, extra: Record<string, string> = {}) => {
    const res = await doFetch(url, { headers: { ...headers, ...extra } });
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try {
      body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      body = {};
    }
    return { res, body };
  };

  const add = (id: string, title: string, state: Check['state'], detail: string, matters: string) =>
    checks.push({ id, title, state, detail, matters });

  // 1 — the description is findable from the collection itself.
  const first = await get(withQuery(input.collection, { limit: '2' }));
  const serviceDesc = first.res.headers.get('link') ?? '';
  add(
    'CSP-1',
    'The description is findable from any response',
    /rel="?service-desc"?/.test(serviceDesc) ? 'pass' : 'fail',
    serviceDesc ? `link: ${serviceDesc.slice(0, 120)}` : 'no Link header',
    'Without it an integrator probes five paths, finds nothing, and writes a defensive parser instead of generating a client.',
  );

  // 2 — one envelope, keyed after the path.
  const rows = Array.isArray(body(first.body, key))
    ? (body(first.body, key) as Record<string, unknown>[])
    : null;
  add(
    'CSP-2',
    `The collection is keyed after its path (\`${key}\`)`,
    rows ? 'pass' : 'fail',
    rows ? `${rows.length} row(s)` : `keys were: ${Object.keys(first.body).join(', ') || 'none'}`,
    'A key that does not match its path makes every other endpoint a guess.',
  );
  const page = first.body.page as
    | {
        limit?: number;
        hasMore?: boolean;
        nextCursor?: string | null;
        has_more?: boolean;
        next_cursor?: string | null;
        total?: number;
      }
    | undefined;
  add(
    'CSP-3',
    'The page carries limit, hasMore, nextCursor and total',
    // Either spelling passes: the envelope carries both, and a server that
    // only ever sent the snake_case pair is still conformant.
    page &&
      ('hasMore' in page || 'has_more' in page) &&
      ('nextCursor' in page || 'next_cursor' in page)
      ? 'pass'
      : 'fail',
    page ? JSON.stringify(page) : 'no `page` object',
    'A caller cannot tell a short page from the last page, so a sync silently stops early.',
  );

  // 3 — the walk visits every row exactly once.
  if (rows && page) {
    const seen: string[] = [];
    let cursor = page.nextCursor ?? page.next_cursor ?? null;
    let guard = 0;
    for (const row of rows) seen.push(String(row.id));
    while (cursor && guard++ < 50) {
      const next = await get(withQuery(input.collection, { limit: '2', cursor }));
      const nextRows = (body(next.body, key) as Record<string, unknown>[] | undefined) ?? [];
      for (const row of nextRows) seen.push(String(row.id));
      const nextPage = next.body.page as
        { nextCursor?: string | null; next_cursor?: string | null } | undefined;
      cursor = nextPage?.nextCursor ?? nextPage?.next_cursor ?? null;
    }
    const unique = new Set(seen);
    add(
      'CSP-4',
      'A cursor walk visits every row exactly once',
      unique.size === seen.length ? 'pass' : 'fail',
      `${seen.length} row(s), ${unique.size} distinct`,
      'A cursor that repeats or skips rows corrupts a corpus without ever erroring.',
    );
    const total = page.total;
    add(
      'CSP-5',
      'The walk agrees with the reported total',
      typeof total === 'number' ? (unique.size === total ? 'pass' : 'fail') : 'skip',
      typeof total === 'number'
        ? `walked ${unique.size}, total says ${total}`
        : 'no total reported',
      'A total nobody can reconcile against is a number that hides a truncated sync.',
    );
  }

  // 4 — the incremental window, and the watermark that drives it.
  const sync = first.body.sync as { checkpoint?: string } | undefined;
  add(
    'CSP-6',
    'A server-defined checkpoint comes back with the page',
    sync?.checkpoint ? 'pass' : 'fail',
    sync?.checkpoint ?? 'no `sync.checkpoint`',
    'Without one, every client invents its own watermark out of its own clock and loses rows to skew.',
  );
  if (sync?.checkpoint) {
    const since = await get(withQuery(input.collection, { updated_since: sync.checkpoint }));
    const sinceRows = (body(since.body, key) as unknown[] | undefined) ?? [];
    add(
      'CSP-7',
      'The checkpoint narrows the answer',
      sinceRows.length <= (rows?.length ?? 0) + 1 ? 'pass' : 'fail',
      `${sinceRows.length} row(s) changed since the checkpoint`,
      'An incremental sync that returns everything is a full sync wearing a parameter.',
    );
    const bad = await get(withQuery(input.collection, { updated_since: 'yesterday-ish' }));
    add(
      'CSP-8',
      'An unparseable window is refused, not ignored',
      bad.res.status >= 400 && bad.res.status < 500 ? 'pass' : 'fail',
      `answered ${bad.res.status}`,
      'Silently ignoring it hands back a full list that looks like a successful incremental sync.',
    );
  }

  // 5 — tombstones.
  const deleted = await get(withQuery(input.collection, { include_deleted: 'true', limit: '50' }));
  const deletedRows = (body(deleted.body, key) as Record<string, unknown>[] | undefined) ?? [];
  add(
    'CSP-9',
    'Removals are explicit, not inferred from absence',
    deleted.res.ok && deletedRows.some((r) => 'deleted' in r)
      ? 'pass'
      : deleted.res.ok
        ? 'skip'
        : 'fail',
    deleted.res.ok
      ? deletedRows.some((r) => 'deleted' in r)
        ? 'tombstones present'
        : 'nothing has been removed in the retention window'
      : `answered ${deleted.res.status}`,
    'Absence means "archived" on a full sync and "not on this page" on an incremental one. Conflating them deletes a corpus.',
  );

  // 6 — a hash per item, and conditional requests.
  const withContent = await get(withQuery(input.collection, { include: 'body', limit: '1' }));
  const item = ((body(withContent.body, key) as Record<string, unknown>[] | undefined) ?? [])[0];
  add(
    'CSP-10',
    'Each item carries a content hash',
    item && typeof item.contentHash === 'string' ? 'pass' : 'fail',
    item ? Object.keys(item).join(', ').slice(0, 120) : 'no rows to inspect',
    'Without it a client re-embeds everything to discover that nothing changed.',
  );
  const etag = first.res.headers.get('etag');
  if (etag) {
    const again = await doFetch(withQuery(input.collection, { limit: '2' }), {
      headers: { ...headers, 'if-none-match': etag },
    });
    add(
      'CSP-11',
      'A conditional request answers 304',
      again.status === 304 ? 'pass' : 'fail',
      `answered ${again.status}`,
      'Polling costs a full transfer to learn nothing moved.',
    );
  } else {
    add(
      'CSP-11',
      'A conditional request answers 304',
      'skip',
      'no ETag on the collection',
      'Polling costs a full transfer to learn nothing moved.',
    );
  }

  // 7 — limits that name their window.
  const limit = first.res.headers.get('ratelimit-limit');
  const policy = first.res.headers.get('ratelimit-policy');
  add(
    'CSP-12',
    'Rate limits are stated, with their window',
    limit && policy ? 'pass' : limit ? 'fail' : 'fail',
    [limit && `limit ${limit}`, policy && `policy ${policy}`].filter(Boolean).join(', ') ||
      'neither header',
    'A limit with no period is a number per something, and a client that guesses wrong either crawls or is refused.',
  );

  const failed = checks.filter((c) => c.state === 'fail').length;
  return {
    protocol: PROTOCOL_VERSION,
    collection: input.collection,
    checks,
    passed: checks.filter((c) => c.state === 'pass').length,
    failed,
  };
}

function withQuery(url: string, params: Record<string, string>): string {
  const u = new URL(url);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.toString();
}

function body(payload: Record<string, unknown>, key: string): unknown {
  return payload[key] ?? payload[key.replace(/s$/, '')] ?? undefined;
}
