/**
 * HTML and Markdown to a BlockDoc: the rich text of WordPress (HTML), Strapi 4
 * (Markdown) and anything an export carries as a string.
 *
 * Deliberately a small tolerant reader, not a browser: it understands the
 * structure a rich-text editor writes (paragraphs, headings, lists, quotes,
 * code, pictures, links, bold/italic/code/strike/underline) and turns the
 * rest into its text. A tag it does not know never loses its words, and a
 * `<script>` or `<style>` loses everything, because it is not content.
 */
import { codeBlock, doc, heading, image, list, paragraph, safeHref, type MarkName, type Run } from './richtext-core';
import type { DocNode, ImageResolver, RichDoc } from './types';

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

interface El {
  tag: string;
  attrs: Record<string, string>;
  children: (El | string)[];
}

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link', 'source', 'wbr']);
const SKIP = new Set(['script', 'style', 'head', 'template', 'noscript']);

function parse(html: string): El {
  const root: El = { tag: '#root', attrs: {}, children: [] };
  const stack: El[] = [root];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>|([^<]+|<)/g;
  for (let m: RegExpExecArray | null; (m = re.exec(html)); ) {
    const top = stack[stack.length - 1]!;
    if (m[4] !== undefined) {
      top.children.push(m[4]);
    } else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (m[1]) {
        const at = stack.map((e) => e.tag).lastIndexOf(tag);
        if (at > 0) stack.length = at;
      } else {
        const attrs: Record<string, string> = {};
        for (const a of (m[3] ?? '').matchAll(/([^\s=/]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
          attrs[a[1]!.toLowerCase()] = decodeEntities(a[2] ?? a[3] ?? a[4] ?? '');
        }
        const el: El = { tag, attrs, children: [] };
        top.children.push(el);
        // <p> and <li> close themselves when the next one opens, as in a browser.
        if (!VOID.has(tag) && !/\/\s*$/.test(m[3] ?? '')) stack.push(el);
        if (SKIP.has(tag)) {
          const end = html.toLowerCase().indexOf(`</${tag}`, re.lastIndex);
          if (end >= 0) re.lastIndex = html.indexOf('>', end) + 1 || html.length;
        }
      }
    }
  }
  return root;
}

const MARKS: Record<string, MarkName> = { strong: 'bold', b: 'bold', em: 'italic', i: 'italic', code: 'code', s: 'strike', del: 'strike', strike: 'strike', u: 'underline' };

interface Ctx {
  image: ImageResolver;
  blocks: DocNode[];
}

function inline(el: El | string, marks: MarkName[], href: string | undefined, out: Run[], ctx: Ctx): void {
  if (typeof el === 'string') {
    out.push({ text: decodeEntities(el).replace(/\s+/g, ' '), marks, href });
    return;
  }
  if (SKIP.has(el.tag)) return;
  if (el.tag === 'br') return void out.push({ text: '\n', marks: [] });
  if (el.tag === 'img') {
    // A picture in the middle of a line closes the line: a block model has no inline images.
    flush(out, ctx);
    if (el.attrs.src) ctx.blocks.push(image(ctx.image(el.attrs.src, el.attrs.alt), el.attrs.alt));
    return;
  }
  const mark = MARKS[el.tag];
  const next = mark && !marks.includes(mark) ? [...marks, mark] : marks;
  const link = el.tag === 'a' ? (safeHref(el.attrs.href) ?? href) : href;
  for (const c of el.children) inline(c, next, link, out, ctx);
}

function flush(runs: Run[], ctx: Ctx): void {
  if (!runs.length) return;
  // Collapse the whitespace a source indents with, but keep the single space between words.
  const trimmed = runs.map((r) => ({ ...r }));
  while (trimmed.length && trimmed[0]!.text !== '\n' && !trimmed[0]!.text.trim()) trimmed.shift();
  while (trimmed.length && trimmed[trimmed.length - 1]!.text !== '\n' && !trimmed[trimmed.length - 1]!.text.trim()) trimmed.pop();
  if (trimmed.length) {
    trimmed[0]!.text = trimmed[0]!.text.replace(/^\s+/, '');
    trimmed[trimmed.length - 1]!.text = trimmed[trimmed.length - 1]!.text.replace(/\s+$/, '');
    if (trimmed.some((r) => r.text)) ctx.blocks.push(paragraph(trimmed));
  }
  runs.length = 0;
}

const INLINE_TAGS = new Set(['a', 'span', 'strong', 'b', 'em', 'i', 'code', 's', 'del', 'strike', 'u', 'small', 'mark', 'sub', 'sup', 'abbr', 'cite', 'font', 'label', 'br', 'img']);

function textOf(el: El | string): string {
  if (typeof el === 'string') return decodeEntities(el);
  if (SKIP.has(el.tag)) return '';
  return el.tag === 'br' ? '\n' : el.children.map(textOf).join('');
}

function blocksOf(children: (El | string)[], ctx: Ctx, into: DocNode[] = ctx.blocks): void {
  const outer = ctx.blocks;
  ctx.blocks = into;
  const run: Run[] = [];
  for (const c of children) {
    if (typeof c === 'string' || INLINE_TAGS.has(c.tag)) {
      inline(c, [], undefined, run, ctx);
      continue;
    }
    flush(run, ctx);
    block(c, ctx);
  }
  flush(run, ctx);
  ctx.blocks = outer;
}

function block(el: El, ctx: Ctx): void {
  if (SKIP.has(el.tag)) return;
  const lvl = /^h([1-6])$/.exec(el.tag);
  if (lvl) {
    const runs: Run[] = [];
    el.children.forEach((c) => inline(c, [], undefined, runs, ctx));
    const h = heading(Number(lvl[1]), runs);
    if (h.content?.length) ctx.blocks.push(h);
    return;
  }
  switch (el.tag) {
    case 'p': {
      const runs: Run[] = [];
      el.children.forEach((c) => inline(c, [], undefined, runs, ctx));
      flush(runs, ctx);
      return;
    }
    case 'ul':
    case 'ol': {
      const items = el.children.filter((c): c is El => typeof c !== 'string' && c.tag === 'li');
      if (!items.length) return;
      ctx.blocks.push(list(el.tag === 'ol', items.map((li) => { const into: DocNode[] = []; blocksOf(li.children, ctx, into); return into; })));
      return;
    }
    case 'blockquote': {
      const into: DocNode[] = [];
      blocksOf(el.children, ctx, into);
      if (into.length) ctx.blocks.push({ type: 'blockquote', content: into });
      return;
    }
    case 'pre': {
      const codeEl = el.children.find((c): c is El => typeof c !== 'string' && c.tag === 'code');
      const lang = /(?:language|lang)-([\w+#-]+)/.exec(codeEl?.attrs.class ?? el.attrs.class ?? '')?.[1];
      ctx.blocks.push(codeBlock(textOf(codeEl ?? el).replace(/\n$/, ''), lang));
      return;
    }
    case 'hr':
      ctx.blocks.push({ type: 'horizontalRule' });
      return;
    case 'img':
      if (el.attrs.src) ctx.blocks.push(image(ctx.image(el.attrs.src, el.attrs.alt), el.attrs.alt));
      return;
    case 'figure': {
      const img = el.children.find((c): c is El => typeof c !== 'string' && (c.tag === 'img' || (c.tag === 'a' && c.children.some((x) => typeof x !== 'string' && x.tag === 'img'))));
      const imgEl = img?.tag === 'a' ? (img.children.find((x): x is El => typeof x !== 'string' && x.tag === 'img') as El) : img;
      const cap = el.children.find((c): c is El => typeof c !== 'string' && c.tag === 'figcaption');
      if (imgEl?.attrs.src) {
        const caption = cap ? textOf(cap).trim() : '';
        const node = image(ctx.image(imgEl.attrs.src, imgEl.attrs.alt), imgEl.attrs.alt);
        if (caption) node.attrs!.caption = caption;
        ctx.blocks.push(node);
      } else blocksOf(el.children, ctx);
      return;
    }
    default:
      // div, section, table, figure parts…: keep the words, lose the wrapper.
      blocksOf(el.children, ctx);
  }
}

export function fromHtml(html: string, imageOf: ImageResolver): RichDoc {
  const ctx: Ctx = { image: imageOf, blocks: [] };
  blocksOf(parse(html).children, ctx);
  return doc(ctx.blocks);
}

/* ---------------------------- Markdown ---------------------------- */

function inlineMd(s: string, resolve: ImageResolver, blocks: DocNode[]): Run[] {
  const out: Run[] = [];
  const re = /(!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\))|(\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\))|(`+)([\s\S]*?[^`])\7(?!`)|(\*\*|__)(?=\S)([\s\S]*?\S)\9|(~~)(?=\S)([\s\S]*?\S)\11|(\*|_)(?=\S)([\s\S]*?\S)\13/g;
  let at = 0;
  const walk = (text: string, marks: MarkName[], href?: string) => {
    if (text) out.push({ text, marks, href });
  };
  for (let m: RegExpExecArray | null; (m = re.exec(s)); ) {
    walk(s.slice(at, m.index).replace(/\\([\\`*_{}[\]()#+\-.!~])/g, '$1'), []);
    at = m.index + m[0].length;
    if (m[1]) {
      blocks.push(image(resolve(m[3]!, m[2]), m[2] || undefined));
    } else if (m[4]) {
      const inner = inlineMd(m[5]!, resolve, blocks);
      const href = safeHref(m[6]);
      for (const r of inner) out.push({ ...r, href: href ?? r.href });
    } else if (m[7]) walk(m[8]!, ['code']);
    else if (m[9]) for (const r of inlineMd(m[10]!, resolve, blocks)) out.push({ ...r, marks: [...r.marks, 'bold'] });
    else if (m[11]) for (const r of inlineMd(m[12]!, resolve, blocks)) out.push({ ...r, marks: [...r.marks, 'strike'] });
    else if (m[13]) for (const r of inlineMd(m[14]!, resolve, blocks)) out.push({ ...r, marks: [...r.marks, 'italic'] });
  }
  walk(s.slice(at).replace(/\\([\\`*_{}[\]()#+\-.!~])/g, '$1'), []);
  return out;
}

export function fromMarkdown(md: string, imageOf: ImageResolver): RichDoc {
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  const blocks: DocNode[] = [];
  const parseBlocks = (ls: string[], into: DocNode[]) => {
    for (let i = 0; i < ls.length; ) {
      const line = ls[i]!;
      if (!line.trim()) { i++; continue; }
      const fence = /^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/.exec(line);
      if (fence) {
        const body: string[] = [];
        for (i++; i < ls.length && !ls[i]!.trimStart().startsWith(fence[1]!); i++) body.push(ls[i]!);
        i++;
        into.push(codeBlock(body.join('\n'), fence[2]));
        continue;
      }
      const h = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
      if (h) {
        const extra: DocNode[] = [];
        into.push(heading(h[1]!.length, inlineMd(h[2]!, imageOf, extra)), ...extra);
        i++;
        continue;
      }
      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { into.push({ type: 'horizontalRule' }); i++; continue; }
      if (/^\s*>/.test(line)) {
        const body: string[] = [];
        for (; i < ls.length && /^\s*>/.test(ls[i]!); i++) body.push(ls[i]!.replace(/^\s*>\s?/, ''));
        const inner: DocNode[] = [];
        parseBlocks(body, inner);
        into.push({ type: 'blockquote', content: inner });
        continue;
      }
      const li = /^(\s*)([-*+]|\d+[.)])\s+/.exec(line);
      if (li) {
        const ordered = /\d/.test(li[2]!);
        const indent = li[1]!.length;
        const items: string[][] = [];
        for (; i < ls.length; i++) {
          const l = ls[i]!;
          const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(l);
          if (m && m[1]!.length === indent && /\d/.test(m[2]!) === ordered) items.push([m[3]!]);
          else if (m && m[1]!.length > indent && items.length) items[items.length - 1]!.push(l.slice(indent + 2));
          else if (l.trim() && /^\s+/.test(l) && items.length) items[items.length - 1]!.push(l.trim());
          else break;
        }
        into.push(list(ordered, items.map((item) => { const inner: DocNode[] = []; parseBlocks(item, inner); return inner; })));
        continue;
      }
      const para: string[] = [];
      for (; i < ls.length && ls[i]!.trim() && !/^\s*(#{1,6}\s|>|`{3}|~{3}|([-*+]|\d+[.)])\s)/.test(ls[i]!); i++) para.push(ls[i]!.trim());
      const extra: DocNode[] = [];
      const runs: Run[] = [];
      para.forEach((p, k) => { if (k) runs.push({ text: ' ', marks: [] }); runs.push(...inlineMd(p, imageOf, extra)); });
      if (runs.some((r) => r.text.trim())) into.push(paragraph(runs));
      into.push(...extra);
    }
  };
  parseBlocks(lines, blocks);
  return doc(blocks);
}
