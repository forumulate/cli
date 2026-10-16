/**
 * Building blocks every rich-text reader uses to write a BlockDoc.
 *
 * Text is held as runs with a set of marks and only turned into nodes at the
 * end, so adjacent runs with the same marks merge (a source that splits
 * "Hello" into five spans must not become five nodes) and empty text is never
 * written (the block model refuses it).
 */
import type { DocNode, RichDoc } from './types';

export type MarkName = 'bold' | 'italic' | 'code' | 'strike' | 'underline';
export interface Run {
  text: string;
  marks: MarkName[];
  href?: string;
}

const ORDER: MarkName[] = ['bold', 'italic', 'strike', 'underline', 'code'];

export function textNodes(runs: Run[]): DocNode[] {
  const out: DocNode[] = [];
  let last: Run | undefined;
  for (const r of runs) {
    if (r.text === '\n') {
      out.push({ type: 'hardBreak' });
      last = undefined;
      continue;
    }
    if (!r.text) continue;
    const same = (a: Run, b: Run) => a.href === b.href && a.marks.length === b.marks.length && a.marks.every((m) => b.marks.includes(m));
    if (last && same(last, r)) {
      out[out.length - 1]!.text += r.text;
      continue;
    }
    const marks = [...ORDER.filter((m) => r.marks.includes(m)).map((type) => ({ type })), ...(r.href ? [{ type: 'link', attrs: { href: r.href } }] : [])];
    out.push({ type: 'text', text: r.text, ...(marks.length ? { marks } : {}) });
    last = r;
  }
  return out;
}

export const paragraph = (runs: Run[]): DocNode => {
  const content = textNodes(runs);
  return content.length ? { type: 'paragraph', content } : { type: 'paragraph' };
};
export const heading = (level: number, runs: Run[]): DocNode => ({
  type: 'heading',
  attrs: { level: Math.min(6, Math.max(1, level)) },
  content: textNodes(runs),
});
export const codeBlock = (code: string, language?: string | null): DocNode => ({
  type: 'codeBlock',
  attrs: language ? { language } : {},
  ...(code ? { content: [{ type: 'text', text: code }] } : {}),
});
export const image = (src: string, alt?: string): DocNode => ({ type: 'image', attrs: { src, ...(alt ? { alt } : {}) } });
export const list = (ordered: boolean, items: DocNode[][]): DocNode => ({
  type: ordered ? 'orderedList' : 'bulletList',
  content: items.map((content) => ({ type: 'listItem', content: content.length ? content : [{ type: 'paragraph' }] })),
});

/** A document is never empty: the editor and the block model both need one block. */
export function doc(content: DocNode[]): RichDoc {
  return { type: 'doc', content: content.length ? content : [{ type: 'paragraph' }] };
}

/** The `http(s)`, `mailto:`, relative and `#` links a document may carry; `javascript:` and friends are dropped. */
export function safeHref(href: string | undefined | null): string | undefined {
  if (!href) return undefined;
  const h = href.trim();
  return /^(https?:|mailto:|tel:|\/|#|\.{1,2}\/)/i.test(h) || !/^[a-z][a-z0-9+.-]*:/i.test(h) ? h : undefined;
}
