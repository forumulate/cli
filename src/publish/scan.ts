import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { isDraft, splitFront } from './frontmatter';
import { ASSET, DATED, MD, NUMERIC, slugify, titleOf, VERSION } from './names';
import { ignoreMatcher, isReadme, MANIFEST_NAMES, reservedReason } from './reserved';
import { scanDocs } from './scan-docs';
import type { Slot } from './slots';
import type { Reader, ScanResult, SpaceSpec, TagSpec } from './types';

/**
 * A folder on disk, read into what it would publish.
 *
 * Docs are walked in `scan-docs.ts` (collections, nesting, folder pages).
 * Everything else — blog, changelog, any type whose pieces are posts — is a
 * flat set of posts, folders or not. Both go through the same skip rules
 * (`reserved.ts`) and the same reader, which records the local files each
 * document points at for upload.
 */
export { slugify, tagKey, titleize } from './names';
export type { ScanResult } from './types';
export type { ScanShape };
export { MANIFEST_NAMES };

/**
 * What a folder walk leaves out: the reserved names (`reserved.ts`) and the
 * manifest's `ignore:` globs. A Markdown file left out is RECORDED, so the
 * plan can say "skip README.md (repository paperwork)" — a file that quietly
 * does not publish is the report every customer filed about their own
 * publisher's skip list.
 */
interface Skipper {
  /** True when `name` (in the folder `abs`) is not content. */
  (abs: string, name: string): boolean;
  readmeIsIndex: boolean;
}

function skipperFor(out: ScanResult, spec: SpaceSpec, kind: 'docs' | 'posts'): Skipper {
  const readmeIsIndex = kind === 'docs' && spec.readme !== 'skip';
  const ignored = ignoreMatcher(spec.ignore);
  const recorded = new Set<string>();
  const skip = ((abs: string, name: string) => {
    const full = join(abs, name);
    let isDir = false;
    try {
      isDir = statSync(full).isDirectory();
    } catch {
      return true;
    }
    const rel = relative(out.absDir, full).split(sep).join('/');
    const reason =
      reservedReason(name, isDir, readmeIsIndex) ?? (ignored(rel) ? 'ignore: in the manifest' : null);
    if (!reason) return false;
    // Folders are reported once by name when they would have held content.
    if ((MD.test(name) || (isDir && !name.startsWith('.') && name !== 'node_modules')) && !recorded.has(rel)) {
      recorded.add(rel);
      out.skipped.push({ file: isDir ? `${rel}/` : rel, reason });
    }
    return true;
  }) as Skipper;
  skip.readmeIsIndex = readmeIsIndex;
  return skip;
}

const isIndexName = (file: string, readmeIsIndex: boolean) =>
  /^index\.(md|mdx|markdown)$/i.test(basename(file)) || (readmeIsIndex && isReadme(basename(file)));

function hasMarkdown(dir: string, skip: Skipper): boolean {
  for (const e of readdirSync(dir)) {
    if (skip(dir, e)) continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory() ? hasMarkdown(p, skip) : MD.test(e)) return true;
  }
  return false;
}

/** `_tags.yml` / `.yaml` / `.json` at the top of a space folder: its blog categories. */
function tagsFile(dir: string): Record<string, TagSpec> {
  for (const n of ['_tags.yml', '_tags.yaml', '_tags.json']) {
    const p = join(dir, n);
    if (!existsSync(p)) continue;
    const raw = parseYaml(readFileSync(p, 'utf8')) as unknown;
    if (raw === null || raw === undefined) return {};
    if (typeof raw !== 'object' || Array.isArray(raw))
      throw new Error(`${n}: must be a map of tag slug → how it looks`);
    return raw as Record<string, TagSpec>;
  }
  return {};
}

