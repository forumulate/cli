import type { ApiClient } from '../publish/client';
import { slugify } from '../publish/names';

/**
 * A small, STATEFUL stand-in for the API, for the folder sync tests.
 *
 * The other publish tests answer every read with the same fixture, so they can
 * say what one run would write and nothing about the run after it. Content as
 * code lives or dies on the second run — "a re-run is a no-op" — and that can
 * only be shown against something that remembers the first. This keeps the
 * pieces each door writes (posts, releases, pages, slots, metadata, tag
 * displays, assets) and answers the reads the publisher makes from them, in
 * the shapes the real routes answer.
 */

type Json = Record<string, unknown>;

interface Post {
  id: string;
  kind: 'ARTICLE' | 'RELEASE';
  slug: string;
  title: string;
  markdown: string;
  published: boolean;
  extras: Json;
  deleted?: boolean;
}

interface Page {
  id: string;
  slug: string;
  title: string;
  collectionId: string;
  parentId: string | null;
  markdown: string;
  sections: Record<string, string>;
  meta: Json;
  published: boolean;
  deleted?: boolean;
}

interface Space {
  id: string;
  slug: string;
  type: string;
  backing: 'page' | 'topic';
  slots: { key: string; label: string; kind?: string; render?: string }[];
  params: { key: string }[];
  collections: { id: string; slug: string; name: string; isDefault: boolean; sortKey: string }[];
  pages: Page[];
  posts: Post[];
  assets: { filename: string; url: string }[];
  tags: Map<string, Json>;
}

export interface FakeContentApi {
  client: ApiClient;
  upload: (path: string, form: FormData) => Promise<unknown>;
  /** Mutating calls the publisher made (the importer's own dry run is not one). */
  writes: string[];
  uploads: string[];
  space: (slug: string) => Space;
  reset: () => void;
}

const FRONT = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;
/** The product's own slug rule (the CLI's mirror of it), as the real API would apply. */
const slugOf = (s: string) => slugify(s);

/** What the importer stores of a file: its title, its address and the body without either. */
function imported(name: string, content: string): { slug: string; title: string; body: string } {
  const m = FRONT.exec(content);
  const fm = m?.[1] ?? '';
  let body = m ? content.slice(m[0].length) : content;
  const field = (k: string) => new RegExp(`^${k}:\\s*["']?(.*?)["']?\\s*$`, 'm').exec(fm)?.[1];
  const h1 = /^\s*#\s+(.+?)\s*\n/.exec(body);
  const title = field('title') ?? h1?.[1] ?? name;
  if (h1) body = body.slice(h1[0].length);
  const stem = name.split('/').pop()!.replace(/\.(md|mdx|markdown)$/i, '');
  return { slug: field('slug') ?? slugOf(stem), title, body: body.trim() };
}

/** The page markdown door: `## <slot label>` starts a slot. */
function slotted(body: string, slots: Space['slots']): Record<string, string> {
  const out: Record<string, string> = {};
  let key: string | null = null;
  for (const line of body.split('\n')) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    const hit = h && slots.find((s) => s.label.toLowerCase() === h[1]!.toLowerCase());
    if (hit) {
      key = hit.key;
      out[key] = '';
    } else if (key) out[key] += `${line}\n`;
  }
  for (const k of Object.keys(out)) out[k] = out[k]!.trim();
  return out;
}

