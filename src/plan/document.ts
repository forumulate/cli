import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { scanMarkdownDir, type ScannedPage } from './markdown-dir';

/**
 * `forumulate.yaml` as `forumulate plan` / `apply` read it (DX-D): the API's
 * version-2 manifest (`PUT /orgs/{org}/manifest`), plus the few things only a
 * file on disk can say.
 *
 *     version: 2
 *     org: numestri                 # or --org / FORUMULATE_ORG
 *     spaces:
 *       - slug: about
 *         name: About
 *         type: ABOUT
 *         locales: [{ code: es, label: Español }]
 *         about: about.yaml         # a file beside this one, or the map itself
 *       - slug: contact
 *         type: CONTACT
 *         contactForm: contact-form.yaml
 *       - slug: reference
 *         type: DOCS
 *         homeDoc: intro.md         # the intro; intro.es.md beside it is its Spanish twin
 *         openapi: { spec: openapi.yaml, collection: API reference }   # a spec file, read as text
 *     pages:
 *       - { dir: content/about, space: about }   # a Markdown folder (see markdown-dir.ts)
 *       - { space: about, slug: press, title: Press, body: "…" }  # or a page, inline
 *     sites: [...]
 *
 * Everything else is sent to the API exactly as written, and the API — not
 * this file — decides what is valid: the same schemas its endpoints use, so a
 * key the CLI let through cannot mean something the API would refuse. What is
 * resolved here is only what needs the disk: a `dir` becomes its pages, a
 * file name under `about` / `contactForm` becomes the map it holds, a
 * `homeDoc` file becomes the intro (with its `.<code>.md` twins), and an
 * `openapi[].spec` file name becomes the document's text.
 */

/** Keys only the CLI reads; never sent. */
const CLI_ONLY = ['org', '$schema'];

export interface PlanDocument {
  file: string;
  org?: string;
  /** The body for `PUT /orgs/{org}/manifest`. */
  body: Record<string, unknown>;
  /** Local files pages point at: space → page key (`slug`, `slug@es`) → reference → absolute path. */
  assets: Map<string, Map<string, Map<string, string>>>;
  /** Files left out on purpose (drafts), for the plan to name. */
  skipped: string[];
  /**
   * Collections this loader added to a space's `collections` (space → slugs),
   * because a folder implies them. The command drops the ones the space
   * already has: declaring an existing collection under a guessed name would
   * plan a RENAME of it.
   */
  implied: Map<string, string[]>;
}

function asMap(v: unknown, where: string): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where} must be a map`);
  return v as Record<string, unknown>;
}

function readData(file: string): unknown {
  const text = readFileSync(file, 'utf8');
  try {
    return /\.json$/i.test(file) ? JSON.parse(text) : parseYaml(text);
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`);
  }
}

/**
 * `homeDoc: intro.md` → `{body, translations}`: the file, and each declared
 * language's twin beside it (`intro.es.md`) — the suffix form a Markdown
 * folder uses (markdown-dir.ts). A map stays a map.
 */
function homeDocOf(v: unknown, base: string, locales: string[], where: string): unknown {
  if (typeof v !== 'string') return v;
  const file = resolve(base, v);
  if (!existsSync(file)) throw new Error(`${where}: ${v} does not exist`);
  const stem = join(dirname(file), basename(file, extname(file)));
  const translations: Record<string, { body: string }> = {};
  for (const code of locales) {
    const twin = `${stem}.${code}${extname(file)}`;
    if (existsSync(twin)) translations[code] = { body: readFileSync(twin, 'utf8') };
  }
  return { body: readFileSync(file, 'utf8'), ...(Object.keys(translations).length ? { translations } : {}) };
}

/** `openapi: {spec: openapi.yaml}` → the file's text, which the import door parses (YAML or JSON). */
function openApiOf(v: unknown, base: string): unknown {
  const one = (e: unknown) => {
    if (!e || typeof e !== 'object' || Array.isArray(e)) return e;
    const spec = (e as { spec?: unknown }).spec;
    if (typeof spec !== 'string' || !/\.(ya?ml|json)$/i.test(spec)) return e;
    const file = resolve(base, spec);
    return existsSync(file) ? { ...e, spec: readFileSync(file, 'utf8') } : e;
  };
  return Array.isArray(v) ? v.map(one) : one(v);
}

/** `about: about.yaml` → the map in that file; a map stays a map. */
function fileOrMap(v: unknown, base: string, where: string): unknown {
  if (typeof v !== 'string') return v;
  return asMap(readData(resolve(base, v)), `${where} (${v})`);
}

