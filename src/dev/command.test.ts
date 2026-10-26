import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { markdownFiles, previewPage, runDev, themeOf } from './command';

describe('forumulate dev (DOCS #244)', () => {
  it('lists the folder’s Markdown, skipping dot folders and node_modules', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fm-dev-'));
    mkdirSync(path.join(dir, 'guides'));
    mkdirSync(path.join(dir, 'node_modules'));
    writeFileSync(path.join(dir, 'index.md'), '# Home');
    writeFileSync(path.join(dir, 'guides', 'a.mdx'), '# A');
    writeFileSync(path.join(dir, 'node_modules', 'x.md'), '# no');
    writeFileSync(path.join(dir, 'notes.txt'), 'no');
    expect(markdownFiles(dir)).toEqual(['guides/a.mdx', 'index.md']);
  });

  it('borrows the published look and escapes file names', () => {
    const theme = themeOf(
      '<link rel="stylesheet" href="/_next/a.css"><style>:root{--x:1}</style>',
      'https://docs.example.com/guides',
    );
    expect(theme).toContain('href="https://docs.example.com/_next/a.css"');
    expect(theme).toContain('--x:1');
    const html = previewPage({
      title: 't',
      body: '<p>b</p>',
      files: ['<x>.md'],
      current: null,
      theme: '',
    });
    expect(html).toContain('&lt;x&gt;.md');
    expect(html).toContain("EventSource('/__forumulate/live')");
  });

  it('serves pages rendered by the API, and only files in the folder', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'fm-dev-'));
    writeFileSync(path.join(dir, 'index.md'), '---\ntitle: Home\n---\nHello');
    const calls: unknown[] = [];
    const client = {
      request: async (_m: string, _p: string, o: { body: unknown }) => {
        calls.push(o.body);
        return { title: null, html: '<p>Hello</p>' };
      },
    };
    let close = () => {};
    const port = 45000 + Math.floor(Math.random() * 1000);
    await runDev(
      { folder: dir, org: 'o', space: 's', port },
      { client: client as never, out: () => {}, err: () => {}, onListening: (c) => (close = c) },
    );
    try {
      const home = await (await fetch(`http://127.0.0.1:${port}/`)).text();
      expect(home).toContain('<h1>Home</h1><p>Hello</p>');
      expect(calls).toEqual([{ markdown: 'Hello' }]);
      expect((await fetch(`http://127.0.0.1:${port}/../../etc/passwd`)).status).toBe(404);
    } finally {
      close();
    }
  });
});