export function fakeContentApi(): FakeContentApi {
  let n = 0;
  const id = (p: string) => `${p}-${++n}`;
  const spaces = new Map<string, Space>();
  const writes: string[] = [];
  const uploads: string[] = [];

  const make = (slug: string, type: string, backing: 'page' | 'topic', extra: Partial<Space> = {}) =>
    spaces.set(slug, {
      id: slug,
      slug,
      type,
      backing,
      slots: [],
      params: [],
      collections:
        backing === 'page'
          ? [{ id: `${slug}-pages`, slug: 'pages', name: 'Pages', isDefault: true, sortKey: '0' }]
          : [],
      pages: [],
      posts: [],
      assets: [],
      tags: new Map(),
      ...extra,
    });
  const reset = () => {
    spaces.clear();
    make('blog', 'BLOG', 'topic');
    make('docs', 'DOCS', 'page', { params: [{ key: 'audience' }] });
    make('faq', 'FAQ', 'page', {
      slots: [
        { key: 'answer', label: 'Answer', kind: 'prose', render: 'plain' },
        { key: 'short-answer', label: 'The short answer', kind: 'prose', render: 'lede' },
        { key: 'related', label: 'If that was not it', kind: 'list' },
      ],
      params: [{ key: 'topic' }, { key: 'featured' }],
    });
    make('changelog', 'CHANGELOG', 'topic');
  };
  reset();

  const live = (s: Space) => s.pages.filter((p) => !p.deleted);
  const items = (s: Space) =>
    s.backing === 'page'
      ? live(s).map((p) => ({
          id: p.id,
          slug: p.slug,
          title: p.title,
          published: p.published,
          markdown: p.markdown,
          sections: p.sections,
        }))
      : s.posts
          .filter((p) => !p.deleted)
          .map((p) => ({
            id: p.id,
            slug: p.slug,
            title: p.title,
            published: p.published,
            markdown: p.markdown,
            sections: {},
          }));

  const handle = (method: string, path: string, body: Json): unknown => {
    if (method === 'GET' && path === '/orgs') return { orgs: [{ id: 'o1', slug: 'o1' }] };
    if (method === 'GET' && path === '/orgs/o1/spaces')
      return { spaces: [...spaces.values()].map((s) => ({ id: s.id, slug: s.slug, type: s.type })) };
    const st = /^\/space-types\/(\w+)$/.exec(path);
    if (st) return { spaceType: { backing: [...spaces.values()].find((s) => s.type === st[1])!.backing } };
    const m = /^\/orgs\/o1\/spaces\/([^/]+)(\/.*)?$/.exec(path);
    if (!m) throw Object.assign(new Error(`no fake for ${method} ${path}`), { status: 404 });
    const s = spaces.get(m[1]!)!;
    const rest = m[2] ?? '';
    const key = `${method} ${rest.replace(/[0-9a-z]+-\d+/g, ':id')}`;
    const pageOf = (pid: string) => s.pages.find((p) => p.id === pid)!;
    const postOf = (pid: string) => s.posts.find((p) => p.id === pid)!;
    const target = /\/([a-z]+-\d+)/.exec(rest)?.[1] ?? '';
    switch (key) {
      case 'GET /shape':
        return { shape: { sections: s.slots, params: s.params } };
      case 'GET /items':
        return { items: items(s) };
      case 'GET /assets':
        return { assets: s.assets };
      case 'GET /collections':
        return { collections: s.collections };
      case 'GET /pages':
        return {
          pages: live(s).map((p) => ({
            id: p.id,
            slug: p.slug,
            title: p.title,
            collectionId: p.collectionId,
            parentId: p.parentId,
            sortKey: '',
            status: p.published ? 'published' : 'draft',
          })),
        };
      case 'GET /pages/:id/metadata':
        return { metadata: pageOf(target).meta };
      case 'PATCH /pages/:id/metadata': {
        const p = pageOf(target);
        p.meta = { ...p.meta, ...body };
        return { metadata: p.meta };
      }
      case 'POST /collections': {
        const c = { id: id('col'), slug: String(body.slug), name: String(body.name), isDefault: false, sortKey: '' };
        s.collections.push(c);
        return { collection: c };
      }
      case 'POST /collections/reorder': {
        const ids = body.ids as string[];
        s.collections.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
        return {};
      }
      case 'POST /collections/:id/order': {
        const ids = body.pageIds as string[];
        s.pages.sort((a, b) => {
          const ia = ids.indexOf(a.id);
          const ib = ids.indexOf(b.id);
          return ia < 0 || ib < 0 ? 0 : ia - ib;
        });
        return {};
      }
      case 'POST /docs/import': {
        if (body.dryRun) return { created: 0, replaced: 0, failed: 0 };
        for (const f of body.files as { name: string; content: string }[]) {
          const got = imported(f.name, f.content);
          const had = live(s).find((p) => p.slug === got.slug);
          if (had) Object.assign(had, { title: got.title, markdown: got.body, sections: {}, published: true });
          else
            s.pages.push({
              id: id('page'),
              slug: got.slug,
              title: got.title,
              collectionId: String(body.collectionId),
              parentId: null,
              markdown: got.body,
              sections: {},
              meta: {},
              published: true,
            });
        }
        return { created: 1, replaced: 0, failed: 0 };
      }
      case 'PUT /pages/:id/content': {
        const p = pageOf(target);
        p.markdown = String(body.body);
        p.sections = slotted(String(body.body), s.slots);
        if (body.title) p.title = String(body.title);
        p.published = false;
        return { revision: {} };
      }
      case 'POST /pages/:id/publish':
        pageOf(target).published = true;
        return { revision: {} };
      case 'POST /pages/bulk-delete':
        for (const pid of body.ids as string[]) pageOf(pid).deleted = true;
        return {};
      case 'POST /blog':
      case 'POST /changelog': {
        const release = rest === '/changelog';
        const { title, slug, markdown, ...extras } = body;
        const p: Post = {
          id: id(release ? 'rel' : 'art'),
          kind: release ? 'RELEASE' : 'ARTICLE',
          slug: release ? slugOf(String(title)) : String(slug),
          title: String(title),
          markdown: String(markdown ?? ''),
          published: false,
          extras,
        };
        s.posts.push(p);
        return release ? { release: { id: p.id } } : { article: { id: p.id } };
      }
      case 'POST /blog/:id/publish':
      case 'POST /changelog/:id/publish':
        postOf(target).published = true;
        return {};
      case 'GET /blog/:id':
      case 'GET /changelog/:id': {
        const p = postOf(target);
        const row = {
          ...p.extras,
          tags: ((p.extras.tags as string[]) ?? []).map((t) => ({ name: t.toLowerCase() })),
          byline: p.extras.author ? { name: p.extras.author } : null,
        };
        return p.kind === 'RELEASE' ? { release: row } : { article: row };
      }
      case 'PATCH /blog/:id':
      case 'PATCH /changelog/:id': {
        const p = postOf(target);
        const { title, markdown, ...extras } = body;
        if (title !== undefined) p.title = String(title);
        if (markdown !== undefined) p.markdown = String(markdown);
        p.extras = { ...p.extras, ...extras };
        return {};
      }
      case 'DELETE /items/:id':
        postOf(target).deleted = true;
        return {};
      case 'GET /blog/tag-info':
        return {
          tags: [...s.tags].map(([slug, d]) => ({ slug, label: slug, color: null, ...d })),
        };
    }
    const tag = /^\/blog\/tags\/([^/]+)$/.exec(rest);
    if (tag && method === 'PUT') {
      const slug = decodeURIComponent(tag[1]!);
      const was = s.tags.get(slug) ?? {};
      const next = { ...was, ...body };
      for (const k of ['color', 'textColor']) if (typeof next[k] === 'string') next[k] = String(next[k]).toLowerCase();
      s.tags.set(slug, next);
      return { tag: { slug, ...next } };
    }
    if (tag && method === 'DELETE') {
      s.tags.delete(decodeURIComponent(tag[1]!));
      return { ok: true };
    }
    throw Object.assign(new Error(`no fake for ${method} ${path}`), { status: 404 });
  };

  const client: ApiClient = {
    request: async <T>(method: string, path: string, opts: { body?: unknown } = {}) => {
      const body = (opts.body ?? {}) as Json;
      if (method !== 'GET' && !(path.endsWith('/docs/import') && body.dryRun))
        writes.push(`${method} ${path.replace('/orgs/o1/spaces', '')}`);
      return handle(method, path, body) as T;
    },
  };

  const upload = async (path: string, form: FormData) => {
    const file = form.get('file') as File;
    const s = spaces.get(/spaces\/([^/]+)\/assets/.exec(path)![1]!)!;
    const asset = { filename: file.name, url: `https://cdn.test/${s.slug}/${file.name}` };
    s.assets.push(asset);
    uploads.push(file.name);
    return { asset };
  };

  return { client, upload, writes, uploads, space: (slug) => spaces.get(slug)!, reset };
}