export function loadPlanDocument(file: string): PlanDocument {
  const raw = asMap(readData(file) ?? {}, file);
  if (raw.version !== 2) {
    throw new Error(
      `${file}: \`forumulate plan\` and \`apply\` read a \`version: 2\` manifest. ` +
        (raw.version === undefined
          ? 'This looks like a `forumulate publish` file (one folder per space); add `version: 2` and the blocks in docs/guides/forumulate-yaml-apply.md, or keep using `forumulate publish`.'
          : `It says version ${String(raw.version)}.`),
    );
  }
  const base = dirname(file);
  const body: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!CLI_ONLY.includes(k)) body[k] = v;

  const spaces = Array.isArray(body.spaces) ? (body.spaces as Record<string, unknown>[]) : [];
  for (const [i, s] of spaces.entries()) {
    asMap(s, `spaces[${i}]`);
    if (s.about !== undefined) s.about = fileOrMap(s.about, base, `spaces[${i}].about`);
    if (s.contactForm !== undefined) s.contactForm = fileOrMap(s.contactForm, base, `spaces[${i}].contactForm`);
    const codes = Array.isArray(s.locales) ? (s.locales as { code?: unknown }[]).map((l) => String(l.code ?? '')) : [];
    if (s.homeDoc !== undefined) s.homeDoc = homeDocOf(s.homeDoc, base, codes, `spaces[${i}].homeDoc`);
    if (s.openapi !== undefined) s.openapi = openApiOf(s.openapi, base);
  }
  const localesOf = (slug: string): string[] => {
    const s = spaces.find((x) => x.slug === slug);
    return Array.isArray(s?.locales) ? (s.locales as { code?: unknown }[]).map((l) => String(l.code ?? '')) : [];
  };

  const assets = new Map<string, Map<string, Map<string, string>>>();
  const skipped: string[] = [];
  const implied = new Map<string, string[]>();
  if (body.pages !== undefined) {
    if (!Array.isArray(body.pages)) throw new Error(`${file}: pages must be a list`);
    const pages: unknown[] = [];
    for (const [i, entry] of (body.pages as unknown[]).entries()) {
      const e = asMap(entry, `pages[${i}]`);
      if (e.dir === undefined) {
        pages.push(e);
        continue;
      }
      const extra = Object.keys(e).filter((k) => !['dir', 'space', 'collection', 'locales'].includes(k));
      if (extra.length) throw new Error(`pages[${i}]: a folder entry takes dir, space, collection and locales; not ${extra.join(', ')}`);
      if (typeof e.dir !== 'string' || typeof e.space !== 'string')
        throw new Error(`pages[${i}]: a folder entry needs \`dir\` and \`space\``);
      const extraLocales = Array.isArray(e.locales) ? e.locales.map(String) : [];
      const scan = scanMarkdownDir(resolve(base, e.dir), {
        space: e.space,
        locales: [...localesOf(e.space), ...extraLocales],
        ...(typeof e.collection === 'string' ? { collection: e.collection } : {}),
      });
      pages.push(...scan.pages);
      skipped.push(...scan.skipped.map((s) => `${e.dir}/${s}`));
      const forSpace = assets.get(e.space) ?? new Map<string, Map<string, string>>();
      for (const [k, v] of scan.assets) forSpace.set(k, v);
      if (forSpace.size) assets.set(e.space, forSpace);
      const added = declareCollections(spaces, e.space, scan.collections);
      if (added.length) implied.set(e.space, [...(implied.get(e.space) ?? []), ...added]);
    }
    body.pages = pages;
  }
  return {
    file,
    ...(typeof raw.org === 'string' ? { org: raw.org } : {}),
    body,
    assets,
    skipped,
    implied,
  };
}

/** Take back implied collections the space turned out to have already. */
export function dropImplied(body: Record<string, unknown>, space: string, existing: Set<string>, implied: string[]): void {
  const s = (Array.isArray(body.spaces) ? (body.spaces as Record<string, unknown>[]) : []).find((x) => x.slug === space);
  if (!s || !Array.isArray(s.collections)) return;
  s.collections = (s.collections as Record<string, unknown>[]).filter(
    (c) => !(implied.includes(String(c.slug)) && existing.has(String(c.slug))),
  );
  if ((s.collections as unknown[]).length === 0) delete s.collections;
}

/**
 * A folder of pages is a collection; the space's `collections` block gets
 * each one it does not already declare, so a tree with a `guides/` folder
 * needs no second mention of `guides`. Only for a space the document itself
 * declares — the API creates collections through that block.
 */
function declareCollections(spaces: Record<string, unknown>[], slug: string, found: Map<string, string>): string[] {
  const space = spaces.find((s) => s.slug === slug);
  if (!space || found.size === 0) return [];
  const list = Array.isArray(space.collections) ? (space.collections as Record<string, unknown>[]) : [];
  const added: string[] = [];
  for (const [cslug, name] of found) {
    if (list.some((c) => c.slug === cslug)) continue;
    list.push({ name, slug: cslug });
    added.push(cslug);
  }
  space.collections = list;
  return added;
}

/** The pages of a body, typed loosely: what the CLI rewrites and batches. */
export function pagesOf(body: Record<string, unknown>): ScannedPage[] {
  return Array.isArray(body.pages) ? (body.pages as ScannedPage[]) : [];
}
