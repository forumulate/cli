import type { Slot } from './slots';

/**
 * The shapes `forumulate publish <folder>` works in.
 *
 * Three layers, kept apart on purpose: what is ON DISK (`Local*`), what is
 * LIVE (`Live*`), and what would change (`Plan`). Every customer publisher we
 * were shown (four of them, in three languages) mixed the first two — they
 * wrote while they read — so a dry run was a different code path from the real
 * one and drifted from it. Here a plan is computed from the two snapshots and
 * nothing else, and the real run executes that same plan.
 */

/** A page's metadata patch, in the API's own field names (`PATCH …/metadata`). */
export type MetaPatch = Record<string, unknown>;

/** One Markdown file destined to be a docs page. */
export interface LocalPage {
  /** Path relative to the publish root, for the plan a person reads. */
  file: string;
  /** Path relative to its collection folder — the name the import door is sent. */
  importName: string;
  /** Where the page lands. Declared in front matter or derived from the file name. */
  slug: string;
  /** The folder page this one nests under, by slug; null at the collection's top. */
  parentSlug: string | null;
  /** Sort key among siblings: declared `order`, a numeric prefix, else the name. */
  order: [number, string];
  /** Front matter title, else the leading `# heading`, else the slug. */
  title: string;
  /** The file exactly as written, with `slug:` declared and references rewritten later. */
  source: string;
  /** The body without front matter — what is compared. */
  body: string;
  /** Metadata the front matter declares, mapped to API field names. */
  meta: MetaPatch;
  /** Front matter keys nothing here understands — reported, never sent. */
  unknown: string[];
  /** Synthesised to stand for a folder that has no index file of its own. */
  stub?: boolean;
  /**
   * Named slots the front matter fills (`short-answer:` on an FAQ question),
   * by the shape's own keys. Empty when the file declares none, which is the
   * common case: the body alone is the page.
   */
  sections: Record<string, string>;
}

/** One top-level folder of a docs space. */
export interface LocalCollection {
  /** Folder name relative to the space folder; '' for files at the space root. */
  dir: string;
  slug: string;
  name: string;
  order: [number, string];
  nav?: Record<string, unknown>;
  pages: LocalPage[];
}

/** One Markdown file destined to be a post (blog, changelog, any non-docs type). */
export interface LocalPost {
  file: string;
  slug: string;
  title: string;
  source: string;
  body: string;
  /** Front matter as written (keys lower-cased only where the type declares them). */
  front: Record<string, unknown>;
}

/** Everything one space folder holds. */
export interface LocalSpace {
  /** The space folder, relative to the publish root ('' = the root itself). */
  dir: string;
  absDir: string;
  collections: LocalCollection[];
  posts: LocalPost[];
  /** Local files (images, PDFs) referenced from pages or posts, absolute paths. */
  assets: Set<string>;
  warnings: string[];
  /**
   * Slugs of the files marked `draft: true`. Never created or published — and
   * never pruned either: marking a live post as a draft must not delete it.
   */
  drafts: Set<string>;
  /** Markdown files left out because of their name (README, `_drafts/…`, `ignore:`). */
  skipped: { file: string; reason: string }[];
  /** Blog categories declared in `_tags.yml` beside the files (the manifest's `tags:` wins). */
  tags: Record<string, TagSpec>;
}

/**
 * How one blog category looks, as written in the manifest or `_tags.yml`.
 * The keys are `PUT …/blog/tags/{slug}`'s own, plus the spellings people
 * reach for first (`name`, `colour`, `cover`, `image`), mapped in `tags.ts`.
 */
export type TagSpec = Record<string, unknown>;

