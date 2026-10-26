import type { Http, HttpRequest, HttpResponse } from './http';
import { pageOf, render, rowsOf, table } from './output';
import { UsageError } from './request';

/**
 * Send one planned request and print the answer — shared by `forumulate api`
 * and every resource command, so `--json`, `--paginate`, `--columns` and
 * `--include-headers` mean the same thing everywhere.
 */
export interface SendOptions {
  json: boolean;
  /**
   * With `--paginate`: one JSON object per line, written as each page arrives
   * (FMU-D05). A 1,226-row walk merged into one array is held whole in memory
   * and printed at the end; a line per row streams, and `jq -c`, `wc -l` and a
   * `while read` loop all consume it without parsing a 10 MB document.
   */
  jsonl?: boolean;
  paginate?: boolean;
  maxPages?: number;
  columns?: string[];
  includeHeaders?: boolean;
}

export interface Printer {
  out: (line: string) => void;
}

export async function sendAndPrint(
  http: Http,
  request: HttpRequest,
  opts: SendOptions,
  io: Printer,
): Promise<unknown> {
  if (!opts.paginate) {
    const res = await http.send(request);
    if (opts.includeHeaders) printHeaders(res, io);
    print(res.data, opts, io);
    return res.data;
  }
  if (request.method !== 'GET') throw new UsageError('--paginate only applies to GET operations');
  const rows = await walk(
    http,
    request,
    opts.maxPages ?? 1000,
    opts.jsonl ? (page) => page.forEach((r) => io.out(JSON.stringify(r))) : undefined,
  );
  if (opts.jsonl) {
    if (!rows.list) io.out(JSON.stringify(rows.first ?? null));
    return rows.rows;
  }
  if (!rows.list) {
    // Not a list: nothing to walk, so the one answer is the answer.
    print(rows.first, opts, io);
    return rows.first;
  }
  if (opts.json) io.out(JSON.stringify(rows.rows, null, 2));
  else {
    for (const l of table(rows.rows as Record<string, unknown>[], opts.columns)) io.out(l);
    io.out(`-- ${rows.rows.length} ${rows.key || 'rows'}`);
  }
  return rows.rows;
}

/**
 * Every row of a cursor-paged list. Stops on `hasMore: false`, a missing
 * cursor, or a cursor that did not move (a ranking answers `nextCursor: null`
 * and pages with `?page=`, which is not a walk). Says so when the first
 * answer is not a list at all (`list: false`, and `first` is that answer).
 */
export async function walk(
  http: Http,
  request: HttpRequest,
  maxPages = 1000,
  /** Each page's rows as they arrive (`--jsonl` streams them). */
  onPage?: (rows: unknown[]) => void,
): Promise<{ key: string; rows: unknown[]; list: boolean; first: unknown }> {
  const rows: unknown[] = [];
  let key = '';
  let cursor = request.query?.cursor;
  let first: unknown;
  for (let page = 0; page < maxPages; page++) {
    const res = await http.send({
      ...request,
      query: { ...request.query, ...(cursor ? { cursor } : {}) },
    });
    if (page === 0) first = res.data;
    const found = rowsOf(res.data);
    if (!found) return { key, rows, list: page > 0, first };
    key ||= found.key;
    // Streamed rows are not also held: the point of `--jsonl` is a walk of any size.
    if (onPage) onPage(found.rows);
    else rows.push(...found.rows);
    const info = pageOf(res.data);
    if (!info?.hasMore || !info.nextCursor || info.nextCursor === cursor) break;
    cursor = info.nextCursor;
  }
  return { key, rows, list: true, first };
}

export function print(
  data: unknown,
  opts: { json: boolean; columns?: string[] },
  io: Printer,
): void {
  if (opts.json) io.out(typeof data === 'string' ? data : JSON.stringify(data ?? null, null, 2));
  else for (const l of render(data, opts.columns)) io.out(l);
}

function printHeaders(res: HttpResponse, io: Printer): void {
  io.out(`HTTP ${res.status}`);
  res.headers.forEach((v, k) => io.out(`${k}: ${v}`));
  io.out('');
}

export function printRequest(http: Http, req: HttpRequest, io: Printer): void {
  io.out(`${req.method} ${http.url(req.path, req.query)}`);
  for (const [k, v] of Object.entries(http.headersFor(req)))
    io.out(`${k}: ${k.toLowerCase() === 'authorization' ? 'Bearer ***' : v}`);
  if (req.form) io.out('(multipart form)');
  else if (req.body !== undefined) io.out(`\n${JSON.stringify(req.body, null, 2)}`);
}
