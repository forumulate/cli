import { existsSync, statSync } from 'node:fs';
import { dirname, join, posix, relative, resolve, sep } from 'node:path';
import { findManifest, loadManifest } from '../publish/manifest';
import { ASSET, MD } from '../publish/names';
import { scanSpace } from '../publish/scan';
import type { LocalPage, ScanResult } from '../publish/types';
import { EXIT, exitCodeForError } from '../exit-codes';
import { ExternalChecker, defaultCacheFile, type Fetcher } from './external';
import { markdownAnchors, markdownLinks } from './markdown-links';

/** One broken link, wherever it was found. */
export interface BrokenRow {
  /** A file (folder mode) or a page slug (space mode). */
  where: string;
  line?: number;
  url: string;
  reason: string;
  anchor?: string;
  status?: number;
  location?: string;
}

export interface CheckReport {
  mode: 'folder' | 'space';
  checked: { pages: number; links: number; anchors: number; external: number; unchecked: number };
  broken: BrokenRow[];
}

export interface CheckDeps {
  out: (l: string) => void;
  err: (l: string) => void;
  env?: NodeJS.ProcessEnv;
  /** The API, for `--space` (the SDK client's `request`). */
  request?: <T>(method: string, path: string, opts?: { query?: Record<string, string | number | boolean | undefined> }) => Promise<T>;
  fetch?: Fetcher;
}

export const CHECK_VALUE_FLAGS = ['--allow-redirect', '--ignore'] as const;

export const CHECK_HELP = `forumulate check links [folder] [flags]
forumulate check links --space <id|slug> [--org <id|slug>] [flags]

Find broken links before readers do (FMU-F05).

On a folder (the default, "."): reads it the way \`publish\` does — forumulate.yaml
and every space in it — and checks, without a token and without publishing:
  internal links   ./other.md, ../guide/setup.md, /slug, ./slug — the page must exist
  anchors          #section and page#section — the heading (or {#id}, or id="…") must exist,
                   with the product's own anchor rule (duplicates get -2, -3)
  pictures         a local image or file the page points at must be on disk
  external links   with --external: a 2xx passes; a redirect passes only to a host
                   --allow-redirect allows (default same-host); never followed
On a published space (--space): asks the API for the same report, which adds
reference-page operation anchors (#operationId and #get-v1-x) and uploads.

Flags:
  --external              also check outside links (slow; paced per host; cached a day)
  --allow-redirect <list> hosts a redirect may land on: same-host, docs.x.com, *.x.com
                          (space mode: the space/org key links.check_allowed_redirect_hosts)
  --ignore <pattern>      skip links containing this text (repeatable)
  --no-cache              ask every outside link again
  --json                  the report as JSON on stdout

Exit status: 0 nothing broken, 1 something broken, 2 usage, 3 auth, 4 not found.`;

const flagValues = (argv: string[], name: string): string[] =>
  argv.flatMap((a, i) =>
    a.startsWith(`${name}=`) ? [a.slice(name.length + 1)] : a === name ? [argv[i + 1] ?? ''] : [],
  );

