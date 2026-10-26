import { basename } from 'node:path';
import { flag, all, type Parsed } from './args';
import { bodyProperties, pathParams, resolveRef, type Operation, type SchemaNode } from './spec';
import type { HttpRequest } from './http';

/**
 * Turn `forumulate api <op> …flags` into one HTTP request.
 *
 * Where a value comes from, in order of precedence:
 *  - path params: `--orgId acme` (or `--org-id`), else the positionals in path
 *    order, else — for `orgId` only — the default org (`--org`,
 *    `FORUMULATE_ORG`, `forumulate config set org`).
 *  - query and header params: `--<name> value`; a repeated flag is joined with
 *    commas, which is how every array parameter in this API is spelled.
 *  - body: `--data '{…}'`, `--data @file.json`, or `--data -` (stdin), then each
 *    `--field a.b=value` (typed by the body schema; `a:=<json>` for raw JSON),
 *    then any other `--flag` that names a top-level body property.
 *  - `-p name=value` sets a parameter whose name collides with one of ours.
 *
 * An operation's own parameter always beats a CLI flag of the same name — the
 * API has a `dryRun` and a `form`, and those must reach it.
 */
export interface RequestSources {
  readFile: (path: string) => string | Buffer;
  readStdin: () => Promise<string>;
  defaultOrg?: string;
}

/** Flags `forumulate api` consumes itself, unless the operation declares a parameter so named. */
export const API_FLAGS = new Set([
  'json',
  'paginate',
  'max-pages',
  'data',
  'field',
  'form',
  'param',
  'header',
  'api-version',
  'idempotency-key',
  'columns',
  'include-headers',
  'dry-run',
  'help',
  'verbose',
  'org',
  // The output contract (FMU-D05): never API parameters.
  'out',
  'jsonl',
  /*
   * The global PAT override (FMU-DOC01). Here so that, on an operation with no
   * `token` of its own, it is never sent on as a query parameter (the secret
   * in a URL and in every access log in front of the API). An operation that
   * declares one, in its parameters or its body, still owns it: see `OWNED_FIRST`.
   */
  'token',
]);

/**
 * CLI flags an operation's BODY property of the same name also beats. Only
 * `token` for now: a registry's, a GitHub connection's and an ACME answer's
 * token are body fields, and `--token` named them before it was global.
 */
const OWNED_FIRST = new Set(['token']);

export const norm = (s: string): string => s.toLowerCase().replace(/[-_]/g, '');

export class UsageError extends Error {}

function coerce(raw: string, schema: SchemaNode | undefined, at: string): unknown {
  const t = schema?.t ?? (schema?.any ? schema.any.map((v) => v.t).find(Boolean) : undefined);
  if (raw === 'null' && schema?.n) return null;
  switch (t) {
    case 'integer':
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) throw new UsageError(`${at} expects a number, got "${raw}"`);
      return n;
    }
    case 'boolean':
      if (raw === 'true' || raw === 'false') return raw === 'true';
      throw new UsageError(`${at} expects true or false, got "${raw}"`);
    case 'array':
      if (raw.trim().startsWith('[')) return parseJson(raw, at);
      return raw === '' ? [] : raw.split(',').map((v) => coerce(v, schema?.i, at));
    case 'object':
      return parseJson(raw, at);
    default:
      return raw;
  }
}

function parseJson(raw: string, at: string): unknown {
  try {
    return JSON.parse(raw);
  } catch (e) {
    throw new UsageError(`${at}: not valid JSON (${(e as Error).message})`);
  }
}

/** `a.b.c` → nested set, so `--field settings.overview=Hi` works without writing JSON. */
function setPath(target: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = target;
  for (const k of keys.slice(0, -1)) {
    if (!node[k] || typeof node[k] !== 'object') node[k] = {};
    node = node[k] as Record<string, unknown>;
  }
  node[keys.at(-1)!] = value;
}

function schemaAt(op: Operation, path: string): SchemaNode | undefined {
  const [head, ...rest] = path.split('.');
  let node: SchemaNode | undefined = bodyProperties(op)[head!];
  for (const k of rest) node = resolveRef(resolveRef(node)?.p?.[k]);
  return resolveRef(node);
}

async function readData(raw: string, src: RequestSources): Promise<string> {
  if (raw === '-' || raw === '@-') return src.readStdin();
  if (raw.startsWith('@')) return String(src.readFile(raw.slice(1)));
  return raw;
}

export interface Planned {
  request: HttpRequest;
  /** Parameter values, by name — what `--paginate` keeps between pages. */
  query: Record<string, string>;
}

