import { posix } from 'node:path';

/**
 * What changes between the file on disk and the text the API is sent.
 *
 * Only addresses. The prose — and with it our Markdown directive dialect
 * (`:::note`, `{% tabs %}`, admonitions, components) — goes through as
 * written, because the importer is the product's own converter and a second
 * converter here would be a second, drifting opinion about the same syntax.
 * Every customer publisher that grew its own block converter (two of the four)
 * ended up maintaining it against ours.
 */

/** Characters with meaning in a regular expression, escaped. */
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `[text](../setup/install.md#flags)` → `[text](./install#flags)`.
 *
 * The importer rewrites links between files it is sent in the SAME call, and
 * the publisher only sends what changed — so a changed page linking an
 * unchanged one would keep a link to a `.md` file that does not exist on the
 * web. The CLI knows every file's slug, so it rewrites every link it can
 * resolve itself, in the importer's own form (page-relative `./slug`: the same
 * page is reached at `/slug`, `/space/slug` and `/p/org/space/slug`, and only a
 * relative link is right at all three).
 */
export function rewriteLinks(
  source: string,
  file: string,
  slugByFile: Map<string, string>,
): string {
  const lower = new Map([...slugByFile].map(([k, v]) => [k.toLowerCase(), v]));
  const target = (ref: string): string | null => {
    const m = /^(?!\w[\w+.-]*:|\/|#)([^?#\s]+\.(?:md|mdx|markdown))((?:[?#][^\s]*)?)$/i.exec(ref);
    if (!m) return null;
    let path: string;
    try {
      path = posix.normalize(posix.join(posix.dirname(file), decodeURI(m[1]!)));
    } catch {
      return null;
    }
    const slug = lower.get(path.toLowerCase());
    return slug ? `./${slug}${m[2] ?? ''}` : null;
  };
  let out = source.replace(/(\]\(\s*)(<[^>]+>|[^)\s]+)/g, (all, open: string, ref: string) => {
    const t = target(ref.replace(/^<|>$/g, ''));
    return t ? `${open}${t}` : all;
  });
  out = out.replace(
    /(\bhref\s*=\s*["'])([^"']+)(["'])/g,
    (all, a: string, ref: string, b: string) => {
      const t = target(ref);
      return t ? `${a}${t}${b}` : all;
    },
  );
  return out;
}

/**
 * Local images and files → the uploaded asset's URL, wherever the file names
 * them: a Markdown image or link, an HTML `src`/`href`, a front matter value.
 */
export function rewriteAssets(source: string, urlByRef: Map<string, string>): string {
  let out = source;
  for (const [ref, url] of urlByRef) {
    const r = esc(ref);
    out = out
      .replace(new RegExp(`(\\]\\(\\s*<?)${r}(>?)`, 'g'), `$1${url}$2`)
      .replace(new RegExp(`(\\b(?:src|href|poster)\\s*=\\s*["'])${r}(["'])`, 'g'), `$1${url}$2`)
      .replace(
        new RegExp(`(^|\\n)([ \\t]*[\\w-]+\\s*:\\s*["']?)${r}(["']?[ \\t]*(?=\\n|$))`, 'g'),
        `$1$2${url}$3`,
      )
      .replace(new RegExp(`(\\n[ \\t]*-\\s*["']?)${r}(["']?[ \\t]*(?=\\n|$))`, 'g'), `$1${url}$2`);
  }
  return out;
}

/** The same substitution over a metadata patch (values that were local paths). */
export function rewriteValue<T>(value: T, urlByRef: Map<string, string>): T {
  if (typeof value === 'string') return (urlByRef.get(value.trim()) ?? value) as T;
  if (Array.isArray(value)) return value.map((v) => rewriteValue(v, urlByRef)) as T;
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, rewriteValue(v, urlByRef)]),
    ) as T;
  return value;
}

/**
 * Does the live text still point at every picture the file's body uses?
 *
 * The word comparison (`compare.ts`) ignores link and image targets on
 * purpose — the importer rewrites them, so they are never the same string
 * twice. That left one change invisible: an image replaced by a new one under
 * the same name uploads under a new content hash, and the post kept pointing
 * at the old picture because its words had not changed. So the targets are
 * checked here instead, by the URL each reference resolves to: one that is
 * not uploaded yet, or not in the live text, means the body must be sent.
 */
export function mediaChanged(
  body: string,
  refs: Map<string, string> | undefined,
  urls: Map<string, string>,
  liveText: string,
): boolean {
  for (const ref of refs?.keys() ?? []) {
    if (!body.includes(ref)) continue; // a front-matter value: compared as a field
    const url = urls.get(ref);
    if (!url || !liveText.includes(url)) return true;
  }
  return false;
}