/** Local files a document points at — images, PDFs — resolved from its own folder. */
export function assetRefs(
  text: string,
  fileDir: string,
  front: Record<string, unknown>,
): Map<string, string> {
  const refs = new Map<string, string>();
  const consider = (ref: string) => {
    const clean = ref.trim().replace(/^<|>$/g, '').split(/[?#]/)[0]!;
    if (!clean || /^[a-z][a-z0-9+.-]*:/i.test(clean) || clean.startsWith('/') || !ASSET.test(clean))
      return;
    let abs: string;
    try {
      abs = resolve(fileDir, decodeURI(clean));
    } catch {
      return; // a malformed %-escape is a reference to nothing on disk
    }
    if (existsSync(abs) && statSync(abs).isFile()) refs.set(ref.trim(), abs);
  };
  for (const m of text.matchAll(/!?\[[^\]]*\]\(\s*(<[^>]+>|[^)\s]+)/g)) consider(m[1]!);
  for (const m of text.matchAll(/\b(?:src|href|poster)\s*=\s*["']([^"']+)["']/g)) consider(m[1]!);
  const walk = (v: unknown) => {
    if (typeof v === 'string') consider(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(front);
  return refs;
}

/** What the space's type declares, as far as reading a folder needs it. */
interface ScanShape {
  /** Declared parameters (`audience`, `topic`, …): front matter keys that go to `fields`. */
  fieldKeys: string[];
  /** Declared slots of a page-backed type, for front matter that fills them. */
  slots?: Slot[];
}

/** Read one space folder. `kind` decides whether its files are pages or posts. */
export function scanSpace(
  root: string,
  spec: SpaceSpec,
  kind: 'docs' | 'posts',
  shape: ScanShape | string[],
): ScanResult {
  const { fieldKeys, slots = [] } = Array.isArray(shape) ? { fieldKeys: shape } : shape;
  const absDir = resolve(root, spec.path || '.');
  const out: ScanResult = {
    dir: spec.path || '',
    absDir,
    collections: [],
    posts: [],
    assets: new Set(),
    warnings: [],
    drafts: new Set(),
    skipped: [],
    tags: {},
    refs: new Map(),
    slugByFile: new Map(),
  };
  if (!existsSync(absDir) || !statSync(absDir).isDirectory()) {
    out.warnings.push(`${absDir} is not a folder`);
    return out;
  }
  try {
    out.tags = tagsFile(absDir);
  } catch (e) {
    throw new Error(`${spec.path || '.'}/${(e as Error).message}`);
  }
  const read: Reader = (abs: string) => {
    const text = readFileSync(abs, 'utf8');
    const rel = relative(absDir, abs).split(sep).join('/');
    try {
      const { data, body } = splitFront(text);
      const refs = assetRefs(text, dirname(abs), data);
      if (refs.size) out.refs.set(rel, refs);
      for (const a of refs.values()) out.assets.add(a);
      return { rel, text, data, body };
    } catch (e) {
      throw new Error(`${rel}: ${(e as Error).message}`);
    }
  };
  const skip = skipperFor(out, spec, kind);
  if (kind === 'posts') scanPosts(absDir, out, read, skip);
  else
    scanDocs(absDir, spec, out, read, {
      fieldKeys,
      slots,
      skip,
      hasMarkdown: (d) => hasMarkdown(d, skip),
      isIndex: (f) => isIndexName(f, skip.readmeIsIndex),
    });
  return out;
}

function scanPosts(absDir: string, out: ScanResult, read: Reader, skip: Skipper): void {
  const walk = (dir: string) => {
    for (const e of readdirSync(dir).sort()) {
      // README (anywhere: a posts folder has no folder pages), `_drafts/`,
      // dotfiles, the manifest and `ignore:` — see reserved.ts.
      if (skip(dir, e)) continue;
      const abs = join(dir, e);
      if (statSync(abs).isDirectory()) {
        walk(abs);
        continue;
      }
      if (!MD.test(e)) continue;
      const f = read(abs);
      const stem = e.replace(MD, '');
      // A version-shaped name (`2-4-0.md`, `1.10.md`) IS the address, not an
      // ordering prefix in front of one: stripping "2-" left a release at `4-0`.
      const bare = stem.replace(DATED, '');
      const slug =
        typeof f.data.slug === 'string' && f.data.slug.trim()
          ? slugify(f.data.slug)
          : slugify(VERSION.test(bare) ? bare : bare.replace(NUMERIC, ''));
      if (isDraft(f.data)) {
        out.drafts.add(slug);
        out.warnings.push(`${f.rel}: draft — left out (and kept if it is live)`);
        continue;
      }
      const dated = DATED.exec(stem);
      const front = { ...f.data };
      if (dated && front.publishedAt === undefined && front.date === undefined)
        front.publishedAt = dated[1];
      if (front.date !== undefined && front.publishedAt === undefined)
        front.publishedAt = front.date;
      out.slugByFile.set(f.rel, slug);
      out.posts.push({
        file: f.rel,
        slug,
        title: titleOf(f.data, f.body, slug),
        source: f.text,
        body: f.body,
        front,
      });
    }
  };
  walk(absDir);
}

/** Every relative path → posix, for comparing with `importName`s. */
export const toPosix = (p: string) => p.split(sep).join('/');
export const extOf = (p: string) => extname(p).toLowerCase();
