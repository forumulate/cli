/**
 * TypeScript from a content library's `schema.json` (plan P4-T1, spec 7):
 * `forumulate content types --library acme-site --out src/forumulate.d.ts`.
 *
 * The schema names everything already: `type.<key>` is a content type's
 * `fields`, `entry.<key>` the delivery envelope around them (marked
 * `x-forumulate-global` for a global), `block.<key>` a block type, and
 * `json.*` the hoisted definitions of a json field's own schema. Each becomes
 * one named type, so a `json` field is typed from its schema, a blocks
 * field is a union discriminated on `blockType`, and a reference to an
 * author is an `AuthorFields`.
 *
 * One deliberate departure from the schema: objects are CLOSED here. The
 * schema says `additionalProperties: true` so a site keeps working while a
 * field is being renamed; the types say exactly what the model has, so code
 * that still reads the old name fails to compile after the model changes.
 * That compile error is the point of generating types at all.
 *
 * Pure and deterministic: same schema, same bytes.
 */

type Json = Record<string, unknown>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function pascal(s: string): string {
  const out = s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join('');
  return /^[0-9]/.test(out) ? `T${out}` : out || 'T';
}

/** The TypeScript name of a `$defs` entry. */
export function defName(def: string): string {
  const dot = def.indexOf('.');
  const kind = def.slice(0, dot);
  const rest = def.slice(dot + 1);
  if (kind === 'type') return `${pascal(rest)}Fields`;
  if (kind === 'entry') return `${pascal(rest)}Entry`;
  if (kind === 'block') return `${pascal(rest)}Block`;
  return `Json${pascal(rest.replace(/~/g, ' '))}`;
}

const literal = (v: unknown) => JSON.stringify(v);
const key = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));
/** Parenthesised when a union or intersection sits at its top level (`(A | B)[]`). */
function paren(t: string): string {
  let depth = 0;
  for (let i = 0; i < t.length; i++) {
    const c = t[i]!;
    if (c === '{' || c === '(' || c === '[' || c === '<') depth++;
    else if (c === '}' || c === ')' || c === ']' || c === '>') depth--;
    else if (c === '"') {
      // Skip a string literal, escapes included: an enum value may hold a `|`.
      for (i++; i < t.length && t[i] !== '"'; i++) if (t[i] === '\\') i++;
    } else if (depth === 0 && (c === '|' || c === '&')) return `(${t})`;
  }
  return t;
}

function comment(s: Json, indent: string): string {
  const text = [s.title, s.description].filter((x): x is string => typeof x === 'string' && x.length > 0);
  const uniq = [...new Set(text)];
  if (!uniq.length) return '';
  return `${indent}/** ${uniq.join(' — ').replace(/\*\//g, '*\\/').replace(/\n/g, ' ')} */\n`;
}

/** One schema as a TypeScript type expression. */
export function toType(s: unknown, indent = ''): string {
  if (s === true || s === undefined) return 'unknown';
  if (s === false) return 'never';
  if (!isObj(s)) return 'unknown';
  if (typeof s.$ref === 'string') {
    const m = /^#\/\$defs\/(.+)$/.exec(s.$ref);
    return m ? defName(m[1]!) : 'unknown';
  }
  if ('const' in s) return literal(s.const);
  if (Array.isArray(s.enum)) return s.enum.length ? s.enum.map(literal).join(' | ') : 'never';
  for (const k of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(s[k])) {
      const parts = [...new Set((s[k] as unknown[]).map((x) => toType(x, indent)))];
      return parts.length ? parts.join(' | ') : 'never';
    }
  }
  if (Array.isArray(s.allOf)) return (s.allOf as unknown[]).map((x) => paren(toType(x, indent))).join(' & ');
  const types = Array.isArray(s.type) ? (s.type as string[]) : typeof s.type === 'string' ? [s.type] : [];
  if (!types.length) {
    if (isObj(s.properties) || s.additionalProperties !== undefined) return objectType(s, indent);
    if (s.items !== undefined) return arrayType(s, indent);
    return 'unknown';
  }
  const parts = types.map((t) => {
    switch (t) {
      case 'string':
        return 'string';
      case 'number':
      case 'integer':
        return 'number';
      case 'boolean':
        return 'boolean';
      case 'null':
        return 'null';
      case 'array':
        return arrayType(s, indent);
      case 'object':
        return objectType(s, indent);
      default:
        return 'unknown';
    }
  });
  return [...new Set(parts)].join(' | ');
}

function arrayType(s: Json, indent: string): string {
  if (Array.isArray(s.items)) return `[${(s.items as unknown[]).map((x) => toType(x, indent)).join(', ')}]`;
  return `${paren(toType(s.items, indent))}[]`;
}

