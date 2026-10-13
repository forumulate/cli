import { describe, it, expect } from 'vitest';
import { runConformance } from './conformance';

/** A platform that does everything the protocol asks. */
function goodPlatform(): typeof fetch {
  const items = [
    { id: 'a', updatedAt: '2026-01-01T00:00:00Z', contentHash: 'h1' },
    { id: 'b', updatedAt: '2026-01-02T00:00:00Z', contentHash: 'h2' },
    { id: 'c', updatedAt: '2026-01-03T00:00:00Z', contentHash: 'h3', deleted: true },
  ];
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const limit = Number(u.searchParams.get('limit') ?? 50);
    const cursor = u.searchParams.get('cursor');
    const since = u.searchParams.get('updated_since');
    if (since && Number.isNaN(Date.parse(since))) {
      return new Response(JSON.stringify({ message: 'bad window' }), { status: 422 });
    }
    const headers = new Headers({
      'content-type': 'application/json',
      link: '<https://example.com/openapi.json>; rel="service-desc"',
      etag: 'W/"abc"',
      'ratelimit-limit': '600',
      'ratelimit-policy': '600;w=60',
    });
    if ((init?.headers as Record<string, string> | undefined)?.['if-none-match'] === 'W/"abc"') {
      // `new Response(…, {status: 304})` is illegal in the fetch spec, so the
      // 304 is faked as a body-less object with the same surface the suite
      // touches. It only ever reads `status`.
      return { status: 304, headers, ok: false, text: async () => '' } as unknown as Response;
    }
    const live =
      u.searchParams.get('include_deleted') === 'true' ? items : items.filter((i) => !i.deleted);
    const start = cursor ? live.findIndex((i) => i.id === cursor) + 1 : 0;
    const slice = live.slice(start, start + limit);
    const last = slice[slice.length - 1];
    const hasMore = start + limit < live.length;
    return new Response(
      JSON.stringify({
        items: since ? [] : slice,
        page: {
          limit,
          has_more: hasMore,
          next_cursor: hasMore ? last!.id : null,
          total: live.length,
        },
        sync: { checkpoint: '2026-01-03T00:00:00Z' },
      }),
      { status: 200, headers },
    );
  }) as unknown as typeof fetch;
}

describe('The Content Sync Protocol suite', () => {
  it('passes a platform that walks, checkpoints, tombstones and hashes', async () => {
    const report = await runConformance({
      collection: 'https://example.com/orgs/1/spaces/2/items',
      fetchImpl: goodPlatform(),
    });
    const failing = report.checks.filter((c) => c.state === 'fail');
    expect(failing.map((c) => `${c.id}: ${c.detail}`)).toEqual([]);
    expect(report.failed).toBe(0);
  });

  it('fails the platform everybody actually has', async () => {
    // A bare array, no envelope, no checkpoint, no hash, no headers: the shape
    // this whole protocol exists to replace.
    const bare = (async () =>
      new Response(JSON.stringify({ items: [{ id: 'a' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
    const report = await runConformance({
      collection: 'https://example.com/items',
      fetchImpl: bare,
    });
    const ids = report.checks.filter((c) => c.state === 'fail').map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(['CSP-1', 'CSP-3', 'CSP-6', 'CSP-10', 'CSP-12']));
    // …and it still says which key it did find, rather than only "failed".
    expect(report.checks.find((c) => c.id === 'CSP-2')!.state).toBe('pass');
  });

  it('says why each failure costs a client something', async () => {
    const report = await runConformance({
      collection: 'https://example.com/items',
      fetchImpl: goodPlatform(),
    });
    for (const check of report.checks) expect(check.matters.length).toBeGreaterThan(20);
  });
});
