import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The operation index `forumulate api` runs from.
 *
 * `operations.json` is cut from `packages/sdk/openapi.json` by
 * `scripts/slim-spec.mjs`: every operation's method, path, params and request
 * body shape, nothing else (the full spec is 21 MB; this is under 1). It is read
 * lazily, so `forumulate whoami` does not pay to parse a thousand operations.
 */

/** A slimmed JSON Schema node (see `slim-spec.mjs` for the key names). */
export interface SchemaNode {
  $ref?: string;
  /** type */
  t?: string;
  /** properties */
  p?: Record<string, SchemaNode>;
  /** required */
  r?: string[];
  /** items */
  i?: SchemaNode;
  /** enum */
  e?: unknown[];
  /** const */
  c?: unknown;
  /** description (first sentence) */
  d?: string;
  /** anyOf/oneOf, minus a null variant */
  any?: SchemaNode[];
  all?: SchemaNode[];
  /** nullable */
  n?: 1;
}

export interface Param {
  n: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  r?: 1;
  t?: string;
  e?: unknown[];
  d?: string;
}

export interface Operation {
  id: string;
  m: string;
  p: string;
  s?: string;
  t?: string[];
  q?: Param[];
  /** Declares `Idempotency-Key`: the CLI sends one, so a retried write is not a second write. */
  ik?: 1;
  b?: SchemaNode;
  /** multipart/form-data body */
  mp?: 1;
  /** body required */
  br?: 1;
  dep?: 1;
}

export interface OperationIndex {
  info: { title?: string; version?: string };
  ops: Operation[];
  schemas: Record<string, SchemaNode>;
}

let cached: OperationIndex | undefined;

export function loadIndex(): OperationIndex {
  if (!cached) {
    cached = JSON.parse(readFileSync(join(__dirname, 'operations.json'), 'utf8')) as OperationIndex;
  }
  return cached;
}

/** For tests: run against an index that is not the bundled one. */
export function setIndex(index: OperationIndex | undefined): void {
  cached = index;
}

export function resolveRef(
  node: SchemaNode | undefined,
  index = loadIndex(),
): SchemaNode | undefined {
  let n = node;
  for (let i = 0; n?.$ref && i < 20; i++) n = index.schemas[n.$ref];
  return n ?? undefined;
}

/**
 * The top-level properties a body accepts, across every variant of a `oneOf`
 * (blog/forum/changelog take a block-JSON form OR a markdown form) — the set a
 * `--field` flag may name.
 */
export function bodyProperties(op: Operation, index = loadIndex()): Record<string, SchemaNode> {
  const out: Record<string, SchemaNode> = {};
  const visit = (raw: SchemaNode | undefined, depth: number) => {
    const node = resolveRef(raw, index);
    if (!node || depth > 4) return;
    for (const [k, v] of Object.entries(node.p ?? {})) out[k] ??= resolveRef(v, index) ?? {};
    for (const v of node.any ?? []) visit(v, depth + 1);
    for (const v of node.all ?? []) visit(v, depth + 1);
  };
  visit(op.b, 0);
  return out;
}

export function pathParams(op: Operation): string[] {
  return [...op.p.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
export const isMethod = (s: string | undefined): boolean =>
  Boolean(s && METHODS.has(s.toUpperCase()));

/** By operationId — exact first, then case-insensitive, so `space_list` works too. */
export function findById(id: string, index = loadIndex()): Operation | undefined {
  return (
    index.ops.find((o) => o.id === id) ??
    index.ops.find((o) => o.id.toLowerCase() === id.toLowerCase())
  );
}

/**
 * By method and path: a template (`/orgs/{orgId}/spaces`) or a concrete path
 * (`/orgs/acme/spaces`). A concrete path also hands back the values it filled
 * in, so `forumulate api GET /orgs/acme/spaces --paginate` knows `orgId=acme`.
 *
 * A literal segment beats a parameter, the same rule the API's router applies:
 * `/orgs/acme/members/invites` is the invite list, not member `invites`.
 */
export function findByPath(
  method: string,
  rawPath: string,
  index = loadIndex(),
): { op: Operation; values: Record<string, string> } | undefined {
  const m = method.toUpperCase();
  const path =
    rawPath
      .split('?')[0]!
      .replace(/^\/api(?=\/)/, '')
      .replace(/\/+$/, '') || '/';
  const want = path.split('/');
  let best: { op: Operation; values: Record<string, string>; score: number } | undefined;
  for (const op of index.ops) {
    if (op.m !== m) continue;
    if (op.p === path) return { op, values: {} };
    const have = op.p.split('/');
    if (have.length !== want.length) continue;
    const values: Record<string, string> = {};
    let score = 0;
    let ok = true;
    for (let i = 0; i < have.length; i++) {
      const seg = have[i]!;
      const param = seg.match(/^\{([^}]+)\}$/);
      if (param) {
        // `{orgId}` typed literally is the template, not a value.
        if (want[i] !== seg) values[param[1]!] = decodeURIComponent(want[i]!);
      } else if (seg === want[i]) score++;
      else {
        ok = false;
        break;
      }
    }
    if (ok && (!best || score > best.score)) best = { op, values, score };
  }
  return best && { op: best.op, values: best.values };
}

export interface ListFilter {
  tag?: string;
  search?: string;
  method?: string;
}

export function filterOps(filter: ListFilter, index = loadIndex()): Operation[] {
  const tag = filter.tag?.toLowerCase();
  const words = (filter.search ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return index.ops.filter((o) => {
    if (filter.method && o.m !== filter.method.toUpperCase()) return false;
    if (tag && !(o.t ?? []).some((t) => t.toLowerCase() === tag)) return false;
    if (words.length) {
      const hay = `${o.id} ${o.m} ${o.p} ${o.s ?? ''} ${(o.t ?? []).join(' ')}`.toLowerCase();
      if (!words.every((w) => hay.includes(w))) return false;
    }
    return true;
  });
}
