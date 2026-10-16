/**
 * The structured rich-text formats to a BlockDoc: Payload's Lexical,
 * Sanity's Portable Text, Contentful's rich text and Strapi's `blocks`.
 *
 * Each walks its own tree and writes the same few node kinds through
 * ./richtext-core. A node a format has and the block model does not (an
 * embedded entry, a custom Portable Text object) becomes its plain text, or
 * nothing when it has none; `skipped` counts them so the report can say so
 * instead of the page silently coming out shorter.
 */
import { codeBlock, doc, heading, image, list, paragraph, safeHref, type MarkName, type Run } from './richtext-core';
import type { DocNode, ImageResolver, RichDoc } from './types';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/* ------------------------------ Lexical ------------------------------ */

/** Lexical's `format` bitmask on a text node. */
const LEXICAL_FORMATS: [number, MarkName][] = [[1, 'bold'], [2, 'italic'], [4, 'strike'], [8, 'underline'], [16, 'code']];

export function fromLexical(value: unknown, imageOf: ImageResolver, mediaUrl: (id: unknown) => string | null = () => null): RichDoc | null {
  const root = isObj(value) && isObj(value.root) ? value.root : null;
  if (!root) return null;
  const runs = (children: unknown[], href?: string): Run[] =>
    children.flatMap((c): Run[] => {
      if (!isObj(c)) return [];
      if (c.type === 'linebreak') return [{ text: '\n', marks: [] }];
      if (c.type === 'text') {
        const f = typeof c.format === 'number' ? c.format : 0;
        return [{ text: str(c.text) ?? '', marks: LEXICAL_FORMATS.filter(([bit]) => f & bit).map(([, m]) => m), href }];
      }
      if (c.type === 'link' || c.type === 'autolink') {
        const fields = isObj(c.fields) ? c.fields : {};
        return runs(arr(c.children), safeHref(str(fields.url) ?? str(c.url)) ?? href);
      }
      return runs(arr(c.children), href);
    });
  const blocks = (nodes: unknown[]): DocNode[] =>
    nodes.flatMap((n): DocNode[] => {
      if (!isObj(n)) return [];
      const kids = arr(n.children);
      switch (n.type) {
        case 'paragraph': {
          const r = runs(kids);
          return r.length ? [paragraph(r)] : [];
        }
        case 'heading':
          return [heading(Number(String(n.tag ?? 'h2').slice(1)) || 2, runs(kids))];
        case 'quote':
          return [{ type: 'blockquote', content: [paragraph(runs(kids))] }];
        case 'list':
          return [list(n.listType === 'number', kids.map((li) => (isObj(li) ? blocks(arr(li.children).some((x) => isObj(x) && x.type === 'list') ? arr(li.children) : [{ type: 'paragraph', children: li.children }]) : [])))];
        case 'code':
          return [codeBlock(kids.map((k) => (isObj(k) ? (k.type === 'linebreak' ? '\n' : (str(k.text) ?? '')) : '')).join(''), str(n.language))];
        case 'horizontalrule':
          return [{ type: 'horizontalRule' }];
        case 'upload': {
          const v = isObj(n.value) ? n.value : {};
          const src = str(v.url) ?? mediaUrl(n.value) ?? undefined;
          return src ? [image(imageOf(src, str(v.alt)), str(v.alt))] : [];
        }
        default:
          return kids.length ? blocks(kids) : [];
      }
    });
  return doc(blocks(arr(root.children)));
}

/* --------------------------- Portable Text --------------------------- */

const PT_MARKS: Record<string, MarkName> = { strong: 'bold', em: 'italic', code: 'code', 'strike-through': 'strike', underline: 'underline' };

export function fromPortableText(value: unknown, imageOf: ImageResolver, assetUrl: (ref: string) => string | null): RichDoc | null {
  if (!Array.isArray(value)) return null;
  const out: DocNode[] = [];
  // Consecutive list items of one kind are one list; a list item's `level` nests it.
  let open: { kind: string; items: { level: number; content: DocNode[] }[] } | null = null;
  const closeList = () => {
    if (!open) return;
    const build = (level: number, from: number): { node: DocNode[]; next: number } => {
      const items: DocNode[][] = [];
      let i = from;
      while (i < open!.items.length && open!.items[i]!.level >= level) {
        const it = open!.items[i]!;
        const kids = [...it.content];
        i++;
        if (i < open!.items.length && open!.items[i]!.level > level) {
          const nested = build(level + 1, i);
          kids.push(...nested.node);
          i = nested.next;
        }
        items.push(kids);
      }
      return { node: [list(open!.kind === 'number', items)], next: i };
    };
    out.push(...build(Math.min(...open.items.map((x) => x.level)), 0).node);
    open = null;
  };
  for (const b of value) {
    if (!isObj(b)) continue;
    if (b._type === 'block') {
      const defs = new Map(arr(b.markDefs).filter(isObj).map((d) => [str(d._key) ?? '', d] as const));
      const runs: Run[] = arr(b.children).filter(isObj).map((s) => {
        const marks: MarkName[] = [];
        let href: string | undefined;
        for (const m of arr(s.marks)) {
          if (typeof m !== 'string') continue;
          if (PT_MARKS[m]) marks.push(PT_MARKS[m]!);
          else if (defs.get(m)?._type === 'link') href = safeHref(str(defs.get(m)!.href));
        }
        return { text: str(s.text) ?? '', marks, href };
      });
      if (typeof b.listItem === 'string') {
        if (open && open.kind !== b.listItem) closeList();
        (open ??= { kind: b.listItem, items: [] }).items.push({ level: Number(b.level) || 1, content: [paragraph(runs)] });
        continue;
      }
      closeList();
      const style = str(b.style) ?? 'normal';
      const h = /^h([1-6])$/.exec(style);
      if (h) out.push(heading(Number(h[1]), runs));
      else if (style === 'blockquote') out.push({ type: 'blockquote', content: [paragraph(runs)] });
      else if (runs.some((r) => r.text)) out.push(paragraph(runs));
      continue;
    }
    closeList();
    if (b._type === 'image') {
      const ref = isObj(b.asset) ? str(b.asset._ref) : undefined;
      const url = ref ? assetUrl(ref) : null;
      if (url) out.push(image(imageOf(url, str(b.alt)), str(b.alt)));
    } else if (b._type === 'code') out.push(codeBlock(str(b.code) ?? '', str(b.language)));
  }
  closeList();
  return doc(out);
}