/** `forumulate check …` — only `links` today; the noun leaves room for the next check. */
export async function runCheck(argv: string[], rest: string[], deps: CheckDeps): Promise<number> {
  const [what, folder] = rest;
  if (what !== 'links' || argv.includes('--help')) {
    (what === 'links' || argv.includes('--help') ? deps.out : deps.err)(CHECK_HELP);
    return what === 'links' || argv.includes('--help') ? EXIT.OK : EXIT.USAGE;
  }
  const json = argv.includes('--json');
  const external = argv.includes('--external');
  const allow = flagValues(argv, '--allow-redirect').flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean);
  const ignore = flagValues(argv, '--ignore').filter(Boolean);
  const space = flagValues(argv, '--space')[0];
  let report: CheckReport;
  try {
    report = space
      ? await spaceReport(space, flagValues(argv, '--org')[0], external, deps)
      : folderReport(resolve(folder ?? '.'), deps);
  } catch (e) {
    deps.err(`check links: ${(e as Error).message}`);
    // A folder that cannot be read is the command line's fault (2); an API
    // refusal maps as every command maps it (3 auth, 4 not found, …).
    return space ? exitCodeForError(e) : EXIT.USAGE;
  }
  if (!space && external) {
    const checker = new ExternalChecker({
      allowRedirects: allow.length ? allow : ['same-host'],
      cacheFile: argv.includes('--no-cache') ? null : defaultCacheFile(deps.env),
      fetch: deps.fetch,
    });
    const pending = (report as FolderReport).external;
    const verdicts = await checker.checkAll(pending.keys());
    report.checked.external = pending.size;
    for (const [url, v] of verdicts) {
      if (v.ok) continue;
      for (const at of pending.get(url) ?? [])
        report.broken.push({
          ...at,
          url,
          reason: v.reason ?? 'external_unreachable',
          status: v.status,
          ...(v.location ? { location: v.location } : {}),
        });
    }
  }
  report.broken = report.broken.filter((b) => !ignore.some((p) => b.url.includes(p)));
  print(report, json, deps);
  return report.broken.length ? EXIT.FAILED : EXIT.OK;
}

function print(report: CheckReport, json: boolean, deps: CheckDeps): void {
  const { external: _x, ...plain } = report as FolderReport;
  if (json) {
    deps.out(JSON.stringify(plain, null, 2));
    return;
  }
  for (const b of report.broken) {
    const extra = b.anchor
      ? `  #${b.anchor} is not on that page`
      : b.location
        ? `  → ${b.location} (${b.status})`
        : b.status
          ? `  (${b.status})`
          : '';
    deps.out(`${b.where}${b.line ? `:${b.line}` : ''}  ${b.reason.padEnd(20)} ${b.url}${extra}`);
  }
  const c = report.checked;
  deps.out(
    `${report.broken.length ? `${report.broken.length} broken` : 'No broken links'} — ` +
      `${c.links} link(s) on ${c.pages} page(s), ${c.anchors} anchor(s)` +
      (c.external ? `, ${c.external} outside address(es)` : '') +
      (c.unchecked ? `; ${c.unchecked} link(s) into other spaces not checked from a folder` : '') +
      '.',
  );
}

async function spaceReport(
  space: string,
  orgFlag: string | undefined,
  external: boolean,
  deps: CheckDeps,
): Promise<CheckReport> {
  const org = orgFlag ?? deps.env?.FORUMULATE_ORG ?? process.env.FORUMULATE_ORG;
  if (!org) throw Object.assign(new Error('which organization? Pass --org or set FORUMULATE_ORG.'), { exitCode: EXIT.USAGE });
  if (!deps.request) throw Object.assign(new Error('no API client'), { exitCode: EXIT.AUTH });
  const r = await deps.request<{
    checked: { pages: number; links: number; anchors: number; external: number };
    broken: { pageSlug: string; url: string; reason: string; anchor?: string; status?: number; location?: string }[];
  }>('GET', `/orgs/${encodeURIComponent(org)}/spaces/${encodeURIComponent(space)}/docs/broken-links`, {
    query: { external, refresh: true },
  });
  return {
    mode: 'space',
    checked: { ...r.checked, unchecked: 0 },
    broken: r.broken.map(({ pageSlug, ...b }) => ({ where: pageSlug, ...b })),
  };
}

interface FolderReport extends CheckReport {
  /** Outside URLs → where each was found, for the external pass. */
  external: Map<string, { where: string; line: number }[]>;
}

/** Path inside a space folder → the page it is, case-insensitively. */
function pageIndex(
  root: string,
  scan: ScanResult,
): { bySlug: Map<string, LocalPage>; byFile: Map<string, LocalPage> } {
  const bySlug = new Map<string, LocalPage>();
  const byFile = new Map<string, LocalPage>();
  for (const c of scan.collections)
    for (const p of c.pages) {
      if (p.stub) continue;
      bySlug.set(p.slug, p);
      // `file` is relative to the publish root; links are relative to the page.
      byFile.set(relative(scan.absDir, resolve(root, p.file)).split(sep).join('/').toLowerCase(), p);
    }
  return { bySlug, byFile };
}

