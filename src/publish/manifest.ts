import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { MANIFEST_NAMES } from './reserved';
import type { Manifest, SiteSpec, SpaceSpec } from './types';

/**
 * `forumulate.yaml` (or `.yml`, or `forumulate.json`) at the top of the folder.
 *
 * Optional: a folder with no manifest publishes into the space named on the
 * command line. With one, a single repository describes a whole presence —
 * which spaces, their settings and theme, the site around them, an OpenAPI
 * reference, the status monitors — and re-running the command converges on it.
 *
 * Two forms. One space, written flat:
 *
 *     org: acme
 *     space: docs
 *     theme: { primaryColor: "#0a7" }
 *
 * or several, each with the folder it publishes from:
 *
 *     org: acme
 *     site: { slug: main, config: { tagline: "…" } }
 *     spaces:
 *       - { path: docs, space: docs }
 *       - { path: blog, space: blog, tags: { releases: { label: Releases, color: '#0a7' } } }
 *
 * Per space, besides where it publishes: `readme: index|skip` (what a README
 * is — see `reserved.ts`), `ignore:` (more names to leave out), `tags:`
 * (how a blog's categories look — see `tags.ts`) and `redirects:` (rules, or a
 * CSV file, merged into the space's redirect table — see `redirects.ts`).
 */
const SPACE_KEYS = [
  'space',
  'path',
  'create',
  'name',
  'visibility',
  'settings',
  'theme',
  'rootCollection',
  'collections',
  'openapi',
  'monitors',
  'about',
  'keep',
  'readme',
  'ignore',
  'tags',
  'redirects',
] as const;
const TOP_KEYS = new Set(['org', 'site', 'spaces', '$schema', ...SPACE_KEYS]);

export function findManifest(root: string, explicit?: string): string | null {
  if (explicit) {
    const p = resolve(explicit);
    if (!existsSync(p)) throw new Error(`No manifest at ${p}`);
    return p;
  }
  for (const n of MANIFEST_NAMES) {
    const p = join(root, n);
    if (existsSync(p)) return p;
  }
  return null;
}

