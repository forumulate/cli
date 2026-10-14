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
}

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
  /** Slugs (pages/posts) or collection slugs that `--prune` must never remove. */
  keep?: string[];
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
  | 'warn';

export interface PlanLine {
  verb: Verb;
  what: string;
  detail?: string;
}
