import { posix } from 'node:path';

/**
 * Names in a content folder that are never content (R-N11).
 *
 * A repository that holds a blog also holds a README that explains the
 * repository, a LICENSE, editor folders and a `_drafts` folder of posts nobody
 * has finished. Every customer publisher we were shown carried its own list of
 * these, and the first version of each list was the one that published the
 * README as a post — readers met "How to run this repo locally" at the top of
 * a newsroom. The list lives here, once, and the guide prints it
 * (docs/guides/content-as-code.md, "Reserved names").
 *
 * Three groups, each for its own reason:
 *
 *  - Hidden and private: anything starting with `.` (`.git`, `.github`,
 *    `.DS_Store`) or `_` (`_drafts`, `_templates`, and the metadata files this
 *    tool reads itself: `_collection.yml`, `_tags.yml`). `node_modules`.
 *  - The manifest: `forumulate.yaml`, `.yml`, `.json`.
 *  - Repository paperwork, in any case and with any Markdown extension:
 *    README, LICENSE/LICENCE, CONTRIBUTING, CODE_OF_CONDUCT, SECURITY,
 *    CODEOWNERS, and GitBook's SUMMARY (a table of contents, not a page).
 *
 * README is the one with a second meaning. In a DOCS tree it is GitBook's way
 * of naming a folder's own page, and existing docs repositories rely on that,
 * so a page-backed space keeps it as the folder's index unless its manifest
 * says `readme: skip`. A posts space has no folder pages, so there a README is
 * always paperwork.
 */
export const MANIFEST_NAMES = ['forumulate.yaml', 'forumulate.yml', 'forumulate.json'];

/** Repository paperwork, by file stem (lower-cased, extension dropped). */
export const PAPERWORK = [
  'readme',
  'license',
  'licence',
  'contributing',
  'code_of_conduct',
  'code-of-conduct',
  'security',
  'codeowners',
  'summary',
] as const;

/** Folders that are never content, beyond the `.` and `_` prefixes. */
export const RESERVED_FOLDERS = ['node_modules'] as const;

const stemOf = (name: string) => name.replace(/\.[^.]*$/, '').toLowerCase();

/** Is this README-shaped (`README.md`, `readme.mdx`, `Readme.markdown`)? */
export const isReadme = (name: string) => /^readme\.(md|mdx|markdown)$/i.test(name);

/**
 * Why `name` is skipped, or null when it is content.
 *
 * `readmeIsIndex`: a docs space keeps README as a folder's page (see above).
 */
export function reservedReason(
  name: string,
  isDir: boolean,
  readmeIsIndex: boolean,
): string | null {
  if (name.startsWith('.')) return 'hidden';
  if (name.startsWith('_')) return isDir ? 'private folder' : 'private file';
  if ((RESERVED_FOLDERS as readonly string[]).includes(name)) return 'dependency folder';
  if (MANIFEST_NAMES.includes(name)) return 'the manifest';
  if (isDir) return null;
  if (isReadme(name) && readmeIsIndex) return null;
  if ((PAPERWORK as readonly string[]).includes(stemOf(name))) return 'repository paperwork';
  return null;
}

/**
 * The manifest's `ignore:` patterns, as a matcher over paths relative to the
 * space folder. A small glob: `*` is any run within one segment, `**` any run
 * of segments, `?` one character; a pattern without a `/` matches a name at
 * any depth (`*.draft.md`), one with a `/` matches from the space folder
 * (`archive/**`). A folder that matches is skipped with everything under it.
 */
export function ignoreMatcher(patterns: readonly string[] | undefined): (rel: string) => boolean {
  const res = (patterns ?? [])
    .map((p) => p.trim().replace(/^\.\//, '').replace(/\/+$/, ''))
    .filter(Boolean)
    .map((p) => {
      const anchored = p.includes('/');
      let src = '';
      for (let i = 0; i < p.length; i++) {
        const c = p[i]!;
        if (c === '*' && p[i + 1] === '*') {
          // `**/` is "any folders, or none"; a bare `**` is "anything".
          if (p[i + 2] === '/') {
            src += '(?:.*/)?';
            i += 2;
          } else {
            src += '.*';
            i += 1;
          }
        } else if (c === '*') src += '[^/]*';
        else if (c === '?') src += '[^/]';
        else src += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }
      return new RegExp(anchored ? `^${src}$` : `(?:^|/)${src}$`, 'i');
    });
  if (!res.length) return () => false;
  return (rel) => {
    const path = posix.normalize(rel.split('\\').join('/'));
    return res.some((re) => re.test(path));
  };
}
