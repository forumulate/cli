/**
 * How an API answer is printed when nobody asked for `--json`.
 *
 * A list answer becomes a table of the columns a person scans for (id, slug,
 * name/title, state), a single resource becomes `key  value` lines, and the
 * paging envelope becomes one footer line that says whether there is more and
 * how to get it. `--json` always prints the body untouched — scripts read that,
 * and nothing here is allowed to reshape it.
 */

type Row = Record<string, unknown>;

/** Keys that are envelope, never the rows themselves. */
const ENVELOPE = new Set(['page', 'sync', 'warnings', 'conformance', 'facets']);

/**
 * The rows of a list answer: `data` when the envelope carries it (the same rows
 * as the named key), else the named key, else the first array of objects.
 * Undefined when the answer is not a list.
 */
export function rowsOf(body: unknown): { key: string; rows: Row[] } | undefined {
  if (Array.isArray(body)) return { key: '', rows: body as Row[] };
  if (!body || typeof body !== 'object') return undefined;
  const obj = body as Record<string, unknown>;
  const arrays = Object.entries(obj).filter(
    ([k, v]) => !ENVELOPE.has(k) && Array.isArray(v) && v.every((x) => x && typeof x === 'object'),
  );
  const named = arrays.find(([k]) => k !== 'data');
  if (Array.isArray(obj.data)) return { key: named?.[0] ?? 'data', rows: obj.data as Row[] };
  return named ? { key: named[0], rows: named[1] as Row[] } : undefined;
}

export interface PageInfo {
  hasMore: boolean;
  nextCursor?: string;
  total?: number;
}

export function pageOf(body: unknown): PageInfo | undefined {
  const page = (body as { page?: unknown })?.page;
  if (!page || typeof page !== 'object') return undefined;
  const p = page as {
    hasMore?: boolean;
    has_more?: boolean;
    nextCursor?: string | null;
    next_cursor?: string | null;
    total?: number;
  };
  return {
    hasMore: Boolean(p.hasMore ?? p.has_more),
    nextCursor: p.nextCursor ?? p.next_cursor ?? undefined,
    total: typeof p.total === 'number' ? p.total : undefined,
  };
}

const PREFERRED = [
  'id',
  'key',
  'slug',
  'hostname',
  'email',
  'name',
  'title',
  'label',
  'type',
  'kind',
  'role',
  'state',
  'status',
  'visibility',
  'verified',
  'url',
  'events',
  'version',
  'createdAt',
  'updatedAt',
];

const scalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export function cell(v: unknown, width = 48): string {
  let s: string;
  if (v === null || v === undefined) s = '';
  else if (Array.isArray(v)) s = v.every(scalar) ? v.join(',') : `[${v.length}]`;
  else if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    s = String(o.name ?? o.title ?? o.slug ?? o.id ?? JSON.stringify(v));
  } else s = String(v);
  s = s.replace(/\s+/g, ' ');
  return s.length > width ? `${s.slice(0, width - 1)}…` : s;
}

/** Up to six columns, preferred names first, then whatever scalars the rows carry. */
export function pickColumns(rows: Row[], wanted?: string[]): string[] {
  const present = new Set<string>();
  for (const r of rows.slice(0, 20))
    for (const [k, v] of Object.entries(r)) if (v !== undefined) present.add(k);
  // A column nobody's rows carry is noise; with none left, choose as if unasked.
  const asked = wanted?.filter((k) => present.has(k));
  if (asked?.length) return asked;
  const cols = PREFERRED.filter((k) => present.has(k));
  // `name` and `title` both present: keep one, the second is usually a copy.
  if (cols.includes('name') && cols.includes('title')) cols.splice(cols.indexOf('name'), 1);
  for (const k of present) {
    if (cols.length >= 6) break;
    if (!cols.includes(k) && rows.some((r) => scalar(r[k]) && r[k] !== null)) cols.push(k);
  }
  return cols.slice(0, 6);
}

export function table(rows: Row[], columns?: string[]): string[] {
  if (rows.length === 0) return ['(none)'];
  const cols = pickColumns(rows, columns);
  if (cols.length === 0) return rows.map((r) => JSON.stringify(r));
  const cells = rows.map((r) => cols.map((c) => cell(r[c])));
  const widths = cols.map((c, i) => Math.max(c.length, ...cells.map((row) => row[i]!.length)));
  const line = (vals: string[]) =>
    vals
      .map((v, i) => (i === vals.length - 1 ? v : v.padEnd(widths[i]!)))
      .join('  ')
      .trimEnd();
  return [line(cols.map((c) => c.toUpperCase())), ...cells.map(line)];
}

/** A single resource: unwrap `{ data }` / `{ <resource> }`, then one `key  value` line per field. */
export function details(body: unknown): string[] {
  if (body === undefined || body === null || body === '') return ['OK'];
  if (typeof body !== 'object') return [String(body)];
  let obj = body as Record<string, unknown>;
  const extras: string[] = [];
  const named = Object.entries(obj).filter(([k]) => !ENVELOPE.has(k) && k !== 'data');
  if (obj.data && typeof obj.data === 'object' && !Array.isArray(obj.data)) {
    // `token` beside the row on a credential mint is the one-time secret: keep it visible.
    for (const [k, v] of named) if (scalar(v)) extras.push(`${k}  ${cell(v, 200)}`);
    obj = obj.data as Record<string, unknown>;
  } else if (
    named.length === 1 &&
    named[0]![1] &&
    typeof named[0]![1] === 'object' &&
    !Array.isArray(named[0]![1])
  ) {
    obj = named[0]![1] as Record<string, unknown>;
  }
  const keys = Object.keys(obj);
  const width = Math.min(Math.max(0, ...keys.map((k) => k.length)), 24);
  const lines = keys
    .filter((k) => obj[k] !== undefined)
    .map((k) => `${k.padEnd(width)}  ${cell(obj[k], 100)}`);
  const warnings = (body as { warnings?: unknown }).warnings;
  if (Array.isArray(warnings)) for (const w of warnings) lines.push(`warning: ${cell(w, 200)}`);
  return [...extras, ...lines];
}

/** Print an answer: table for a list, details for a resource, a paging footer when there is more. */
export function render(body: unknown, columns?: string[]): string[] {
  if (typeof body === 'string') return [body];
  const list = rowsOf(body);
  if (!list) return details(body);
  const out = table(list.rows, columns);
  const page = pageOf(body);
  if (page && (page.hasMore || page.total !== undefined)) {
    out.push(
      `-- ${list.rows.length} shown${page.total === undefined ? '' : ` of ${page.total}`}` +
        (page.hasMore
          ? page.nextCursor
            ? `, more: --cursor ${page.nextCursor} (or --paginate)`
            : ', more available'
          : ''),
    );
  }
  return out;
}
