import { cpSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { run, type RunDeps } from '../run';
import { fakeContentApi, type FakeContentApi } from '../testing/fake-content-api';
import { ignoreMatcher, reservedReason } from './reserved';

/**
 * `forumulate sync <dir>` against a fixture repository with a blog, a docs
 * space, an FAQ and a changelog (`__fixtures__/sync`), and an API that
 * remembers what it was sent — so the second run is tested against the first.
 */
const FIXTURE = join(__dirname, '__fixtures__', 'sync');

let api: FakeContentApi;
let dir: string;

beforeEach(() => {
  api = fakeContentApi();
  dir = mkdtempSync(join(tmpdir(), 'fsync-'));
  cpSync(FIXTURE, dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function sync(...flags: string[]): Promise<{ code: number; out: string }> {
  const lines: string[] = [];
  const deps: RunDeps = {
    client: api.client as never,
    upload: api.upload,
    sleep: async () => {},
    out: (l) => lines.push(l),
    err: (l) => lines.push(l),
  };
  const code = await run(['sync', dir, '--pace', '0', ...flags], deps);
  return { code, out: lines.join('\n') };
}

describe('forumulate sync: the plan', () => {
  it('plans by default and writes nothing', async () => {
    const { code, out } = await sync();
    expect(code).toBe(0);
    expect(out).toContain('create  post launch');
    expect(out).toContain('create  post second-post');
    expect(out).toContain('create  page intro');
    expect(out).toContain('create  collection guides');
    expect(out).toContain('create  page refunds   ← billing/refunds.md  (short-answer, answer)');
    expect(out).toContain('create  post 2-4-0');
    expect(out).toContain('create  tag releases');
    expect(out).toContain('create  tag guides');
    expect(out).toContain('Run again with --apply');
    // Two files with the same bytes are one upload, named once in the plan.
    expect(out.match(/new content — uploaded by a real run/g)).toHaveLength(1);
    expect(api.writes).toEqual([]);
    expect(api.uploads).toEqual([]);
  });

  it('refuses --dry-run with --apply rather than guessing', async () => {
    const { code, out } = await sync('--dry-run', '--apply');
    // FMU-D05: contradictory flags are a usage error, exit 2.
    expect(code).toBe(2);
    expect(out).toContain('contradict');
  });
});

describe('forumulate sync --apply', () => {
  it('creates every piece, then reads it back clean', async () => {
    const { code, out } = await sync('--apply');
    expect(out).toContain('everything matches');
    expect(code).toBe(0);

    const blog = api.space('blog');
    expect(blog.posts.map((p) => p.slug).sort()).toEqual(['launch', 'second-post']);
    const launch = blog.posts.find((p) => p.slug === 'launch')!;
    expect(launch.published).toBe(true);
    expect(launch.extras).toMatchObject({
      tags: ['releases', 'guides'],
      excerpt: 'The short version of a long year.',
      author: 'Jane Okafor',
      featured: true,
      publishedAt: '2026-10-01T00:00:00.000Z',
    });
    // The cover and the image in the body are rewritten to the uploaded asset.
    expect(String(launch.extras.coverUrl)).toMatch(/^https:\/\/cdn\.test\/blog\/[0-9a-f]{12}-cover\.png$/);
    expect(launch.markdown).toContain(`](${String(launch.extras.coverUrl)})`);

    expect(blog.tags.get('releases')).toMatchObject({
      label: 'Releases',
      color: '#0a7f5a',
      description: 'Every release, in order',
      coverUrl: launch.extras.coverUrl,
    });
    expect(blog.tags.get('guides')).toMatchObject({ label: 'Guides', icon: 'book-open', color: 'teal' });

    const docs = api.space('docs');
    expect(docs.pages.map((p) => p.slug).sort()).toEqual(['install', 'intro']);
    const intro = docs.pages.find((p) => p.slug === 'intro')!;
    expect(intro.meta).toMatchObject({ seoDescription: 'Start here.', icon: 'rocket', fields: { audience: 'Everyone' } });
    expect(docs.collections.map((c) => c.slug)).toEqual(['pages', 'guides']);

    const refunds = api.space('faq').pages.find((p) => p.slug === 'refunds')!;
    expect(refunds.published).toBe(true);
    expect(refunds.sections).toEqual({
      answer: 'Email support within 30 days of paying and the money is back on your card within a week.',
      'short-answer': 'Yes, within 30 days.',
    });
    expect(refunds.meta).toMatchObject({ fields: { topic: 'Billing', featured: true } });

    const release = api.space('changelog').posts[0]!;
    expect(release).toMatchObject({ title: 'Faster search', published: true });
    expect(release.extras).toMatchObject({ version: '2.4.0' });
  });

  it('is a no-op the second time: no writes, no uploads', async () => {
    expect((await sync('--apply')).code).toBe(0);
    api.writes.length = 0;
    api.uploads.length = 0;
    const again = await sync('--apply');
    expect(again.code).toBe(0);
    expect(again.out).toContain('Nothing to change');
    expect(api.writes).toEqual([]);
    expect(api.uploads).toEqual([]);
  });
});

describe('media, by content hash', () => {
  it('uploads identical bytes once, whatever they are called', async () => {
    await sync('--apply');
    // cover.png (twice: cover + body, and as a tag cover) and same-bytes.png: one file.
    expect(api.uploads).toHaveLength(1);
    const second = api.space('blog').posts.find((p) => p.slug === 'second-post')!;
    const launch = api.space('blog').posts.find((p) => p.slug === 'launch')!;
    expect(second.markdown).toContain(String(launch.extras.coverUrl));
  });

  it('re-uploads nothing after a rename, and a changed picture once', async () => {
    await sync('--apply');
    api.uploads.length = 0;
    renameSync(join(dir, 'blog/img/same-bytes.png'), join(dir, 'blog/img/renamed.png'));
    const post = join(dir, 'blog/2026-10-05-second-post.md');
    writeFileSync(post, readFileSync(post, 'utf8').replace('same-bytes.png', 'renamed.png'));
    const renamed = await sync('--apply');
    expect(renamed.code).toBe(0);
    expect(api.uploads).toEqual([]);
    expect(renamed.out).toContain('Nothing to change');

    writeFileSync(join(dir, 'blog/img/renamed.png'), 'PNG-new-bytes');
    const changed = await sync('--apply');
    expect(changed.code).toBe(0);
    expect(api.uploads).toHaveLength(1);
    expect(changed.out).toContain('update  post second-post');
  });
});

describe('reserved names (R-N11)', () => {
  it('skips README, LICENSE, _drafts, dotfolders and ignore: globs, and says so', async () => {
    const { out } = await sync();
    expect(out).toMatch(/skip\s+README\.md\s+repository paperwork/);
    expect(out).toMatch(/skip\s+LICENSE\.md\s+repository paperwork/);
    expect(out).toMatch(/skip\s+_drafts\/\s+private folder/);
    expect(out).toMatch(/skip\s+notes\.wip\.md\s+ignore: in the manifest/);
    expect(out).not.toContain('.obsidian');
    await sync('--apply');
    const everything = [
      ...api.space('blog').posts.map((p) => p.title),
      ...api.space('docs').pages.map((p) => p.title),
    ];
    expect(everything.join('|')).not.toMatch(/repository|idea|Half a page|rights/i);
  });

  it('keeps README as a folder page in docs unless the space says skip', () => {
    expect(reservedReason('README.md', false, true)).toBeNull();
    expect(reservedReason('README.md', false, false)).toBe('repository paperwork');
    expect(reservedReason('CODE_OF_CONDUCT.md', false, true)).toBe('repository paperwork');
    expect(reservedReason('SUMMARY.md', false, true)).toBe('repository paperwork');
    expect(reservedReason('_drafts', true, true)).toBe('private folder');
    expect(reservedReason('changelog.md', false, true)).toBeNull();
    const ignored = ignoreMatcher(['*.wip.md', 'archive/**']);
    expect(ignored('notes.wip.md')).toBe(true);
    expect(ignored('deep/down/x.wip.md')).toBe(true);
    expect(ignored('archive/2019/old.md')).toBe(true);
    expect(ignored('guides/archive.md')).toBe(false);
  });
});

describe('drafts, prune and the diff', () => {
  it('never prunes a live post whose file became a draft; prunes one with no file', async () => {
    await sync('--apply');
    const launch = join(dir, 'blog/2026-10-01-launch.md');
    writeFileSync(launch, readFileSync(launch, 'utf8').replace('featured: true', 'featured: true\ndraft: true'));
    rmSync(join(dir, 'blog/2026-10-05-second-post.md'));
    const { code, out } = await sync('--apply', '--prune');
    expect(code).toBe(0);
    expect(out).toContain('prune   post second-post');
    expect(out).not.toContain('prune   post launch');
    const blog = api.space('blog');
    expect(blog.posts.find((p) => p.slug === 'launch')!.deleted).toBeUndefined();
    expect(blog.posts.find((p) => p.slug === 'second-post')!.deleted).toBe(true);
  });

  it('prints the changed paragraph and the changed tag field with --diff', async () => {
    await sync('--apply');
    api.writes.length = 0;
    const launch = join(dir, 'blog/2026-10-01-launch.md');
    writeFileSync(launch, readFileSync(launch, 'utf8').replace('will change.', 'has changed.'));
    writeFileSync(
      join(dir, 'forumulate.yml'),
      readFileSync(join(dir, 'forumulate.yml'), 'utf8').replace('#0A7F5A', '#123456'),
    );
    const { out } = await sync('--diff');
    expect(out).toContain('update  post launch');
    expect(out).toContain('- A second paragraph that a later edit will change.');
    expect(out).toContain('+ A second paragraph that a later edit has changed.');
    expect(out).toContain('update  tag releases');
    expect(out).toContain('~ color: "#0a7f5a" → "#123456"');
    expect(api.writes).toEqual([]);
  });

  it('rewrites an FAQ short answer through the slot door, then is quiet', async () => {
    await sync('--apply');
    const q = join(dir, 'faq/billing/refunds.md');
    writeFileSync(q, readFileSync(q, 'utf8').replace('Yes, within 30 days.', 'Yes — any time in the first 30 days.'));
    api.writes.length = 0;
    const { code, out } = await sync('--apply');
    expect(code).toBe(0);
    expect(out).toContain('update  page refunds   short-answer');
    expect(api.writes.some((w) => w.includes('/docs/import'))).toBe(false);
    expect(api.space('faq').pages[0]!.sections['short-answer']).toBe('Yes — any time in the first 30 days.');
    api.writes.length = 0;
    expect((await sync('--apply')).out).toContain('Nothing to change');
    expect(api.writes).toEqual([]);
  });
});