/** A space as the manifest describes it. */
export interface SpaceSpec {
  /** Folder under the publish root. */
  path: string;
  /** Space id or slug. */
  space?: string;
  /** Create the space when it does not exist. */
  create?: { name?: string; type?: string; visibility?: 'PUBLIC' | 'PRIVATE' };
  name?: string;
  visibility?: 'PUBLIC' | 'PRIVATE';
  settings?: Record<string, unknown>;
  theme?: Record<string, unknown>;
  /** The collection files at the space root go into. */
  rootCollection?: string;
  /** Per-folder overrides: name, slug, order, nav. Keyed by folder name. */
  collections?: Record<
    string,
    { name?: string; slug?: string; order?: number; nav?: Record<string, unknown> }
  >;
  openapi?: OpenApiSpec[];
  monitors?: Record<string, unknown>[];
  /** An ABOUT space's parts (`PUT …/about`), inline or a YAML/JSON file beside the manifest. */
  about?: Record<string, unknown> | string;
  /** Slugs (pages/posts) or collection slugs that `--prune` must never remove. */
  keep?: string[];
  /**
   * What a README is in this space: `index` (a folder's own page, GitBook's
   * convention, and the default for page-backed spaces) or `skip`. A posts
   * space always skips it — see `reserved.ts`.
   */
  readme?: 'index' | 'skip';
  /** Extra names to leave out, as globs relative to the space folder. */
  ignore?: string[];
  /** Blog categories by slug: label, colours, description, cover, icon, parent. */
  tags?: Record<string, TagSpec>;
  /**
   * Redirects this space keeps (FMU-F09): a list of rules, or a CSV file
   * (relative to the manifest) in the redirect manager's columns. Merged into
   * the space's table by `publish` — never deletes a rule the file does not
   * name, and never touches the platform's own rename rules.
   */
  redirects?: ManifestRedirect[] | string;
}

/** One redirect a manifest declares — the same keys as `PUT …/redirects`. */
export interface ManifestRedirect {
  from: string;
  to: string;
  status?: 301 | 302 | 307 | 308;
  type?: 'redirect' | 'rewrite';
  passQuery?: boolean;
}

export interface OpenApiSpec {
  /** A file relative to the manifest, JSON or YAML. */
  spec?: string;
  /** Or a URL the API fetches itself. */
  url?: string;
  /** Collection name (found or created) the reference lands in. */
  collection: string;
  /** Everything else is passed to `POST …/docs/openapi/import` as written. */
  [key: string]: unknown;
}

export interface SiteSpec {
  id?: string;
  slug?: string;
  name?: string;
  config?: Record<string, unknown>;
}

export interface Manifest {
  /** Where the manifest was read from, or null when there is none. */
  file: string | null;
  org?: string;
  site?: SiteSpec;
  spaces: SpaceSpec[];
}

/** A live page, from `GET …/pages` (authenticated) or the public space (anonymous). */
export interface LivePage {
  id: string;
  slug: string;
  title: string;
  collectionId: string;
  parentId: string | null;
  sortKey: string;
  published: boolean;
}

export interface LiveCollection {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  sortKey: string;
  nav?: Record<string, unknown>;
}

export interface LivePost {
  id: string;
  slug: string;
  title: string;
  published: boolean;
  markdown?: string;
  sections?: Record<string, string>;
}

/** A tag's display as `GET …/blog/tag-info` answers it. */
export interface LiveTag {
  slug: string;
  [key: string]: unknown;
}

/** What a piece of the plan does — one line in the dry run, one or more calls in the real one. */
export type Verb =
  | 'create'
  | 'update'
  | 'meta'
  | 'move'
  | 'order'
  | 'prune'
  | 'upload'
  | 'patch'
  | 'import'
  | 'same'
  | 'skip'
  | 'warn'
  /** A page edited in the studio since the last publish (FMU-D18). */
  | 'conflict'
  /** A page sent to a pull-request preview instead of published (FMU-F01). */
  | 'preview';

export interface PlanLine {
  verb: Verb;
  what: string;
  detail?: string;
  /** For an update: the changed lines, `-` live and `+` the file (printed with `--diff`). */
  diff?: string[];
}

export interface ScanResult extends LocalSpace {
  /** Per file (relative to the space folder): reference as written → absolute asset path. */
  refs: Map<string, Map<string, string>>;
  /** Every Markdown file of the space (relative to the space folder) → its slug. */
  slugByFile: Map<string, string>;
}


export type Reader = (abs: string) => {
  rel: string;
  text: string;
  data: Record<string, unknown>;
  body: string;
};


/** Shared with `scan-docs.ts`, which walks the docs half. */
export interface DocsWalk {
  fieldKeys: string[];
  slots: Slot[];
  skip: (abs: string, name: string) => boolean;
  hasMarkdown: (dir: string) => boolean;
  isIndex: (file: string) => boolean;
}

