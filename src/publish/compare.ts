/**
 * "Is the live page already this file?" — asked without the product's converter.
 *
 * The exact answer needs the product's own Markdown converter, which is not
 * published, so a CLI on npm cannot load it. What that converter taught us the
 * hard way still applies, so this keeps its rules:
 *
 *  - Wrapping is not content. Source files are hard-wrapped and the stored
 *    page is one line per paragraph, so comparing lines measured the wrapping
 *    and reported everything as drifted.
 *  - The page's own title is not body: the importer lifts the leading `# H1`
 *    into the title, and the public `.md` puts it back.
 *  - Our agent footer ("## For AI agents") is appended on the public read and
 *    is never in the file.
 *  - Link and image TARGETS are not compared: the import rewrites `./x.md` to
 *    the page address and a local image to an uploaded asset URL, so the
 *    target is never the same string twice. The link TEXT is compared.
 *
 * What is left is the sequence of words and the punctuation that changes
 * meaning. A change to formatting alone (bold added to a word) is invisible to
 * this, on purpose — `--force` re-sends everything for the rare run where that
 * is the whole change.
 */
export function comparable(markdown: string): string {
  let s = markdown.replace(/\r\n?/g, '\n');
  s = s.replace(/^\ufeff?---\n[\s\S]*?\n---[ \t]*\n?/, '');
  const footer = s.search(/\n-{3,}\s*\n+#{1,3} For AI agents\b/);
  if (footer >= 0) s = s.slice(0, footer);
  // Every leading H1: the public read prepends the title, and a file that
  // declares a title AND opens with a heading keeps that heading as content.
  s = s.replace(/^(?:\s*#\s+[^\n]*(?:\n|$))+/, '');
  s = s.replace(/(!?\[[^\]]*\])\([^)]*\)/g, '$1');
  s = s.replace(/\b(?:src|href|poster)\s*=\s*["'][^"']*["']/g, '');
  // Markup characters whose spelling the converter normalises: emphasis
  // markers, table padding, list bullets, heading hashes, escapes.
  s = s
    .replace(/[*_`#>|\\~]+/g, ' ')
    .replace(/^\s*[-+]\s+/gm, ' ')
    .replace(/^\s*\d+[.)]\s+/gm, ' ');
  s = s.replace(/:-{3,}:?|-{3,}:?/g, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

/** Same text by the rules above. */
export const sameText = (a: string, b: string): boolean => comparable(a) === comparable(b);

/** Structural equality for JSON-ish values — objects compared key by key, order-free. */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    // `undefined` and absent and `null` are the same "not set" for a patch.
    return (a ?? null) === (b ?? null);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => deepEqual(x, bb[i]));
  }
  const ka = Object.keys(a as object).filter(
    (k) => (a as Record<string, unknown>)[k] !== undefined,
  );
  const kb = Object.keys(b as object).filter(
    (k) => (b as Record<string, unknown>)[k] !== undefined,
  );
  if (ka.length !== kb.length) return false;
  return ka.every((k) =>
    deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]),
  );
}

/**
 * Does `live` already hold everything `want` says? Extra keys on the live side
 * are fine — a manifest names what it manages, and a PATCH merges.
 */
export function holds(live: unknown, want: unknown): boolean {
  if (want === null || typeof want !== 'object' || Array.isArray(want))
    return deepEqual(live, want);
  if (live === null || typeof live !== 'object' || Array.isArray(live)) return false;
  return Object.entries(want as Record<string, unknown>).every(([k, v]) =>
    holds((live as Record<string, unknown>)[k], v),
  );
}

/** The top-level keys of `want` that `live` does not already hold. */
export function differingKeys(
  live: Record<string, unknown> | undefined,
  want: Record<string, unknown>,
): string[] {
  return Object.keys(want).filter((k) => !holds(live?.[k], want[k]));
}

/**
 * Which items can stay where they are when `current` is rearranged into
 * `desired` — the longest run already in the right relative order.
 *
 * Reordering one page at a time costs a request per page, paced to stay under
 * the rate limit. Moving only the pages NOT in this run turns "swap
 * two pages" from n requests into one or two.
 */
export function stayPut(desired: string[], current: string[]): Set<string> {
  const pos = new Map(current.map((id, i) => [id, i]));
  const seq = desired.filter((id) => pos.has(id));
  const idx = seq.map((id) => pos.get(id)!);
  // Patience LIS with predecessor links.
  const tails: number[] = [];
  const prev = new Array<number>(idx.length).fill(-1);
  for (let i = 0; i < idx.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (idx[tails[mid]!]! < idx[i]!) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[i] = tails[lo - 1]!;
    tails[lo] = i;
  }
  const keep = new Set<string>();
  for (let k = tails.length ? tails[tails.length - 1]! : -1; k >= 0; k = prev[k]!)
    keep.add(seq[k]!);
  return keep;
}
