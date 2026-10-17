import { loadIndex, pathParams, resolveRef, type Operation, type SchemaNode } from './spec';

/**
 * `forumulate api describe <operationId>`: what to pass, in the CLI's own terms.
 *
 * Each parameter is printed as the flag that sets it, and the body as an
 * indented field list with types, required marks and enums — enough to write
 * `--field` flags or a `--data` file without opening the reference.
 */

/** An enum of 40 event names is a paragraph, not a type: show a few and say how many. */
function enumText(values: unknown[]): string {
  const shown = values
    .slice(0, 8)
    .map((v) => JSON.stringify(v))
    .join('|');
  return values.length > 8
    ? `${shown}|… (${values.length} values; describe --json lists all)`
    : shown;
}

function typeOf(node: SchemaNode | undefined, depth = 0): string {
  const n = resolveRef(node);
  if (!n) return 'any';
  if (n.c !== undefined) return JSON.stringify(n.c);
  if (n.e) return enumText(n.e);
  if (n.any) return [...new Set(n.any.map((v) => typeOf(v, depth + 1)))].join(' | ');
  if (n.t === 'array') return `${typeOf(n.i, depth + 1)}[]`;
  return (n.t ?? (n.p ? 'object' : 'any')) + (n.n ? '?' : '');
}

function fields(node: SchemaNode | undefined, indent: string, depth: number, out: string[]): void {
  const n = resolveRef(node);
  if (!n || depth > 3) return;
  if (n.any) {
    const objects = n.any.map((v) => resolveRef(v)).filter((v) => v?.p);
    if (objects.length > 1) {
      objects.forEach((v, i) => {
        out.push(`${indent}one of (${i + 1}/${objects.length})${v!.d ? ` — ${v!.d}` : ''}`);
        fields(v, `${indent}  `, depth + 1, out);
      });
      return;
    }
    if (objects.length === 1) return fields(objects[0], indent, depth, out);
  }
  for (const part of n.all ?? []) fields(part, indent, depth + 1, out);
  const required = new Set(n.r ?? []);
  for (const [k, v] of Object.entries(n.p ?? {})) {
    const child = resolveRef(v);
    out.push(
      `${indent}${k}${required.has(k) ? '*' : ''}  ${typeOf(v)}${child?.d ? `  — ${child.d}` : ''}`,
    );
    const inner = child?.t === 'array' ? resolveRef(child.i) : child;
    if (inner?.p && depth < 2) fields(inner, `${indent}  `, depth + 1, out);
  }
}

export function describe(op: Operation): string[] {
  const out = [`${op.id}  ${op.m} ${op.p}${op.dep ? '  (deprecated)' : ''}`];
  if (op.s) out.push(`  ${op.s}`);
  if (op.t?.length) out.push(`  tags: ${op.t.join(', ')}`);
  const params = op.q ?? [];
  const path = pathParams(op);
  out.push('', 'Usage:', `  forumulate api ${op.id}${path.map((p) => ` <${p}>`).join('')} [flags]`);
  if (params.length) {
    out.push('', 'Parameters:');
    for (const p of params) {
      const t = p.e ? enumText(p.e) : (p.t ?? 'string');
      out.push(`  --${p.n}${p.r ? '*' : ''}  ${p.in} ${t}${p.d ? `  — ${p.d}` : ''}`);
    }
  }
  if (op.b) {
    out.push(
      '',
      `Body (${op.mp ? 'multipart/form-data: --form name=value | name=@file' : 'JSON: --data, --field, or --<field>'})${op.br ? ', required' : ''}:`,
    );
    fields(op.b, '  ', 0, out);
  }
  if (op.ik) out.push('', 'Sends an Idempotency-Key (override with --idempotency-key).');
  if (params.some((p) => p.n === 'cursor'))
    out.push('Paged: --paginate follows page.nextCursor to the end.');
  out.push('', '* required');
  return out;
}

/** The body schema as JSON, refs expanded a few levels — `describe --json`. */
export function expand(node: SchemaNode | undefined, depth = 0): unknown {
  const n = resolveRef(node, loadIndex());
  if (!n) return {};
  if (depth > 6) return { type: n.t ?? 'object' };
  const out: Record<string, unknown> = {};
  if (n.t) out.type = n.t;
  if (n.d) out.description = n.d;
  if (n.e) out.enum = n.e;
  if (n.c !== undefined) out.const = n.c;
  if (n.n) out.nullable = true;
  if (n.r) out.required = n.r;
  if (n.p)
    out.properties = Object.fromEntries(
      Object.entries(n.p).map(([k, v]) => [k, expand(v, depth + 1)]),
    );
  if (n.i) out.items = expand(n.i, depth + 1);
  if (n.any) out.anyOf = n.any.map((v) => expand(v, depth + 1));
  if (n.all) out.allOf = n.all.map((v) => expand(v, depth + 1));
  return out;
}
