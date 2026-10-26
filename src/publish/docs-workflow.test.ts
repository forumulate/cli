import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { declaredRedirects, rulesFromCsv, rulesToCsv, syncRedirects } from './redirects';
import { PREVIEW_NAME, ciSource } from './preview';
import { loadManifest } from './manifest';
import { postPreviewComment } from '../preview-comment';

/** forumulate.yaml `redirects:` (FMU-F09) and `publish --preview` (FMU-F01). */

describe('manifest redirects', () => {
  it('accepts a list or a CSV file, and refuses a rule without a path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fm-redir-'));
    const file = join(dir, 'forumulate.yaml');
    writeFileSync(file, 'space: docs\nredirects:\n  - { from: /old, to: /new, status: 301 }\n');
    expect(loadManifest(file).spaces[0]!.redirects).toEqual([{ from: '/old', to: '/new', status: 301 }]);
    writeFileSync(file, 'space: docs\nredirects:\n  - { from: old, to: /new }\n');
    expect(() => loadManifest(file)).toThrow(/must be a path/);
    writeFileSync(join(dir, 'r.csv'), 'from,to,status\n/a,/b,308\n# note\n/c,"/d, e",\n');
    expect(declaredRedirects({ redirects: 'r.csv' }, file, dir)).toEqual([
      { from: '/a', to: '/b', status: 308 },
      { from: '/c', to: '/d, e' },
    ]);
  });

  it('round-trips through the CSV the import door reads', () => {
    const rules = [{ from: '/a', to: '/b "q"', status: 301 as const }];
    expect(rulesFromCsv(rulesToCsv(rules))).toEqual(rules);
  });

  it('plans only what differs, and merges it through POST …/redirects/import', async () => {
    const lines: { verb: string; what: string }[] = [];
    const posts: { path: string; body: { csv: string; mode: string } }[] = [];
    const ctx = {
      org: 'o',
      spaceId: 's',
      root: '/',
      spec: {
        path: '',
        redirects: [
          { from: '/same', to: '/x' },
          { from: '/moved', to: '/y' },
          { from: '/new', to: '/z' },
        ],
      },
      line: (l: { verb: string; what: string }) => lines.push(l),
      api: {
        get: async () => ({
          redirects: [
            { from: '/same', to: '/x' },
            { from: '/moved', to: '/old' },
            { from: '/auto', to: '/kept', auto: true },
          ],
        }),
        post: async (path: string, body: { csv: string; mode: string }) => void posts.push({ path, body }),
      },
    } as never;
    await syncRedirects(ctx, false, null);
    expect(lines.map((l) => `${l.verb} ${l.what}`)).toEqual(['update redirect /moved', 'create redirect /new']);
    expect(posts).toEqual([]);
    await syncRedirects(ctx, true, null);
    expect(posts[0]!.path).toBe('/orgs/o/spaces/s/redirects/import');
    expect(posts[0]!.body.mode).toBe('merge');
    expect(posts[0]!.body.csv).not.toContain('/same');
  });
});

describe('previews', () => {
  it('a preview name is a label', () => {
    expect(PREVIEW_NAME.test('pr-123')).toBe(true);
    expect(PREVIEW_NAME.test('-x')).toBe(false);
  });

  it('reads the pull request from any CI', () => {
    expect(
      ciSource({ GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/docs', GITHUB_REF: 'refs/pull/7/merge', GITHUB_SHA: 'abc' }),
    ).toMatchObject({ provider: 'github', repository: 'acme/docs', number: '7', url: 'https://github.com/acme/docs/pull/7' });
    expect(
      ciSource({ GITLAB_CI: 'true', CI_PROJECT_PATH: 'acme/docs', CI_MERGE_REQUEST_IID: '9', CI_PROJECT_URL: 'https://gitlab.com/acme/docs' }),
    ).toMatchObject({ provider: 'gitlab', number: '9', url: 'https://gitlab.com/acme/docs/-/merge_requests/9' });
    expect(ciSource({ BITBUCKET_REPO_FULL_NAME: 'acme/docs', BITBUCKET_PR_ID: '3' })).toMatchObject({
      provider: 'bitbucket',
      url: 'https://bitbucket.org/acme/docs/pull-requests/3',
    });
    expect(ciSource({ FORUMULATE_PREVIEW_PROVIDER: 'gerrit', FORUMULATE_PREVIEW_NUMBER: '42' })).toEqual({
      provider: 'gerrit',
      number: '42',
    });
    expect(ciSource({})).toEqual({});
  });

  it('edits its own PR comment instead of adding one per push', async () => {
    const calls: string[] = [];
    const preview = {
      space: 'docs',
      id: 'p',
      name: 'pr-7',
      token: 't',
      urls: [],
      expiresAt: '2026-10-31',
      summary: { added: 1, changed: 0, removed: 0, unchanged: 0 },
      comment: '<!-- forumulate-preview:pr-7 -->\nhello',
    };
    const env = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'acme/docs', GITHUB_REF: 'refs/pull/7/merge', GITHUB_TOKEN: 'x' };
    const fake = (existing: { id: number; body: string }[]) =>
      (async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        return new Response(JSON.stringify(existing), { status: 200 });
      }) as typeof fetch;
    await postPreviewComment(preview, env, fake([{ id: 5, body: '<!-- forumulate-preview:pr-7 -->\nold' }]));
    expect(calls[1]).toBe('PATCH https://api.github.com/repos/acme/docs/issues/comments/5');
    calls.length = 0;
    await postPreviewComment(preview, env, fake([]));
    expect(calls[1]).toBe('POST https://api.github.com/repos/acme/docs/issues/7/comments');
    expect(await postPreviewComment(preview, {}, fake([]))).toBeNull();
  });
});