function asObject(v: unknown, where: string): Record<string, unknown> | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where} must be a map`);
  return v as Record<string, unknown>;
}

function spaceSpec(raw: Record<string, unknown>, where: string): SpaceSpec {
  const unknown = Object.keys(raw).filter((k) => !(SPACE_KEYS as readonly string[]).includes(k));
  // A misspelt key in a manifest is a setting silently not applied — the same
  // failure `X-Unrecognized-Fields` exists for on the API. Refused, by name.
  if (unknown.length)
    throw new Error(
      `${where}: unknown key(s) ${unknown.join(', ')} — expected ${SPACE_KEYS.join(', ')}`,
    );
  const openapi =
    raw.openapi === undefined
      ? undefined
      : Array.isArray(raw.openapi)
        ? raw.openapi
        : [raw.openapi];
  for (const [i, o] of (openapi ?? []).entries()) {
    const spec = asObject(o, `${where}.openapi[${i}]`)!;
    if (!spec.spec && !spec.url)
      throw new Error(`${where}.openapi[${i}] needs \`spec\` (a file) or \`url\``);
    if (typeof spec.collection !== 'string')
      throw new Error(`${where}.openapi[${i}] needs \`collection\` (its name)`);
  }
  const monitors = raw.monitors === undefined ? undefined : (raw.monitors as unknown[]);
  if (monitors && !Array.isArray(monitors)) throw new Error(`${where}.monitors must be a list`);
  for (const [i, m] of (monitors ?? []).entries()) {
    if (typeof asObject(m, `${where}.monitors[${i}]`)?.name !== 'string')
      throw new Error(`${where}.monitors[${i}] needs a \`name\` — monitors are matched by it`);
  }
  if (raw.readme !== undefined && raw.readme !== 'index' && raw.readme !== 'skip')
    throw new Error(`${where}.readme must be \`index\` or \`skip\``);
  if (raw.ignore !== undefined && !Array.isArray(raw.ignore) && typeof raw.ignore !== 'string')
    throw new Error(`${where}.ignore must be a list of patterns`);
  const redirects = raw.redirects;
  if (redirects !== undefined && typeof redirects !== 'string') {
    if (!Array.isArray(redirects))
      throw new Error(`${where}.redirects must be a list of {from, to} or a CSV file name`);
    for (const [i, r] of redirects.entries()) {
      const rule = asObject(r, `${where}.redirects[${i}]`);
      if (typeof rule?.from !== 'string' || typeof rule.to !== 'string')
        throw new Error(`${where}.redirects[${i}] needs \`from\` and \`to\``);
      if (!rule.from.startsWith('/'))
        throw new Error(`${where}.redirects[${i}].from must be a path starting with /`);
    }
  }
  const tags = asObject(raw.tags, `${where}.tags`);
  for (const [slug, t] of Object.entries(tags ?? {}))
    if (t !== null && (typeof t !== 'object' || Array.isArray(t)))
      throw new Error(`${where}.tags.${slug} must be a map (label, color, cover, icon, …)`);
  return {
    path: typeof raw.path === 'string' ? raw.path : '',
    space: raw.space === undefined ? undefined : String(raw.space),
    create: asObject(raw.create, `${where}.create`) as SpaceSpec['create'],
    name: raw.name as string | undefined,
    visibility: raw.visibility as SpaceSpec['visibility'],
    settings: asObject(raw.settings, `${where}.settings`),
    theme: asObject(raw.theme, `${where}.theme`),
    rootCollection: raw.rootCollection as string | undefined,
    collections: asObject(raw.collections, `${where}.collections`) as SpaceSpec['collections'],
    openapi: openapi as SpaceSpec['openapi'],
    monitors: monitors as SpaceSpec['monitors'],
    about: aboutOf(raw.about, where),
    keep: Array.isArray(raw.keep) ? raw.keep.map(String) : undefined,
    readme: raw.readme as SpaceSpec['readme'],
    ignore:
      raw.ignore === undefined
        ? undefined
        : (Array.isArray(raw.ignore) ? raw.ignore : [raw.ignore]).map(String),
    tags: tags as SpaceSpec['tags'],
    redirects: redirects as SpaceSpec['redirects'],
  };
}

/** `about:` — a map of an About page's parts, or the name of a file holding one. */
function aboutOf(v: unknown, where: string): SpaceSpec['about'] {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  return asObject(v, `${where}.about`);
}

/** Read and check the manifest; `null` file → the one-space default. */
export function loadManifest(file: string | null): Manifest {
  if (!file) return { file: null, spaces: [{ path: '' }] };
  const text = readFileSync(file, 'utf8');
  let raw: unknown;
  try {
    raw = file.endsWith('.json') ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
  const top = asObject(raw ?? {}, file)!;
  const unknown = Object.keys(top).filter((k) => !TOP_KEYS.has(k));
  if (unknown.length) throw new Error(`${file}: unknown key(s) ${unknown.join(', ')}`);
  const site = asObject(top.site, `${file}: site`) as SiteSpec | undefined;
  if (site && !site.id && !site.slug) throw new Error(`${file}: site needs \`id\` or \`slug\``);
  let spaces: SpaceSpec[];
  if (top.spaces !== undefined) {
    if (!Array.isArray(top.spaces)) throw new Error(`${file}: spaces must be a list`);
    const flat = SPACE_KEYS.filter((k) => top[k] !== undefined);
    if (flat.length)
      throw new Error(`${file}: with \`spaces:\`, put ${flat.join(', ')} inside a space`);
    spaces = top.spaces.map((s, i) => spaceSpec(asObject(s, `spaces[${i}]`)!, `spaces[${i}]`));
  } else {
    const one: Record<string, unknown> = {};
    for (const k of SPACE_KEYS) if (top[k] !== undefined) one[k] = top[k];
    spaces = [spaceSpec(one, file)];
  }
  return { file, org: top.org === undefined ? undefined : String(top.org), site, spaces };
}
