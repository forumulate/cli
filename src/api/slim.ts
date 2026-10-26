import type { OperationIndex } from './spec';

/**
 * The slim operation index, cut from a full OpenAPI document — the same cut
 * `scripts/slim-spec.mjs` makes at build time, here so `forumulate api list
 * --refresh` can cut it from the LIVE spec (FMU-D13). `slim.test.ts` holds the
 * two to the same output on the bundled spec, so they cannot drift.
 *
 * A full spec is untyped JSON walked by shape; one `any` alias says so once
 * rather than a cast at every property.
 */
// oxlint-disable-next-line no-explicit-any
type J = any;

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];

/** First sentence, at most `max` characters: enough to say what a thing is. */
function brief(text: unknown, max = 140): string | undefined {
  if (!text) return undefined;
  const flat = String(text).replace(/\s+/g, ' ').trim();
  const sentence = flat.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1)}…` : sentence;
}

export function slim(spec: J): OperationIndex {
  const schemas: Record<string, J> = {};
  const refName = (ref: string): string => ref.split('/').pop() ?? '';

  /** A JSON Schema reduced to what a person filling in a body needs. */
  function slimSchema(s: J, depth: number): J {
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
    const out: J = {};
    const variants = s.anyOf ?? s.oneOf;
    if (variants) {
      const kept = variants.filter((v: J) => v.type !== 'null');
      if (kept.length < variants.length) out.n = 1; // nullable
      if (kept.length === 1) Object.assign(out, slimSchema(kept[0], depth));
      else out.any = kept.map((v: J) => slimSchema(v, depth + 1));
    }
    if (s.allOf) out.all = s.allOf.map((v: J) => slimSchema(v, depth + 1));
    if (s.type)
      out.t = Array.isArray(s.type) ? s.type.filter((t: string) => t !== 'null').join('|') : s.type;
    if (s.enum) out.e = s.enum;
    if (s.const !== undefined) out.c = s.const;
    const d = brief(s.description, 100);
    if (d) out.d = d;
    if (s.properties) {
      out.p = {};
      for (const [k, v] of Object.entries(s.properties as Record<string, J>)) out.p[k] = slimSchema(v, depth + 1) ?? {};
    }
    if (s.required?.length) out.r = s.required;
    if (s.items) out.i = slimSchema(s.items, depth + 1);
    return out;
  }

  const ops: J[] = [];
  for (const [path, item] of Object.entries(spec.paths as Record<string, J>)) {
    for (const m of METHODS) {
      const o = item[m];
      if (!o) continue;
      const params: J[] = [];
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
        const q: J = { n: p.name, in: p.in };
        if (p.required) q.r = 1;
        const t = sch.type ?? (sch.anyOf ? 'string' : undefined);
        if (t && t !== 'string') q.t = t;
        if (sch.enum) q.e = sch.enum;
        const d = brief(p.description, 100);
        if (d) q.d = d;
        params.push(q);
      }
      const op: J = { id: o.operationId, m: m.toUpperCase(), p: path };
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
  const seen = new Map<string, number>();
  /** Every child that is itself a schema node: the only places a `$ref` may stand. */
  const children = (node: J): J[] => [
    ...(node.any ?? []),
    ...(node.all ?? []),
    ...Object.values(node.p ?? {}),
    ...(node.i ? [node.i] : []),
  ];
  const count = (node: J): void => {
    if (!node || typeof node !== 'object' || node.$ref) return;
    const key = JSON.stringify(node);
    if (key.length > 200) seen.set(key, (seen.get(key) ?? 0) + 1);
    children(node).forEach(count);
  };
  for (const op of ops) count(op.b);
  const shared = new Map<string, string>();
  const rebuild = (node: J): J => {
    const out = { ...node };
    if (node.any) out.any = node.any.map(intern);
    if (node.all) out.all = node.all.map(intern);
    if (node.p) out.p = Object.fromEntries(Object.entries(node.p).map(([k, v]: [string, J]) => [k, intern(v)]));
    if (node.i) out.i = intern(node.i);
    return out;
  };
  const intern = (node: J): J => {
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
