#!/usr/bin/env node
/**
 * The operation index `forumulate api` runs from, cut out of the SDK's spec.
 *
 * `packages/sdk/openapi.json` is 21 MB — every response schema, every example,
 * the conventions essay. The CLI needs a fraction of that to call an operation
 * and to describe it: method, path, params, and the REQUEST body's shape. So
 * this keeps exactly that, with descriptions cut to their first sentence, and
 * writes `src/api/operations.json` (committed, so tests and typecheck need no
 * build step). `operations.test.ts` regenerates it in memory and fails when the
 * committed copy is stale — a route added to the spec is a route the CLI can
 * call, or the test says why not.
 *
 *   node scripts/slim-spec.mjs            # rewrite src/api/operations.json
 *   node scripts/slim-spec.mjs --check    # exit 1 when it is out of date
 *   node scripts/slim-spec.mjs --copy     # (build) put it beside dist/api/spec.js
 */
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = join(here, '..', '..', 'sdk', 'openapi.json');
const OUT = join(here, '..', 'src', 'api', 'operations.json');
const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** First sentence, at most `max` characters: enough to say what a thing is. */
function brief(text, max = 140) {
  if (!text) return undefined;
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export function slim(spec) {
  const schemas = {};
  const refName = (ref) => ref.split('/').pop();

  /** A JSON Schema reduced to what a person filling in a body needs. */
  function slimSchema(s, depth) {
    if (!s || typeof s !== 'object') return undefined;
    if (s.$ref) {
      const name = refName(s.$ref);
      if (!(name in schemas)) {
        schemas[name] = null; // reserve first: schemas can be recursive
        schemas[name] = slimSchema(spec.components?.schemas?.[name], 0) ?? {};
      }
      return { $ref: name };
    }
    if (depth > 3) return { t: s.type ?? 'any' };
    const out = {};
    const variants = s.anyOf ?? s.oneOf;
    if (variants) {
      const kept = variants.filter((v) => v.type !== 'null');
      if (kept.length < variants.length) out.n = 1; // nullable
      if (kept.length === 1) Object.assign(out, slimSchema(kept[0], depth));
      else out.any = kept.map((v) => slimSchema(v, depth + 1));
    }
    if (s.allOf) out.all = s.allOf.map((v) => slimSchema(v, depth + 1));
    if (s.type)
      out.t = Array.isArray(s.type) ? s.type.filter((t) => t !== 'null').join('|') : s.type;
    if (s.enum) out.e = s.enum;
    if (s.const !== undefined) out.c = s.const;
    const d = brief(s.description, 100);
    if (d) out.d = d;
    if (s.properties) {
      out.p = {};
      for (const [k, v] of Object.entries(s.properties)) out.p[k] = slimSchema(v, depth + 1) ?? {};
    }
    if (s.required?.length) out.r = s.required;
    if (s.items) out.i = slimSchema(s.items, depth + 1);
    return out;
  }

  const ops = [];
  for (const [path, item] of Object.entries(spec.paths)) {
    for (const m of METHODS) {
      const o = item[m];
      if (!o) continue;
      const params = [];
      let idempotent = false;
      for (const raw of [...(item.parameters ?? []), ...(o.parameters ?? [])]) {
        const p = raw.$ref ? spec.components.parameters[refName(raw.$ref)] : raw;
        if (!p) continue;
        if (p.in === 'header' && p.name.toLowerCase() === 'forumulate-version') continue;
        if (p.in === 'header' && p.name.toLowerCase() === 'idempotency-key') {
          idempotent = true;
          continue;
        }
        const sch = p.schema ?? {};
        const q = { n: p.name, in: p.in };
        if (p.required) q.r = 1;
        const t = sch.type ?? (sch.anyOf ? 'string' : undefined);
        if (t && t !== 'string') q.t = t;
        if (sch.enum) q.e = sch.enum;
        const d = brief(p.description, 100);
        if (d) q.d = d;
        params.push(q);
      }
      const op = { id: o.operationId, m: m.toUpperCase(), p: path };
      const summary = brief(o.summary ?? o.description, 120);
      if (summary) op.s = summary;
      if (o.tags?.length) op.t = o.tags;
      if (params.length) op.q = params;
      if (idempotent) op.ik = 1;
      const content = o.requestBody?.content ?? {};
      if (content['application/json']) {
        op.b = slimSchema(content['application/json'].schema, 0) ?? {};
      } else if (content['multipart/form-data']) {
        op.mp = 1;
        op.b = slimSchema(content['multipart/form-data'].schema, 0) ?? {};
      }
      if (o.requestBody?.required) op.br = 1;
      if (o.deprecated) op.dep = 1;
      ops.push(op);
    }
  }
  /*
   * Content-addressed: the theme bodies alone repeat one 100 KB subtree across
   * nine operations. A subtree that appears twice is stored once, under `~n`.
   */
  const seen = new Map();
  /** Every child that is itself a schema node: the only places a `$ref` may stand. */
  const children = (node) => [
    ...(node.any ?? []),
    ...(node.all ?? []),
    ...Object.values(node.p ?? {}),
    ...(node.i ? [node.i] : []),
  ];
  const count = (node) => {
    if (!node || typeof node !== 'object' || node.$ref) return;
    const key = JSON.stringify(node);
    if (key.length > 200) seen.set(key, (seen.get(key) ?? 0) + 1);
    children(node).forEach(count);
  };
  for (const op of ops) count(op.b);
  const shared = new Map();
  const rebuild = (node) => {
    const out = { ...node };
    if (node.any) out.any = node.any.map(intern);
    if (node.all) out.all = node.all.map(intern);
    if (node.p) out.p = Object.fromEntries(Object.entries(node.p).map(([k, v]) => [k, intern(v)]));
    if (node.i) out.i = intern(node.i);
    return out;
  };
  const intern = (node) => {
    if (!node || typeof node !== 'object' || node.$ref) return node;
    const key = JSON.stringify(node);
    if ((seen.get(key) ?? 0) < 2) return rebuild(node);
    let name = shared.get(key);
    if (!name) {
      name = `~${shared.size}`;
      shared.set(key, name);
      schemas[name] = rebuild(node);
    }
    return { $ref: name };
  };
  for (const op of ops) if (op.b) op.b = rebuild(op.b);
  return { info: { title: spec.info?.title, version: spec.info?.version }, ops, schemas };
}

export function render(spec) {
  return `${JSON.stringify(slim(spec))}\n`;
}

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes('--copy')) {
  // The build: tsc does not copy a JSON file nothing imports.
  mkdirSync(join(here, '..', 'dist', 'api'), { recursive: true });
  copyFileSync(OUT, join(here, '..', 'dist', 'api', 'operations.json'));
} else if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const next = render(JSON.parse(readFileSync(SPEC, 'utf8')));
  if (process.argv.includes('--check')) {
    let cur = '';
    try {
      cur = readFileSync(OUT, 'utf8');
    } catch {
      /* no file yet: written below */
    }
    if (cur !== next) {
      console.error('src/api/operations.json is stale — run: node scripts/slim-spec.mjs');
      process.exit(1);
    }
  } else {
    writeFileSync(OUT, next);
    console.log(`wrote ${OUT} (${(next.length / 1024).toFixed(0)} KiB)`);
  }
}
