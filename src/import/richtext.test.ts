import { describe, expect, it } from 'vitest';
import { fromHtml, fromMarkdown } from './richtext-html';
import { fromContentful, fromLexical, fromPortableText, fromStrapiBlocks } from './richtext-json';
import type { DocNode } from './types';

const keep = (src: string) => src;
const text = (n: DocNode): string => n.text ?? (n.content ?? []).map(text).join('');

describe('HTML to a block document', () => {
  it('keeps structure, marks and links, and drops scripts and comments', () => {
    const d = fromHtml(
      '<!-- c --><h2>Title</h2><p>Hi <strong>there</strong> <a href="https://a.test">link</a><script>alert(1)</script></p><ul><li>one</li><li>two <em>x</em></li></ul>',
      keep,
    );
    expect(d.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList']);
    expect(d.content[0]!.attrs).toEqual({ level: 2 });
    const p = d.content[1]!.content!;
    expect(p.map((n) => n.text)).toEqual(['Hi ', 'there', ' ', 'link']);
    expect(p[1]!.marks).toEqual([{ type: 'bold' }]);
    expect(p[3]!.marks).toEqual([{ type: 'link', attrs: { href: 'https://a.test' } }]);
    expect(JSON.stringify(d)).not.toContain('alert');
  });

  it('refuses javascript: links but keeps the words', () => {
    const d = fromHtml('<p><a href="javascript:alert(1)">click</a></p>', keep);
    expect(d.content[0]!.content![0]).toEqual({ type: 'text', text: 'click' });
  });

  it('turns figures, images and code into blocks and sends picture urls through the resolver', () => {
    const d = fromHtml(
      '<figure><img src="/a.png" alt="A"><figcaption>Cap</figcaption></figure><pre><code class="language-ts">let a</code></pre><p>x<img src="/b.png">y</p>',
      (src) => `https://cdn.test${src}`,
    );
    expect(d.content[0]).toMatchObject({ type: 'image', attrs: { src: 'https://cdn.test/a.png', alt: 'A', caption: 'Cap' } });
    expect(d.content[1]).toMatchObject({ type: 'codeBlock', attrs: { language: 'ts' } });
    expect(d.content.filter((n) => n.type === 'image')).toHaveLength(2);
  });

  it('never returns an empty document and decodes entities', () => {
    expect(fromHtml('', keep).content).toEqual([{ type: 'paragraph' }]);
    expect(text(fromHtml('<p>a &amp; b &#169;</p>', keep).content[0]!)).toBe('a & b ©');
  });
});

describe('Markdown to a block document', () => {
  it('reads headings, lists, quotes, fences, emphasis and links', () => {
    const d = fromMarkdown('# H\n\nText **b** *i* `c` [l](https://x.test)\n\n- a\n- b\n\n1. one\n\n> q\n\n```js\nlet a\n```\n', keep);
    expect(d.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'orderedList', 'blockquote', 'codeBlock']);
    const p = d.content[1]!.content!;
    expect(p.map((n) => n.marks?.[0]?.type)).toEqual([undefined, 'bold', undefined, 'italic', undefined, 'code', undefined, 'link']);
  });
});

