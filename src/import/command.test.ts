import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ForumulateClient } from '@forumulate/sdk';
import { run } from '../run';
import { diskFiles } from './disk';
import type { ImportFiles } from './types';

const ORG = '11111111-1111-4111-8111-111111111111';
const LIB = '22222222-2222-4222-8222-222222222222';
const ROOT = path.join(__dirname, '__fixtures__', 'wordpress');
const files: ImportFiles = { ...diskFiles, exists: () => false };

function harness(ask?: string) {
  const out: string[] = [];
  const err: string[] = [];
  const created: string[] = [];
  const writes: string[] = [];
  const client = {
    orgs: { list: async () => ({ orgs: [{ id: ORG, slug: 'acme', name: 'Acme' }] }) },
    content: {
      libraries: { list: async () => ({ libraries: [{ id: LIB, slug: 'site', name: 'Acme site' }] }) },
      model: {
        import: async (_o: string, _l: string, b: { dryRun?: boolean }) => {
          writes.push(b.dryRun ? 'model dry' : 'model apply');
          return { changed: true, applied: !b.dryRun, storageOnly: false, ops: [], version: 2, diff: [], issues: [] };
        },
        get: async () => ({
          model: {
            shape: {},
            types: Object.fromEntries(['post', 'page'].map((k) => [k, { label: k, patch: { params: { add: [{ key: 'title', type: 'text' }, { key: 'body', type: 'richText' }] } } }])),
            version: 2,
          },
        }),
      },
      assets: { list: async () => ({ assets: [] }) },
      entries: {
        lookup: async () => ({ found: {} }),
        create: async (_o: string, _l: string, i: { title: string }) => (created.push(i.title), { item: { id: `e${created.length}`, title: i.title } }),
        setFields: async () => ({ fields: {} }),
        publish: async () => ({ published: true }),
      },
    },
  } as unknown as ForumulateClient;
  const upload = async (_p: string, form: FormData) => ({ asset: { id: 'a1', url: 'https://x.test/a', filename: (form.get('file') as File).name } });
  const go = (args: string[]) =>
    run(args, {
      client, out: (l) => out.push(l), err: (l) => err.push(l), env: {}, upload,
      ask: ask === undefined ? undefined : async () => ask,
    });
  return { go, out, err, created, writes };
}

// The WordPress fixture's one picture is remote; no network in a unit test.
const withFetch = async <T>(fn: () => Promise<T>): Promise<T> => {
  const real = globalThis.fetch;
  globalThis.fetch = (async () => new Response(new Uint8Array([1, 2, 3]))) as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = real;
  }
};
const args = (...rest: string[]) => ['import', 'wordpress', path.join(ROOT, 'export.xml'), '--library', 'site', ...rest];

describe('forumulate import', () => {
  it('--dry-run reads and reports, writes nothing', async () => {
    const h = harness();
    expect(await h.go(args('--dry-run'))).toBe(0);
    expect(h.writes).toEqual(['model dry']);
    expect(h.created).toEqual([]);
    expect(h.out.join('\n')).toMatch(/2 entries and 1 file would be imported from wordpress/);
  });

  it('shows the dry run first, asks, and imports on yes', async () => {
    const h = harness('y');
    expect(await withFetch(() => h.go(args()))).toBe(0);
    expect(h.writes).toEqual(['model dry', 'model dry', 'model apply']);
    expect(h.created).toEqual(['Hello world & welcome', 'About']);
    expect(h.out.join('\n')).toMatch(/Entries: 2 created, 0 updated of 2, 1 published/);
  });

  it('imports nothing on no, and refuses to apply with nobody to ask', async () => {
    const no = harness('n');
    expect(await no.go(args())).toBe(0);
    expect(no.created).toEqual([]);
    expect(no.out.at(-1)).toBe('Nothing imported.');
    const mute = harness();
    expect(await mute.go(args())).toBe(1);
    expect(mute.err[0]).toMatch(/pass --yes/);
  });

  it('--yes --publish none keeps everything a draft', async () => {
    const h = harness();
    expect(await withFetch(() => h.go(args('--yes', '--publish', 'none')))).toBe(0);
    expect(h.out.join('\n')).toMatch(/0 published/);
  });

  it('says what is wrong with the arguments', async () => {
    const h = harness();
    expect(await h.go(['import'])).toBe(1);
    expect(h.err[0]).toMatch(/Usage: forumulate import/);
    expect(await h.go(['import', 'drupal', 'x', '--library', 'site'])).toBe(1);
    expect(h.err[1]).toMatch(/Unknown platform "drupal"/);
    expect(await h.go(args('--publish', 'sometimes'))).toBe(1);
    expect(h.err[2]).toMatch(/--publish is source, all or none/);
    expect(await h.go(['import', 'wordpress', 'x.xml'])).toBe(1);
    expect(h.err[3]).toMatch(/Say which content library/);
  });

  it('a missing export is a clear stop, not a stack trace', async () => {
    const h = harness();
    expect(await h.go(['import', 'wordpress', path.join(ROOT, 'nope.xml'), '--library', 'site', '--yes'])).toBe(1);
    expect(h.err[0]).toMatch(/^Import stopped: /);
  });
});