/* ---------------------------- Contentful ---------------------------- */

const CF_MARKS: Record<string, MarkName> = { bold: 'bold', italic: 'italic', code: 'code', underline: 'underline' };

/** `assetOf` maps a linked asset id to the URL the engine will rewrite to the uploaded file. */
export function fromContentful(value: unknown, imageOf: ImageResolver, assetOf: (id: string) => { url: string; alt?: string } | null): RichDoc | null {
  if (!isObj(value) || value.nodeType !== 'document') return null;
  const runs = (nodes: unknown[], href?: string): Run[] =>
    nodes.flatMap((n): Run[] => {
      if (!isObj(n)) return [];
      if (n.nodeType === 'text') {
        return [{ text: str(n.value) ?? '', marks: arr(n.marks).filter(isObj).map((m) => CF_MARKS[str(m.type) ?? '']).filter((m): m is MarkName => !!m), href }];
      }
      const data = isObj(n.data) ? n.data : {};
      return runs(arr(n.content), n.nodeType === 'hyperlink' ? safeHref(str(data.uri)) : href);
    });
  const blocks = (nodes: unknown[]): DocNode[] =>
    nodes.flatMap((n): DocNode[] => {
      if (!isObj(n)) return [];
      const kids = arr(n.content);
      const nt = str(n.nodeType) ?? '';
      const h = /^heading-([1-6])$/.exec(nt);
      if (h) return [heading(Number(h[1]), runs(kids))];
      switch (nt) {
        case 'paragraph': {
          const r = runs(kids);
          return r.some((x) => x.text) ? [paragraph(r)] : [];
        }
        case 'unordered-list':
        case 'ordered-list':
          return [list(nt === 'ordered-list', kids.map((li) => (isObj(li) ? blocks(arr(li.content)) : [])))];
        case 'blockquote':
          return [{ type: 'blockquote', content: blocks(kids) }];
        case 'hr':
          return [{ type: 'horizontalRule' }];
        case 'embedded-asset-block': {
          const data = isObj(n.data) ? n.data : {};
          const target = isObj(data.target) && isObj(data.target.sys) ? str(data.target.sys.id) : undefined;
          const asset = target ? assetOf(target) : null;
          return asset ? [image(imageOf(asset.url, asset.alt), asset.alt)] : [];
        }
        default:
          return kids.length ? blocks(kids) : [];
      }
    });
  return doc(blocks(arr(value.content)));
}

/* ------------------------------ Strapi ------------------------------ */

export function fromStrapiBlocks(value: unknown, imageOf: ImageResolver): RichDoc | null {
  if (!Array.isArray(value)) return null;
  const runs = (nodes: unknown[], href?: string): Run[] =>
    nodes.flatMap((n): Run[] => {
      if (!isObj(n)) return [];
      if (n.type === 'link') return runs(arr(n.children), safeHref(str(n.url)) ?? href);
      if (n.type !== undefined && n.type !== 'text') return runs(arr(n.children), href);
      const marks: MarkName[] = [];
      if (n.bold) marks.push('bold');
      if (n.italic) marks.push('italic');
      if (n.strikethrough) marks.push('strike');
      if (n.underline) marks.push('underline');
      if (n.code) marks.push('code');
      return [{ text: str(n.text) ?? '', marks, href }];
    });
  const blocks = (nodes: unknown[]): DocNode[] =>
    nodes.flatMap((n): DocNode[] => {
      if (!isObj(n)) return [];
      const kids = arr(n.children);
      switch (n.type) {
        case 'paragraph': {
          const r = runs(kids);
          return r.some((x) => x.text) ? [paragraph(r)] : [];
        }
        case 'heading':
          return [heading(Number(n.level) || 2, runs(kids))];
        case 'quote':
          return [{ type: 'blockquote', content: [paragraph(runs(kids))] }];
        case 'code':
          return [codeBlock(kids.map((k) => (isObj(k) ? (str(k.text) ?? '') : '')).join(''), str(n.language))];
        case 'list':
          return [list(n.format === 'ordered', kids.map((li) => (isObj(li) ? (arr(li.children).some((x) => isObj(x) && x.type === 'list') ? [paragraph(runs(arr(li.children).filter((x) => !isObj(x) || x.type !== 'list'))), ...blocks(arr(li.children).filter((x) => isObj(x) && x.type === 'list'))] : [paragraph(runs(arr(li.children)))]) : [])))];
        case 'image': {
          const img = isObj(n.image) ? n.image : {};
          const url = str(img.url);
          return url ? [image(imageOf(url, str(img.alternativeText)), str(img.alternativeText))] : [];
        }
        default:
          return [];
      }
    });
  return doc(blocks(value));
}
