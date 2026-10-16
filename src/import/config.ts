/**
 * A platform's schema as a Payload-format config.
 *
 * Contentful, Sanity, Strapi and WordPress each describe their content
 * differently, and the API already has exactly one reader that turns a field
 * list into a content model: the Payload one. So each importer states its
 * schema in Payload's vocabulary (a small, literal subset) and sends it
 * through that reader. A mapping bug is then fixed in one place, and the
 * report of what did not map comes from the same code as `content push`.
 */
export interface PayloadField {
  name: string;
  type: 'text' | 'textarea' | 'email' | 'richText' | 'number' | 'date' | 'checkbox' | 'json' | 'upload' | 'relationship' | 'select' | 'array' | 'group';
  label?: string;
  required?: boolean;
  localized?: boolean;
  hasMany?: boolean;
  relationTo?: string | string[];
  options?: string[];
  fields?: PayloadField[];
}

export interface PayloadCollection {
  slug: string;
  label?: string;
  titleField?: string;
  fields: PayloadField[];
}

/** The key a platform's field/type name becomes: stable, and a valid field name. */
export function keyOf(name: string): string {
  const k = name
    .replace(/[^A-Za-z0-9_]+(.)?/g, (_m, c: string | undefined) => (c ? c.toUpperCase() : ''))
    .replace(/^[0-9]+/, '');
  return k ? k[0]!.toLowerCase() + k.slice(1) : 'field';
}

/**
 * A list of scalars or files. The model has no "many texts" or "many media"
 * field (the Payload reader says so: `hasMany` on those is unsupported); the
 * model's own spelling is an array whose rows hold one value. Importers write
 * `value` rows and the engine wraps raw lists into them (`./coerce`).
 */
export const LIST_ROW_KEY = 'value';
export function listOf(name: string, inner: Omit<PayloadField, 'name'>, label?: string): PayloadField {
  return { name, type: 'array', ...(label ? { label } : {}), fields: [{ ...inner, name: LIST_ROW_KEY }] };
}

function fieldLiteral(f: PayloadField): Record<string, unknown> {
  return {
    name: f.name,
    type: f.type,
    ...(f.label ? { label: f.label } : {}),
    ...(f.required ? { required: true } : {}),
    ...(f.localized ? { localized: true } : {}),
    ...(f.hasMany ? { hasMany: true } : {}),
    ...(f.relationTo ? { relationTo: f.relationTo } : {}),
    ...(f.options ? { options: f.options.map((o) => ({ label: o, value: o })) } : {}),
    ...(f.fields ? { fields: f.fields.map(fieldLiteral) } : {}),
  };
}

export function payloadConfigSource(collections: PayloadCollection[]): string {
  const config = {
    collections: collections.map((c) => ({
      slug: c.slug,
      ...(c.label ? { labels: { singular: c.label, plural: c.label } } : {}),
      ...(c.titleField ? { admin: { useAsTitle: c.titleField } } : {}),
      fields: c.fields.map(fieldLiteral),
    })),
  };
  return `export default ${JSON.stringify(config, null, 2)}\n`;
}