function objectType(s: Json, indent: string): string {
  const props = isObj(s.properties) ? s.properties : {};
  const names = Object.keys(props);
  if (!names.length) {
    // A map: its values are typed when the schema says how.
    return isObj(s.additionalProperties) ? `Record<string, ${toType(s.additionalProperties, indent)}>` : 'Record<string, unknown>';
  }
  return `{\n${members(s, indent + '  ')}${indent}}`;
}

function members(s: Json, indent: string): string {
  const props = (isObj(s.properties) ? s.properties : {}) as Record<string, unknown>;
  const required = new Set(Array.isArray(s.required) ? (s.required as string[]) : []);
  let out = '';
  for (const [name, prop] of Object.entries(props)) {
    out += isObj(prop) ? comment(prop, indent) : '';
    out += `${indent}${key(name)}${required.has(name) ? '' : '?'}: ${toType(prop, indent)};\n`;
  }
  return out;
}

/**
 * A `$defs` entry as a declaration. Always a type alias, never an interface:
 * an interface is not assignable to `Record<string, unknown>` (it has no
 * implicit index signature), and that is the constraint every generic
 * content helper puts on `fields` (`Entry<T = Record<string, unknown>>`).
 */
function declaration(def: string, s: unknown): string {
  const doc = isObj(s) ? comment(s, '') : '';
  return `${doc}export type ${defName(def)} = ${toType(s)};\n`;
}

export interface GenerateOptions {
  /** Named in the header so the file says where it came from. */
  libraryId?: string;
  /** The command that regenerates it, for the header. */
  command?: string;
}

export interface Generated {
  source: string;
  types: string[];
  globals: string[];
  blocks: string[];
}

/** The whole `forumulate.d.ts` for a library schema. */
export function generateTypes(schema: unknown, opts: GenerateOptions = {}): Generated {
  if (!isObj(schema) || !isObj(schema.$defs)) throw new Error('This is not a content library schema: it has no `$defs`.');
  const defs = schema.$defs as Record<string, unknown>;
  const entries = Object.keys(defs).filter((d) => d.startsWith('entry.'));
  const isGlobal = (k: string) => isObj(defs[`entry.${k}`]) && (defs[`entry.${k}`] as Json)['x-forumulate-global'] === true;
  const typeKeys = Object.keys(defs).filter((d) => d.startsWith('type.')).map((d) => d.slice(5));
  const blockKeys = Object.keys(defs).filter((d) => d.startsWith('block.')).map((d) => d.slice(6));
  const collections = typeKeys.filter((k) => !isGlobal(k));
  const globals = typeKeys.filter((k) => isGlobal(k));

  const parts: string[] = [
    '/* eslint-disable */',
    '// Generated by `forumulate content types`. Do not edit: regenerate after a model change',
    `// (${opts.command ?? 'forumulate content types --library <id> --out <file>'}).`,
    ...(opts.libraryId ? [`// Content library: ${opts.libraryId}`] : []),
    '// Fields are optional because an entry may leave them empty; objects are closed so a',
    '// field removed or renamed in the model is a compile error wherever code still reads it.',
    '',
  ];
  // Fields, then entries, then blocks, then json schemas: the order a reader looks for them.
  const order = ['type.', 'entry.', 'block.', 'json.'];
  const sorted = Object.keys(defs).sort((a, b) => {
    const ra = order.findIndex((p) => a.startsWith(p));
    const rb = order.findIndex((p) => b.startsWith(p));
    return (ra < 0 ? 9 : ra) - (rb < 0 ? 9 : rb);
  });
  for (const def of sorted) parts.push(declaration(def, defs[def]));

  const map = (name: string, keys: string[], suffix: (k: string) => string, doc: string) =>
    `/** ${doc} */\nexport type ${name} = {\n${keys.map((k) => `  ${key(k)}: ${suffix(k)};\n`).join('')}};\n`;
  parts.push(
    `/** Every block type, discriminated on \`blockType\`. */\nexport type Block = ${blockKeys.length ? blockKeys.map((k) => defName(`block.${k}`)).join(' | ') : 'never'};\n`,
    "export type BlockTypeKey = Block['blockType'];\n",
    map('Blocks', blockKeys, (k) => defName(`block.${k}`), 'Block types by key.'),
    map('ContentTypes', collections, (k) => defName(`type.${k}`), 'The fields of each collection (a content type with many entries), by key.'),
    map('Globals', globals, (k) => defName(`type.${k}`), 'The fields of each global (one entry per locale), by key.'),
    map('Entries', entries.map((d) => d.slice(6)), (k) => defName(`entry.${k}`), 'The delivery envelope of each content type, by key.'),
    'export type ContentTypeKey = keyof ContentTypes;\n',
    'export type GlobalKey = keyof Globals;\n',
    '/** Everything at once, for a client typed against this library. */\nexport type ForumulateContent = {\n  types: ContentTypes;\n  globals: Globals;\n  blocks: Blocks;\n  entries: Entries;\n};\n',
  );
  return { source: parts.join('\n'), types: collections, globals, blocks: blockKeys };
}
