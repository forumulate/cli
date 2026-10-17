/**
 * XLIFF 1.2 for the two string tables (chrome labels, UI overrides).
 *
 * Every translation management system a customer already pays for (Crowdin,
 * Lokalise, Phrase, Smartling) imports and exports XLIFF; none of them reads
 * our label dictionary's JSON. One `<file>` per target language, one
 * `<trans-unit>` per string: `id` is the key (the original words for a label,
 * the catalog key for an override), `<source>` what it replaces, `<target>`
 * the language's words — empty when nobody has translated it yet, so the TMS
 * shows it as work to do. Small and dependency-free on purpose: the CLI ships
 * with two dependencies and a parser for one well-known dialect is not a third.
 */

export interface XliffUnit {
  id: string;
  source: string;
  target: string;
}

export interface XliffFile {
  /** The target language code (`es`, `pt-BR`). */
  locale: string;
  units: XliffUnit[];
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, '&');

export function toXliff(files: XliffFile[], opts: { original: string; sourceLanguage?: string }): string {
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<xliff version="1.2" xmlns="urn:oasis:names:tc:xliff:document:1.2">'];
  for (const f of files) {
    out.push(
      `  <file original="${esc(opts.original)}" source-language="${esc(opts.sourceLanguage ?? 'en')}" target-language="${esc(f.locale)}" datatype="plaintext">`,
      '    <body>',
    );
    for (const u of f.units) {
      out.push(
        `      <trans-unit id="${esc(u.id)}">`,
        `        <source>${esc(u.source)}</source>`,
        `        <target>${esc(u.target)}</target>`,
        '      </trans-unit>',
      );
    }
    out.push('    </body>', '  </file>');
  }
  out.push('</xliff>', '');
  return out.join('\n');
}

/** Every `<file>` and its units. An empty `<target>` is kept as `''` (untranslated). */
export function fromXliff(xml: string): XliffFile[] {
  const files: XliffFile[] = [];
  for (const f of xml.matchAll(/<file\b([^>]*)>([\s\S]*?)<\/file>/g)) {
    const attrs = f[1] ?? '';
    const locale = /target-language="([^"]*)"/.exec(attrs)?.[1];
    if (!locale) throw new Error('An XLIFF <file> has no target-language.');
    const units: XliffUnit[] = [];
    for (const u of (f[2] ?? '').matchAll(/<trans-unit\b([^>]*)>([\s\S]*?)<\/trans-unit>/g)) {
      const id = /\bid="([^"]*)"/.exec(u[1] ?? '')?.[1];
      if (id === undefined) continue;
      const inner = u[2] ?? '';
      const source = /<source\b[^>]*>([\s\S]*?)<\/source>/.exec(inner)?.[1] ?? '';
      const target = /<target\b[^>]*>([\s\S]*?)<\/target>/.exec(inner)?.[1] ?? '';
      units.push({ id: unesc(id), source: unesc(source), target: unesc(target) });
    }
    files.push({ locale: unesc(locale), units });
  }
  if (!files.length) throw new Error('No XLIFF <file> elements found.');
  return files;
}
