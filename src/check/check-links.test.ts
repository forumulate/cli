import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { headingSlug, legacyHeadingSlug, markdownAnchors, markdownLinks } from './markdown-links';
import { ExternalChecker, redirectAllowed } from './external';
import { folderReport, runCheck } from './command';

/** `forumulate check links` (FMU-F05), on a folder and against a fake API. */

describe('the anchor rule mirrors the renderer', () => {
  // The same cases packages/docs-schema/src/heading-anchor.test.ts pins.
  it('folds accents, keeps letters in any script, drops punctuation', () => {
    expect(headingSlug('Getting Started!')).toBe('getting-started');
    expect(headingSlug('Caché con ETags')).toBe('cache-con-etags');
    expect(legacyHeadingSlug('Caché con ETags')).toBe('cach-con-etags');
    expect(headingSlug('日本語の見出し')).toBe('日本語の見出し');
    expect(headingSlug('???')).toBe('section');
  });
  it('claims duplicates, explicit ids and HTML ids; skips code and the repeated title', () => {
    const md = '---\ntitle: Guide\n---\n# Guide\n\n## Install\n## Install\n## Flags {#cli-flags}\n<a id="legacy"></a>\n```\n## not a heading\n```\n';
    const ids = markdownAnchors(md, 'Guide');
    expect([...ids].sort()).toEqual(['cli-flags', 'install', 'install-2', 'legacy']);
  });
  it('finds links, pictures and definitions, not inside code', () => {
    const links = markdownLinks('See [a](./a.md#x) ![p](img/p.png)\n`[no](./no.md)`\n[ref]: https://x.test/\n<a href="/y">y</a>');
    expect(links.map((l) => [l.href, l.media])).toEqual([
      ['./a.md#x', false],
      ['img/p.png', true],
      ['https://x.test/', false],
      ['/y', false],
    ]);
  });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'fm-check-'));
  mkdirSync(join(root, 'guides'));
  writeFileSync(join(root, 'guides', 'install.md'), '# Install\n\n## Flags\n\nUse them.\n');
  writeFileSync(
    join(root, 'guides', 'intro.md'),
    [
      '# Intro',
      '',
      '[ok](./install.md#flags) [bad anchor](./install.md#nope) [same](#intro-notes)',
      '[missing file](./gone.md) [slug](./install) [missing slug](./nowhere)',
      '![pic](./missing.png) [other space](/api/thing) [web](https://example.test/)',
      '',
      '## Intro notes',
    ].join('\n'),
  );
  return root;
}

describe('folder mode', () => {
  it('reports each kind once, by file and line, and counts what it could not check', () => {
    const r = folderReport(fixture());
    const got = r.broken.map((b) => [b.reason, b.url, b.line]).sort();
    expect(got).toEqual(
      [
        ['anchor_not_found', './install.md#nope', 3],
        ['asset_missing', './missing.png', 5],
        ['internal_not_found', './gone.md', 4],
        ['internal_not_found', './nowhere', 4],
      ].sort(),
    );
    expect(r.checked.unchecked).toBe(1);
    expect([...r.external.keys()]).toEqual(['https://example.test/']);
  });

  it('exits 1 with a report, 0 when clean, and checks outside links when asked', async () => {
    const out: string[] = [];
    const root = fixture();
    const code = await runCheck(['check', 'links', root, '--json', '--external', '--no-cache'], ['links', root], {
      out: (l) => out.push(l),
      err: () => {},
      fetch: async () => ({ status: 404, headers: { get: () => null } }),
    });
    expect(code).toBe(1);
    const report = JSON.parse(out.join('\n'));
    expect(report.broken.some((b: { reason: string }) => b.reason === 'external_unreachable')).toBe(true);
    expect(report.external).toBeUndefined();

    const clean = mkdtempSync(join(tmpdir(), 'fm-clean-'));
    writeFileSync(join(clean, 'a.md'), '# A\n\n## Two\n\n[self](#two)\n');
    expect(await runCheck(['check', 'links', clean], ['links', clean], { out: () => {}, err: () => {} })).toBe(0);
  });

  it('asks the API in space mode', async () => {
    const out: string[] = [];
    const code = await runCheck(['check', 'links', '--space', 'docs', '--org', 'acme'], ['links'], {
      out: (l) => out.push(l),
      err: () => {},
      request: async <T,>(_m: string, path: string) => {
        expect(path).toBe('/orgs/acme/spaces/docs/docs/broken-links');
        return {
          checked: { pages: 2, links: 3, anchors: 1, external: 0 },
          broken: [{ pageSlug: 'guide', url: './q#x', reason: 'anchor_not_found', anchor: 'x' }],
        } as T;
      },
    });
    expect(code).toBe(1);
    expect(out[0]).toContain('guide  anchor_not_found');
  });
});

describe('outside links', () => {
  it('never follows a redirect, accepts only allowed hosts, and is paced per host', async () => {
    const waits: number[] = [];
    let now = 0;
    const checker = new ExternalChecker({
      allowRedirects: ['same-host'],
      perHostGapMs: 100,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
      fetch: async (url) =>
        url.endsWith('/moved')
          ? { status: 301, headers: { get: () => 'https://other.test/' } }
          : { status: 200, headers: { get: () => null } },
    });
    const v = await checker.checkAll(['https://a.test/1', 'https://a.test/2', 'https://a.test/moved']);
    expect(v.get('https://a.test/moved')).toMatchObject({ ok: false, reason: 'external_redirect' });
    expect(waits.length).toBeGreaterThan(0);
    expect(redirectAllowed('https://a.test/x', 'https://a.test/x/', ['same-host'])).toBe(true);
  });
});
