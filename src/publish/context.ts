import { posix } from 'node:path';
import type { PublishApi } from './api';
import type { Slot } from './slots';
import type { ScanResult } from './types';
import type { PlanLine, SpaceSpec } from './types';

/**
 * `--only`: what a run is allowed to touch.
 *
 * A token matches a slug, a file path or a folder (prefix), a collection, a
 * space's folder or slug, or one of the manifest's parts by name — `site`,
 * `theme`, `settings`, `openapi`, `monitors`. With no `--only`, everything.
 * A run narrowed this way never prunes: "publish just this page" must not
 * read as "and delete every page I did not name".
 */
export class Selector {
  readonly all: boolean;
  private readonly tokens: string[];
  constructor(only: string[] | undefined) {
    this.tokens = (only ?? [])
      .map((t) => t.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
      .filter(Boolean);
    this.all = this.tokens.length === 0;
  }
  private hit(value: string | undefined): boolean {
    if (!value) return false;
    const v = value.replace(/\/+$/, '');
    return this.tokens.some((t) => v === t || v.startsWith(`${t}/`));
  }
  /** A manifest part (`theme`, `monitors`, …) of a space. */
  part(name: string, space?: SpaceSpec): boolean {
    return this.all || this.tokens.includes(name) || (space ? this.space(space) : false);
  }
  space(spec: SpaceSpec): boolean {
    return this.all || this.hit(spec.path) || this.hit(spec.space);
  }
  /** A page or post, by slug, by its file (relative to the publish root), or its collection. */
  piece(
    spec: SpaceSpec,
    slug: string,
    file: string,
    collection?: { dir: string; slug: string },
  ): boolean {
    if (this.all || this.space(spec)) return true;
    const rooted = spec.path ? posix.join(spec.path, file) : file;
    return (
      this.tokens.includes(slug) ||
      this.hit(rooted) ||
      this.hit(file) ||
      (collection
        ? this.hit(collection.dir) ||
          this.tokens.includes(collection.slug) ||
          this.hit(posix.join(spec.path || '', collection.dir))
        : false)
    );
  }
}

/** Everything one space's planning and applying share. */
export interface SpaceCtx {
  api: PublishApi;
  /** The org as the API is addressed for this run: an id when authenticated, else what was given. */
  org: string;
  spaceId: string;
  type: string;
  spec: SpaceSpec;
  scan: ScanResult;
  /** The publish root (the folder given on the command line). */
  root: string;
  only: Selector;
  force: boolean;
  prune: boolean;
  dryRun: boolean;
  line: (l: PlanLine) => void;
  errors: string[];
  /** The named slots a page-backed type declares (empty for posts and plain docs). */
  slots?: Slot[];
  /**
   * What the run purges (FMU-D04): undefined keeps the server's background
   * purge and reports nothing (the git sync job); `page`/`none` ride on each
   * import; `space` is one purge when the space is done.
   */
  purge?: 'page' | 'space' | 'none';
  /** Every `purged` answer the server gave this run, for the summary. */
  purged?: Record<string, unknown>[];
}

export const spacePath = (ctx: SpaceCtx, rest: string) =>
  `/orgs/${ctx.org}/spaces/${ctx.spaceId}${rest}`;
