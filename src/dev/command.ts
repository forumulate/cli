import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readdirSync, readFileSync, statSync, watch } from 'node:fs';
import path from 'node:path';
import type { ForumulateClient } from '@forumulate/sdk';
import { splitFront } from '../publish/frontmatter';

/**
 * `forumulate dev <folder> --space <spaceId> [--org <orgId>] [--port 4321] [--site <url>]`
 * — a local preview of a docs folder, reloading as you save (Mintlify's
 * `mint dev`, Docusaurus's `start`; DOCS #244).
 *
 * Every page is rendered by the API's own renderer (`POST …/docs/render`),
 * not by a second one shipped in the CLI, so what you see is what readers
 * will get. `--site` (your published docs address) lends the preview its
 * look: the stylesheets that page links and the theme it inlines are copied
 * once into each preview page. Nothing is written anywhere.
 */
export interface DevOptions {
  folder: string;
  org?: string;
  space?: string;
  port: number;
  site?: string;
}

export interface DevDeps {
  client: ForumulateClient;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Injected so tests can stop it; production keeps the process alive. */
  onListening?: (close: () => void) => void;
}

const PAGE = /\.(md|mdx|markdown)$/i;

/** Every Markdown file under the folder, as `/`-separated relative paths, sorted. */
export function markdownFiles(folder: string, dir = ''): string[] {
  const out: string[] = [];
  for (const name of readdirSync(path.join(folder, dir))) {
    if (name.startsWith('.') || name === 'node_modules') continue;
    const rel = dir ? `${dir}/${name}` : name;
    if (statSync(path.join(folder, rel)).isDirectory()) out.push(...markdownFiles(folder, rel));
    else if (PAGE.test(name)) out.push(rel);
  }
  return out.sort();
}

/** The stylesheet links and inline theme of a published page, to dress the preview in. */
export function themeOf(html: string, site: string): string {
  const links = [...html.matchAll(/<link[^>]+rel="stylesheet"[^>]*>/gi)].map((m) =>
    m[0].replace(/href="(\/[^"]*)"/, (_x, href: string) => `href="${new URL(href, site).href}"`),
  );
  const styles = [...html.matchAll(/<style[^>]*>[\s\S]*?<\/style>/gi)].map((m) => m[0]);
  return [...links, ...styles].join('\n');
}

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** One preview document: the nav of files, the rendered body, and the reload hook. */
export function previewPage(opts: {
  title: string;
  heading?: string | null;
  body: string;
  files: string[];
  current: string | null;
  theme: string;
}): string {
  const nav = opts.files
    .map(
      (f) =>
        `<li><a href="/${esc(f)}"${f === opts.current ? ' aria-current="page" style="font-weight:600"' : ''}>${esc(f)}</a></li>`,
    )
    .join('');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(opts.title)} · preview</title>${opts.theme}
<style>.fm-dev{display:flex;gap:2rem;max-width:72rem;margin:0 auto;padding:2rem 1rem}.fm-dev nav{flex:0 0 14rem;font:14px/1.6 system-ui,sans-serif}.fm-dev nav ul{list-style:none;padding:0;margin:0}.fm-dev main{flex:1;min-width:0}</style></head>
<body class="forumulate-reader"><div class="fm-dev"><nav aria-label="Files"><ul>${nav}</ul></nav><main><article class="forumulate-prose">${opts.heading ? `<h1>${esc(opts.heading)}</h1>` : ''}${opts.body}</article></main></div>
<script>new EventSource('/__forumulate/live').onmessage=function(){location.reload()};</script></body></html>`;
}

export async function runDev(opts: DevOptions, deps: DevDeps): Promise<number> {
  if (!opts.space || !opts.org) {
    deps.err(
      'dev needs --org <orgId> and --space <spaceId> (the space whose renderer previews it).',
    );
    return 2;
  }
  const folder = path.resolve(opts.folder);
  let theme = '';
  if (opts.site) {
    try {
      theme = themeOf(await (await fetch(opts.site)).text(), opts.site);
    } catch {
      deps.err(`Could not read ${opts.site}; the preview will be unstyled.`);
    }
  }
  const clients = new Set<ServerResponse>();
  const render = async (
    rel: string,
  ): Promise<{ title: string; heading: string | null; html: string }> => {
    const { data, body } = splitFront(readFileSync(path.join(folder, rel), 'utf8'));
    const r = await deps.client.request<{ title: string | null; html: string }>(
      'POST',
      `/orgs/${opts.org}/spaces/${opts.space}/docs/render`,
      { body: { markdown: body } },
    );
    const declared = typeof data.title === 'string' ? data.title : null;
    // A body that opens with its own `# Title` already carries it; a front-matter
    // title is drawn as the heading only when the body has none.
    return {
      title: declared ?? r.title ?? rel,
      heading: declared && !r.title ? declared : null,
      html: r.html,
    };
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = decodeURIComponent((req.url ?? '/').split('?')[0]!);
      if (url === '/__forumulate/live') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          connection: 'keep-alive',
        });
        res.write(': live\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }
      const files = markdownFiles(folder);
      const rel =
        url === '/'
          ? (files.find((f) => /(^|\/)(index|readme)\.mdx?$/i.test(f)) ?? files[0] ?? null)
          : url.slice(1);
      // Only a file the listing holds — never a path that climbs out of the folder.
      if (!rel || !files.includes(rel)) {
        res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          previewPage({
            title: 'Not found',
            body: '<p>No such page in this folder.</p>',
            files,
            current: null,
            theme,
          }),
        );
        return;
      }
      try {
        const page = await render(rel);
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
        });
        res.end(
          previewPage({
            title: page.title,
            heading: page.heading,
            body: page.html,
            files,
            current: rel,
            theme,
          }),
        );
      } catch (e) {
        res.writeHead(502, { 'content-type': 'text/html; charset=utf-8' });
        res.end(
          previewPage({
            title: 'Could not render',
            body: `<pre>${esc(String((e as Error).message ?? e))}</pre>`,
            files,
            current: rel,
            theme,
          }),
        );
      }
    })();
  });
  // Saved a file: every open preview reloads (a burst of writes is one reload).
  let timer: NodeJS.Timeout | null = null;
  const watcher = watch(folder, { recursive: true }, (_e, name) => {
    if (!name || !PAGE.test(String(name))) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      for (const c of clients) c.write('data: reload\n\n');
    }, 120);
  });
  await new Promise<void>((resolve) => server.listen(opts.port, '127.0.0.1', resolve));
  deps.out(`Previewing ${folder} at http://127.0.0.1:${opts.port}/ — Ctrl+C to stop.`);
  const close = () => {
    watcher.close();
    for (const c of clients) c.end();
    server.close();
  };
  if (deps.onListening) {
    deps.onListening(close);
    return 0;
  }
  await new Promise<void>((resolve) => server.on('close', resolve));
  return 0;
}