describe('structured sources', () => {
  it('Lexical: format bits, links, lists, uploads', () => {
    const d = fromLexical(
      { root: { children: [
        { type: 'paragraph', children: [{ type: 'text', text: 'a', format: 3 }, { type: 'link', fields: { url: 'https://l.test' }, children: [{ type: 'text', text: 'b' }] }] },
        { type: 'list', listType: 'number', children: [{ type: 'listitem', children: [{ type: 'text', text: 'x' }] }] },
        { type: 'upload', value: { id: 1, url: '/m.png', alt: 'M' } },
      ] } },
      keep,
    )!;
    expect(d.content[0]!.content![0]!.marks).toEqual([{ type: 'bold' }, { type: 'italic' }]);
    expect(d.content[0]!.content![1]!.marks).toEqual([{ type: 'link', attrs: { href: 'https://l.test' } }]);
    expect(d.content[1]!.type).toBe('orderedList');
    expect(d.content[2]).toMatchObject({ type: 'image', attrs: { src: '/m.png' } });
    expect(fromLexical('nope', keep)).toBeNull();
  });

  it('Portable Text: styles, marks, nested lists, images, code', () => {
    const d = fromPortableText(
      [
        { _type: 'block', style: 'h3', children: [{ _type: 'span', text: 'H', marks: [] }] },
        { _type: 'block', style: 'normal', children: [{ _type: 'span', text: 'x', marks: ['strong', 'k'] }], markDefs: [{ _key: 'k', _type: 'link', href: 'https://p.test' }] },
        { _type: 'block', listItem: 'bullet', level: 1, children: [{ _type: 'span', text: 'a', marks: [] }] },
        { _type: 'block', listItem: 'bullet', level: 2, children: [{ _type: 'span', text: 'b', marks: [] }] },
        { _type: 'block', listItem: 'bullet', level: 1, children: [{ _type: 'span', text: 'c', marks: [] }] },
        { _type: 'image', asset: { _ref: 'image-1' } },
        { _type: 'code', language: 'js', code: 'x' },
      ],
      keep,
      (ref) => `https://cdn/${ref}`,
    )!;
    expect(d.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'bulletList', 'image', 'codeBlock']);
    expect(d.content[1]!.content![0]!.marks!.map((m) => m.type)).toEqual(['bold', 'link']);
    const list = d.content[2]!;
    expect(list.content).toHaveLength(2);
    expect(list.content![0]!.content!.map((n) => n.type)).toEqual(['paragraph', 'bulletList']);
    expect(d.content[3]!.attrs!.src).toBe('https://cdn/image-1');
  });

  it('Contentful: headings, marks, hyperlinks, lists, embedded assets', () => {
    const d = fromContentful(
      { nodeType: 'document', content: [
        { nodeType: 'heading-1', content: [{ nodeType: 'text', value: 'T', marks: [] }] },
        { nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'b', marks: [{ type: 'bold' }] }, { nodeType: 'hyperlink', data: { uri: 'https://c.test' }, content: [{ nodeType: 'text', value: 'l', marks: [] }] }] },
        { nodeType: 'ordered-list', content: [{ nodeType: 'list-item', content: [{ nodeType: 'paragraph', content: [{ nodeType: 'text', value: 'i', marks: [] }] }] }] },
        { nodeType: 'embedded-asset-block', data: { target: { sys: { id: 'a1' } } }, content: [] },
        { nodeType: 'embedded-asset-block', data: { target: { sys: { id: 'gone' } } }, content: [] },
      ] },
      keep,
      (id) => (id === 'a1' ? { url: 'https://img/a1.png', alt: 'A' } : null),
    )!;
    expect(d.content.map((n) => n.type)).toEqual(['heading', 'paragraph', 'orderedList', 'image']);
    expect(d.content[3]!.attrs).toEqual({ src: 'https://img/a1.png', alt: 'A' });
  });

  it('Strapi blocks: marks, links, ordered lists, code, images', () => {
    const d = fromStrapiBlocks(
      [
        { type: 'paragraph', children: [{ type: 'text', text: 'p', bold: true }, { type: 'link', url: 'https://s.test', children: [{ type: 'text', text: 'l' }] }] },
        { type: 'list', format: 'ordered', children: [{ type: 'list-item', children: [{ type: 'text', text: 'x' }] }] },
        { type: 'code', language: 'ts', children: [{ type: 'text', text: 'a' }] },
        { type: 'image', image: { url: '/u.png', alternativeText: 'U' } },
      ],
      keep,
    )!;
    expect(d.content.map((n) => n.type)).toEqual(['paragraph', 'orderedList', 'codeBlock', 'image']);
    expect(d.content[0]!.content![1]!.marks).toEqual([{ type: 'link', attrs: { href: 'https://s.test' } }]);
  });
});
