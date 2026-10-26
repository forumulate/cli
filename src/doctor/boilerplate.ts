/**
 * Descriptions that were written by a template, not by the site's owner.
 *
 * A space with no description of its own fell back to the preset's blurb —
 * "Guides and reference, in a nested tree.", "Community discussions in
 * Community." — and that sentence became the meta description, the og:description
 * a link preview shows, and the summary line of llms.txt (FMU-B08). Nothing was
 * broken in the HTTP sense, so no check noticed; a reader sharing a link noticed.
 *
 * One list, in one place, so `meta-description` and `llms-txt` judge the same
 * strings. Patterns rather than exact strings: the template interpolates the
 * space or site name, and the point is to recognise the template whatever was
 * poured into it. They are generic generator phrasings — any docs platform
 * that fills an empty description from a type preset produces sentences of this
 * shape — not a list of one vendor's copy.
 */
export const PRESET_DESCRIPTION_PATTERNS: readonly RegExp[] = [
  /^guides and reference, in a nested tree\.?$/i,
  /^community discussions in .+\.?$/i,
  /^the latest posts from .+\.?$/i,
  /^published documentation for .+\.?$/i,
  /^documentation for .+\.?$/i,
  /^welcome to .+ (?:docs|documentation)\.?$/i,
  // A not-found page's title used as a description: the address in the
  // sitemap or llms.txt is dead, and the preview says so to everybody.
  /this page isn[’']t here/i,
];

export function isPresetDescription(text: string): boolean {
  const t = text.trim();
  return PRESET_DESCRIPTION_PATTERNS.some((re) => re.test(t));
}

/** Small words a real sentence has and a list of headings also has. */
const STOP = new Set(['and', 'or', 'the', 'of', 'a', 'an', 'to', 'in', 'for', 'with', 'on', '&']);

/**
 * True when a description is headings run together rather than prose.
 *
 * A generated reference landing described itself as its tag names joined with
 * spaces — "Referalli API Analytics and operations Billing Authentication
 * Programs and partners Partner portal Payouts…" (FMU-B09). It has words, so
 * "missing" never fires; it has no sentence in it, which is what this tests:
 * eight words or more, no sentence punctuation at all, and most of the
 * non-trivial words capitalised. A run of CamelCase joins (`PayoutsPartners`)
 * counts too — that is the same list with the spaces lost.
 */
export function isHeadingSoup(text: string): boolean {
  const t = text.replace(/(?:…|\.\.\.)\s*$/, '').trim();
  if ((t.match(/[a-z][A-Z][a-z]/g) ?? []).length >= 2 && !/[.,;:!?]/.test(t)) return true;
  if (/[.,;:!?—–()]/.test(t)) return false;
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 8) return false;
  const content = words.filter((w) => !STOP.has(w.toLowerCase()));
  if (content.length === 0) return false;
  const capped = content.filter((w) => /^[A-Z0-9]/.test(w)).length;
  return capped / content.length >= 0.5;
}

/** Why a description is not one, or undefined when it reads like one somebody wrote. */
export function descriptionProblem(text: string | undefined): string | undefined {
  if (text === undefined) return 'missing';
  if (!text.trim()) return 'empty';
  if (isPresetDescription(text)) return `preset text "${text.trim()}"`;
  if (isHeadingSoup(text)) return `headings run together "${text.trim().slice(0, 80)}…"`;
  return undefined;
}
