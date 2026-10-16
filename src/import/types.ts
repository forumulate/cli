/**
 * What every importer hands the shared engine (`./engine`).
 *
 * An importer's only jobs are to read its platform's export and to say, for a
 * value of a declared field type, what it MEANS (a rich-text document, a
 * picture, a pointer to another record). Creating the model, uploading media,
 * writing entries, resolving references and publishing are the engine's, so
 * all five platforms land content the same way and report it the same way.
 */

/** A BlockDoc node, structurally; the CLI does not depend on docs-schema. */
export interface DocNode {
  type: string;
  attrs?: Record<string, unknown>;
  content?: DocNode[];
  text?: string;
  marks?: { type: string; attrs?: Record<string, unknown> }[];
}
export interface RichDoc {
  type: 'doc';
  content: DocNode[];
}

/** A picture in rich text, as the source names it; the engine swaps in the uploaded asset's URL. */
export type ImageResolver = (src: string, alt?: string) => string;

/** One record of the export, before any of its values is interpreted. */
export interface RawRecord {
  /** The content type's key: a Payload slug, a Contentful content type id, a Sanity `_type`. */
  type: string;
  /** The source's own id; the engine remembers it so a reference to it can be resolved. */
  id: string;
  published: boolean;
  slug?: string;
  title?: string;
  /** Field key → source value. Keys that match no declared field are reported, not dropped quietly. */
  values: Record<string, unknown>;
  /**
   * The same record's LOCALIZED fields in the source's other locales, by locale
   * code: each becomes the record's locale twin. `values` is the source locale.
   */
  locales?: Record<string, Record<string, unknown>>;
}

/** A file the export refers to, to be uploaded into the library's media. */
export interface SourceMedia {
  id: string;
  filename: string;
  /** Where the bytes are: a path on disk or a URL. */
  location: string;
  alt?: string;
  contentType?: string;
  /** Other ways records name this file (its URL in a rich-text body). */
  aliases?: string[];
}

export interface RefTarget {
  /** Absent when the source does not say (a bare id): the engine resolves it only if one record has that id. */
  type?: string;
  id: string;
}

/** A field as the engine needs it, read off the library's stored model. */
export interface FieldDecl {
  key: string;
  type: string;
  hasMany?: boolean;
  localized?: boolean;
  fields?: FieldDecl[];
  to?: { kind: string; types?: string[] }[];
}

export interface ImportSource {
  /** `payload`, `contentful`…: names the import in the report and in idempotency keys. */
  name: string;
  /**
   * The model the export implies, as a Payload-format config the API's own
   * Payload reader turns into a model (so there is ONE mapping, the API's).
   * Absent when the library's model is already what the records fill.
   */
  modelSource?: string;
  /**
   * The source's languages, when it has more than one. Each non-default one is
   * added to the library (if missing) before its twins are written.
   */
  languages?: { code: string; label: string; default?: boolean }[];
  records: RawRecord[];
  media: SourceMedia[];
  /** What the source wants said to the user (locales it skipped, drafts it merged). */
  notes: string[];
  richText(raw: unknown, image: ImageResolver): RichDoc | null;
  /** The id of the file a media/upload value names. */
  mediaId(raw: unknown): string | null;
  /** The records a reference value names. */
  refs(raw: unknown, field: FieldDecl): RefTarget[];
}

export interface ImportFiles {
  read(path: string): string;
  readBytes(path: string): Uint8Array;
  exists(path: string): boolean;
  /** File names (not paths) directly inside `dir`. */
  list(dir: string): string[];
  isDir(path: string): boolean;
}

export interface ImportReport {
  source: string;
  dryRun: boolean;
  model: { changed: boolean; version: number | null; issues: { path: string; kind: string; message: string }[] };
  entries: { planned: number; created: number; updated: number; translations: number; published: number; failed: { id: string; type: string; message: string }[] };
  media: { planned: number; uploaded: number; failed: { id: string; message: string }[] };
  /** Values the export carried that no declared field takes, by `type.key` with a count. */
  dropped: { field: string; count: number }[];
  /** References whose target is not in the export. */
  unresolved: { from: string; to: string }[];
  notes: string[];
  /** Dry run: how many planned entries already exist (re-runs update them) and how many are new. */
  plan?: { new: number; update: number };
}