/** The folder half: every space the manifest names, read as `publish` reads it. */
export function folderReport(root: string, _deps: Pick<CheckDeps, 'env'> = {}): FolderReport {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new Error(`${root} is not a folder`);
  const manifest = loadManifest(findManifest(root));
  const spaces = manifest.spaces.map((spec) => {
    const scan = scanSpace(root, spec, 'docs', []);
    return { key: spec.space ?? spec.path, spec, scan, ...pageIndex(root, scan) };
  });
  const byKey = new Map(spaces.map((s) => [s.key ?? '', s] as const));
  const anchorsMemo = new Map<LocalPage, Set<string>>();
  const anchorsOf = (p: LocalPage) => {
    let a = anchorsMemo.get(p);
    if (!a) anchorsMemo.set(p, (a = markdownAnchors(p.source, p.title)));
    return a;
  };
  const report: FolderReport = {
    mode: 'folder',
    checked: { pages: 0, links: 0, anchors: 0, external: 0, unchecked: 0 },
    broken: [],
    external: new Map(),
  };
  for (const s of spaces) {
    for (const page of s.bySlug.values()) {
      report.checked.pages += 1;
      const fileAbs = resolve(root, page.file);
      const inSpace = relative(s.scan.absDir, fileAbs).split(sep).join('/');
      for (const link of markdownLinks(page.source)) {
        const href = link.href.trim();
        if (!href || /^(mailto|tel|javascript|data):/i.test(href)) continue;
        report.checked.links += 1;
        const where = { where: page.file, line: link.line };
        if (/^https?:\/\//i.test(href)) {
          const bare = href.replace(/#.*$/, '');
          report.external.set(bare, [...(report.external.get(bare) ?? []), where]);
          continue;
        }
        if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//')) continue;
        const hash = href.indexOf('#');
        const path = (hash >= 0 ? href.slice(0, hash) : href).replace(/\?.*$/, '');
        let anchor: string | null = null;
        if (hash >= 0 && hash < href.length - 1) {
          try {
            anchor = decodeURIComponent(href.slice(hash + 1));
          } catch {
            anchor = href.slice(hash + 1);
          }
        }
        let target: LocalPage | undefined;
        if (!path) target = page;
        else if (MD.test(path)) {
          let rel: string;
          try {
            rel = posix.normalize(posix.join(posix.dirname(inSpace), decodeURI(path))).toLowerCase();
          } catch {
            rel = path.toLowerCase();
          }
          target = s.byFile.get(rel);
          if (!target) {
            report.broken.push({ ...where, url: href, reason: 'internal_not_found' });
            continue;
          }
        } else if (ASSET.test(path) || link.media) {
          // A picture or file next to the page; a root path is the site's to serve.
          if (path.startsWith('/')) continue;
          let abs: string;
          try {
            abs = join(dirname(fileAbs), decodeURI(path));
          } catch {
            abs = join(dirname(fileAbs), path);
          }
          if (!existsSync(abs)) report.broken.push({ ...where, url: href, reason: 'asset_missing' });
          continue;
        } else {
          const segments = path.split('/').filter((x) => x && x !== '.');
          const last = (segments[segments.length - 1] ?? '').replace(/\.md$/i, '');
          if (path.startsWith('/') && segments.length > 1) {
            const other = byKey.get(segments[0]!);
            if (!other) {
              // Another section of the site we cannot see from this folder.
              report.checked.unchecked += 1;
              continue;
            }
            target = other.bySlug.get(last);
          } else target = s.bySlug.get(last);
          if (!target) {
            report.broken.push({ ...where, url: href, reason: 'internal_not_found' });
            continue;
          }
        }
        if (anchor && target) {
          report.checked.anchors += 1;
          if (!anchorsOf(target).has(anchor))
            report.broken.push({ ...where, url: href, reason: 'anchor_not_found', anchor });
        }
      }
    }
  }
  return report;
}