export async function planRequest(
  op: Operation,
  parsed: Parsed,
  positionals: string[],
  src: RequestSources,
  preset: Record<string, string> = {},
): Promise<Planned> {
  const params = op.q ?? [];
  const byNorm = new Map(params.map((p) => [norm(p.n), p]));
  const bodyProps = op.b ? bodyProperties(op) : {};
  const bodyByNorm = new Map(Object.keys(bodyProps).map((k) => [norm(k), k]));
  const values: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(preset)) values[k] = [v];
  const body: Record<string, unknown> = {};
  let bodySet = false;
  const form = new FormData();
  let formSet = false;

  let tokenIsParam = false;
  for (const [name, vals] of parsed.flags) {
    const param = byNorm.get(norm(name));
    if (param) {
      values[param.n] = [...(values[param.n] && !preset[param.n] ? values[param.n]! : []), ...vals];
      if (name === 'token') tokenIsParam = true;
      continue;
    }
    if (API_FLAGS.has(name) && !(OWNED_FIRST.has(name) && bodyByNorm.has(norm(name)))) continue;
    if (name === 'token') tokenIsParam = true;
    const prop = bodyByNorm.get(norm(name));
    if (prop && !op.mp) {
      const v = vals.at(-1)!;
      body[prop] = coerce(v, bodyProps[prop], `--${name}`);
      bodySet = true;
      continue;
    }
    if (prop && op.mp) {
      await appendForm(form, prop, vals.at(-1)!, src);
      formSet = true;
      continue;
    }
    throw new UsageError(
      `--${name} is not a parameter of ${op.id}. See: forumulate api describe ${op.id}`,
    );
  }
  for (const pv of all(parsed, 'param')) {
    const eq = pv.indexOf('=');
    if (eq < 1) throw new UsageError(`--param expects name=value, got "${pv}"`);
    const p = byNorm.get(norm(pv.slice(0, eq)));
    if (!p) throw new UsageError(`${op.id} has no parameter "${pv.slice(0, eq)}"`);
    values[p.n] = [...(values[p.n] ?? []), pv.slice(eq + 1)];
  }

  // Positionals fill the path params nobody named, in path order.
  const pathNames = pathParams(op);
  const queue = [...positionals];
  for (const n of pathNames) if (!values[n] && queue.length) values[n] = [queue.shift()!];
  if (queue.length)
    throw new UsageError(`Unexpected argument${queue.length > 1 ? 's' : ''}: ${queue.join(' ')}`);
  if (!values.orgId && pathNames.includes('orgId') && src.defaultOrg)
    values.orgId = [src.defaultOrg];
  const missing = pathNames.filter((n) => !values[n]);
  if (missing.length)
    throw new UsageError(
      `${op.id} needs ${missing.map((n) => `<${n}>`).join(' ')} (positional, or --${missing[0]})`,
    );
  const missingQ = params.filter((p) => p.r && p.in !== 'path' && !values[p.n]).map((p) => p.n);
  if (missingQ.length) throw new UsageError(`${op.id} needs --${missingQ.join(', --')}`);

  const path = op.p.replace(/\{([^}]+)\}/g, (_, n: string) => encodeURIComponent(values[n]![0]!));
  const query: Record<string, string> = {};
  const headers: Record<string, string> = {};
  for (const p of params) {
    const v = values[p.n];
    if (!v || p.in === 'path') continue;
    if (p.in === 'query') query[p.n] = v.join(',');
    else if (p.in === 'header') headers[p.n] = v.at(-1)!;
  }
  for (const h of all(parsed, 'header')) {
    const at = h.indexOf(':');
    if (at < 1) throw new UsageError(`--header expects "Name: value", got "${h}"`);
    headers[h.slice(0, at).trim()] = h.slice(at + 1).trim();
  }
  const key = flag(parsed, 'idempotency-key');
  if (key) headers['Idempotency-Key'] = key;

  // The body: --data first, then --field on top of it.
  let payload: unknown;
  const data = byNorm.has('data') ? undefined : flag(parsed, 'data');
  if (data !== undefined) {
    const text = await readData(data, src);
    payload = text.trim() === '' ? undefined : parseJson(text, '--data');
    bodySet = payload !== undefined;
  }
  for (const f of all(parsed, 'field')) {
    const raw = f.indexOf(':=');
    const eq = f.indexOf('=');
    if (eq < 1) throw new UsageError(`--field expects name=value, got "${f}"`);
    if (op.mp) {
      await appendForm(form, f.slice(0, eq), f.slice(eq + 1), src);
      formSet = true;
      continue;
    }
    const isRaw = raw > 0 && raw < eq;
    const name = f.slice(0, isRaw ? raw : eq);
    const value = isRaw
      ? parseJson(f.slice(raw + 2), `--field ${name}`)
      : coerce(f.slice(eq + 1), schemaAt(op, name), `--field ${name}`);
    setPath(body, name, value);
    bodySet = true;
  }
  if (!byNorm.has('form'))
    for (const f of all(parsed, 'form')) {
      const eq = f.indexOf('=');
      if (eq < 1) throw new UsageError(`--form expects name=value or name=@file, got "${f}"`);
      await appendForm(form, f.slice(0, eq), f.slice(eq + 1), src);
      formSet = true;
    }

  const request: HttpRequest = { method: op.m, path, query, headers, idempotent: Boolean(op.ik) };
  // The value went to the operation, so the bearer is the ordinary one.
  if (tokenIsParam) request.tokenIsParam = true;
  if (formSet) request.form = form;
  else if (bodySet) {
    request.body =
      payload && typeof payload === 'object' && !Array.isArray(payload)
        ? { ...(payload as object), ...body }
        : Object.keys(body).length
          ? body
          : payload;
  } else if (op.b && op.br && op.m !== 'GET') request.body = {};
  return { request, query };
}

async function appendForm(
  form: FormData,
  name: string,
  value: string,
  src: RequestSources,
): Promise<void> {
  if (value.startsWith('@')) {
    const file = value.slice(1);
    const bytes = src.readFile(file);
    const blob = new Blob([typeof bytes === 'string' ? bytes : new Uint8Array(bytes)]);
    form.append(name, blob, basename(file));
  } else form.append(name, value);
}
