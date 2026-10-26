import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, join, posix, relative, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { declaredOrder, isDraft, pageMeta, splitFront } from './frontmatter';
import { MD, NUMERIC, prefixOrder, slugify, titleize, titleOf } from './names';
import { pageSlots } from './slots';
import type { DocsWalk, LocalCollection, LocalPage, Reader, ScanResult, SpaceSpec } from './types';

/**
 * The docs half of reading a folder: one top-level folder per collection,
 * files at the root in the root collection, nested folders as parent pages
 * (the folder's `index.md` — or `README.md`, unless the space says
 * `readme: skip` — is the parent; a folder without one gets a title-only stub
 * so its children still have somewhere to hang).
 */
export function scanDocs(
  absDir: string,
  spec: SpaceSpec,
  out: ScanResult,
  read: Reader,
  w: DocsWalk,
): void {
  const rootName = spec.rootCollection ?? '';
  const rootFiles: string[] = [];
  const folders: string[] = [];
  for (const e of readdirSync(absDir).sort()) {
    if (w.skip(absDir, e)) continue;
    const abs = join(absDir, e);
    if (statSync(abs).isDirectory()) {
      if (w.hasMarkdown(abs)) folders.push(e);
    } else if (MD.test(e)) rootFiles.push(e);
  }
  if (rootFiles.length) {
    out.collections.push(
      collectionOf(absDir, '', rootName ? slugify(rootName) : '', rootName, [-1, ''], {}, out, read, w, rootFiles),
    );
  }
  for (const name of folders) {
    const abs = join(absDir, name);
    const declared = { ...folderMeta(abs), ...(spec.collections?.[name] ?? {}) };
    const [n, key] = prefixOrder(name);
    const order: [number, string] = [typeof declared.order === 'number' ? declared.order : n, key];
    const slug =
      typeof declared.slug === 'string'
        ? slugify(declared.slug)
        : slugify(name.replace(NUMERIC, ''));
    const title = typeof declared.name === 'string' ? declared.name : titleize(name);
    const nav = (declared.nav ?? undefined) as Record<string, unknown> | undefined;
    out.collections.push(collectionOf(abs, name, slug, title, order, nav, out, read, w));
  }
  out.collections.sort((a, b) => a.order[0] - b.order[0] || a.order[1].localeCompare(b.order[1]));
}

/** `_collection.yml` / `.yaml` / `.json` beside a collection's files. */
function folderMeta(dir: string): Record<string, unknown> {
  for (const n of ['_collection.yml', '_collection.yaml', '_collection.json']) {
    const p = join(dir, n);
    if (existsSync(p)) return (parseYaml(readFileSync(p, 'utf8')) ?? {}) as Record<string, unknown>;
  }
  return {};
}

function collectionOf(
  abs: string,
  dir: string,
  slug: string,
  name: string,
  order: [number, string],
  nav: Record<string, unknown> | undefined,
  out: ScanResult,
  read: Reader,
  w: DocsWalk,
  onlyFiles?: string[],
): LocalCollection {
  const col: LocalCollection = { dir, slug, name, order, nav, pages: [] };
  /**
   * Walk one folder. `own` is the page that stands for this folder (its files
   * nest under it; null at the collection's top) and `above` is the page that
   * one nests under — which is where the folder's own index file hangs.
   */
  const walk = (folder: string, rel: string, own: string | null, above: string | null) => {
    const entries = (onlyFiles ?? readdirSync(folder).sort()).filter((e) => !w.skip(folder, e));
    const files = entries.filter((e) => MD.test(e) && !statSync(join(folder, e)).isDirectory());
    const dirs = onlyFiles
      ? []
      : entries.filter(
          (e) => statSync(join(folder, e)).isDirectory() && w.hasMarkdown(join(folder, e)),
        );
    const index = rel ? files.find(w.isIndex) : undefined;
    for (const f of files) {
      const parentSlug = f === index ? above : own;
      const where = { importName: rel ? `${rel}/${f}` : f, rel, isFolderIndex: f === index };
      const page = pageOf(join(folder, f), where, parentSlug, slug, out, read, w);
      if (page) col.pages.push(page);
    }
    for (const d of dirs) {
      const sub = join(folder, d);
      const subRel = rel ? `${rel}/${d}` : d;
      const subFiles = readdirSync(sub).filter((e) => !w.skip(sub, e) && MD.test(e));
      const subIndex = subFiles.find(w.isIndex);
      let folderSlug: string;
      if (subIndex) {
        // The index decides the folder page's address; read it once for that.
        const { data } = splitFront(readFileSync(join(sub, subIndex), 'utf8'));
        folderSlug =
          typeof data.slug === 'string' && data.slug.trim()
            ? slugify(data.slug)
            : slugify(d.replace(NUMERIC, ''));
      } else {
        folderSlug = slugify(d.replace(NUMERIC, ''));
        const title = titleize(d);
        col.pages.push({
          file: `${relative(out.absDir, sub).split(sep).join('/')}/ (no index.md)`,
          importName: `${subRel}/index.md`,
          slug: folderSlug,
          parentSlug: own,
          order: prefixOrder(d),
          title,
          source: `---\ntitle: ${JSON.stringify(title)}\nslug: ${folderSlug}\n---\n`,
          body: '',
          meta: {},
          unknown: [],
          sections: {},
          stub: true,
        });
      }
      walk(sub, subRel, folderSlug, own);
    }
  };
  walk(abs, '', null, null);
  return col;
}

function pageOf(
  abs: string,
  where: { importName: string; rel: string; isFolderIndex: boolean },
  parentSlug: string | null,
  collectionSlug: string,
  out: ScanResult,
  read: Reader,
  w: DocsWalk,
): LocalPage | null {
  const { importName, rel, isFolderIndex } = where;
  const f = read(abs);
  const name = basename(abs);
  const stem = name.replace(MD, '');
  const declaredSlug =
    typeof f.data.slug === 'string' && f.data.slug.trim() ? slugify(f.data.slug) : '';
  const folder = posix.basename(rel);
  const atCollectionTop = w.isIndex(name) && !rel;
  const slug =
    declaredSlug ||
    (isFolderIndex
      ? slugify(folder.replace(NUMERIC, ''))
      : atCollectionTop
        ? collectionSlug || slugify(titleOf(f.data, f.body, 'overview'))
        : slugify(stem.replace(NUMERIC, '')));
  if (isDraft(f.data)) {
    // Remembered by slug: a draft is never written, and never pruned either.
    out.drafts.add(slug);
    out.warnings.push(`${f.rel}: draft — left out (and kept if it is live)`);
    return null;
  }
  // Slots first: `short-answer:` on an FAQ question is a slot, not an unknown key.
  const slotted = pageSlots(f.data, f.body, w.slots);
  const { meta, unknown } = pageMeta(slotted.rest, w.fieldKeys);
  const n = declaredOrder(f.data);
  const [prefixN, key] = prefixOrder(isFolderIndex ? folder : stem);
  // A folder's index is ordered among the folder's siblings, by the folder's
  // prefix; a collection's own index leads it unless it says otherwise.
  const order: [number, string] = [n ?? (atCollectionTop ? -1 : prefixN), key];
  out.slugByFile.set(f.rel, slug);
  return {
    file: f.rel,
    importName,
    slug,
    parentSlug,
    order,
    title: titleOf(f.data, f.body, slug),
    source: f.text,
    body: f.body,
    meta,
    unknown: [...unknown, ...slotted.notes],
    sections: slotted.sections,
  };
}
