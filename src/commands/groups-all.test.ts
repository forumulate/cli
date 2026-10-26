import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bodyProperties, findById, pathParams, resolveRef } from '../api/spec';
import { fakeApi, SPACE_ID, type FakeApi } from '../testing/fake-api';
import { complete } from './completion';
import { GROUPS, findGroup } from './groups';
import { groupHelp } from './resource';
import { HELP } from '../help';

/**
 * Every resource command, driven as a person types it.
 *
 * The groups are data, so one walk covers all of them: each verb's
 * positionals are filled with a value of the type the operation wants, the
 * command runs with `--dry-run`, and the request it would send must be the
 * verb's operation — method and path. A verb whose positionals do not line up
 * with its operation (a body field typed as a path param, a missing required
 * query) fails here by name, not at a customer's terminal.
 */
const LIB = '22222222-2222-4333-8444-555555555555';
const ID = '33333333-2222-4333-8444-555555555555';
const env = {
  FORUMULATE_ORG: 'acme',
  FORUMULATE_CONFIG_DIR: join(tmpdir(), 'fm-groups-all-none'),
};

let api: FakeApi;
beforeEach(async () => {
  api = await fakeApi();
});
afterEach(() => api.close());

/** A value of the type `name` has in the operation: what a person would type. */
function sample(opId: string, name: string, v: { upload?: string }): string {
  const op = findById(opId)!;
  if (pathParams(op).includes(name)) return ID;
  if (name === v.upload) return 'logo.png';
  const q = (op.q ?? []).find((p) => p.n === name);
  const node = q ? { t: q.t } : resolveRef(op.b ? bodyProperties(op)[name] : undefined);
  const t = node?.t ?? node?.any?.map((a) => a.t).find(Boolean);
  if (t === 'boolean') return 'true';
  if (t === 'integer' || t === 'number') return '3';
  if (t === 'array') return 'a,b';
  if (t === 'object') return '{}';
  if (node?.e?.length) return String(node.e[0]);
  return 'x';
}

const verbs = GROUPS.flatMap((g) => Object.entries(g.verbs).map(([verb, v]) => ({ g, verb, v })));

describe('every resource command', () => {
  it('is many commands, each naming an operation the CLI bundles', () => {
    expect(verbs.length).toBeGreaterThan(400);
    expect(
      verbs.filter(({ v }) => !findById(v.op)).map(({ g, verb }) => `${g.name} ${verb}`),
    ).toEqual([]);
  });

  it('plans the request of its own operation from positionals alone', async () => {
    const wrong: string[] = [];
    for (const { g, verb, v } of verbs) {
      const op = findById(v.op)!;
      const args = (v.args ?? []).map((a) => sample(v.op, a.replace('...', ''), v));
      const required = (op.q ?? [])
        .filter((p) => p.r && p.in === 'query' && !(v.args ?? []).includes(p.n))
        .flatMap((p) => [`--${p.n}`, 'x']);
      // A verb that refuses to run without one of its fields gets one.
      const one = v.requireOne?.length
        ? ['--data', JSON.stringify({ [v.requireOne[0]!]: 'x' })]
        : [];
      const argv = [
        g.name,
        ...verb.split(' '),
        ...args,
        ...required,
        ...one,
        '--space',
        SPACE_ID,
        '--library',
        LIB,
        '--dry-run',
      ];
      const r = await api.cli(argv, { env, readFile: () => 'bytes' });
      const first = r.out.split('\n')[0] ?? '';
      const template = new RegExp(
        `^${op.m} [^ ]*/api${op.p.replace(/[.*+?^$()|[\]\\]/g, '\\$&').replace(/\{[^}]+\}/g, '[^/?]+')}(\\?|$)`,
      );
      if (r.code !== 0 || !template.test(first))
        wrong.push(`${g.name} ${verb} [${v.op}]: ${r.code} ${first} ${r.err}`);
    }
    expect(wrong).toEqual([]);
    // Dry runs send nothing.
    expect(api.seen).toEqual([]);
  });

  it('has help that names each verb’s operation, and completes every verb', () => {
    for (const g of GROUPS) {
      const help = groupHelp(g);
      for (const [verb, v] of Object.entries(g.verbs)) {
        expect(help, `${g.name} ${verb}`).toContain(`forumulate ${g.name} ${verb}`);
        expect(help, `${g.name} ${verb}`).toContain(`[${findById(v.op)!.id}]`);
        const [w0, w1] = verb.split(' ');
        expect(complete([g.name, w0!.slice(0, 2)]), `${g.name} ${verb}`).toContain(w0);
        if (w1) expect(complete([g.name, w0!, '']), `${g.name} ${verb}`).toContain(w1);
      }
    }
  });

  it('is named in `forumulate help`, and a file answer completes --out', () => {
    for (const g of GROUPS) expect(HELP, g.name).toContain(g.name);
    expect(complete(['openapi', 'sdk', 'download', '--o'])).toContain('--out');
    expect(complete(['docs', 'schedule', ''])).toEqual(['get', 'set', 'cancel']);
  });

  it('has no group name or alias twice, and none that hides an older top-level command', () => {
    const names = GROUPS.flatMap((g) => [g.name, ...(g.aliases ?? [])]);
    expect(new Set(names).size).toBe(names.length);
    for (const older of [
      'publish',
      'snapshot',
      'content',
      'import',
      'translations',
      'i18n',
      'doctor',
    ])
      expect(findGroup(older), older).toBeUndefined();
  });
});

describe('what the walk cannot see', () => {
  const S = `/orgs/acme/spaces/${SPACE_ID}`;

  it('a download keeps the bytes and writes them to --out; text with no --out prints', async () => {
    const zip = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0xff, 0x00]);
    api.on(`GET ${S}/docs/openapi/specs/${ID}/sdk/typescript/package`, {
      body: zip.toString('latin1'),
      headers: { 'content-type': 'application/zip' },
    });
    api.on('GET /orgs/acme/audit/export.csv', {
      body: 'at,action\n2026-10-01,page.published\n',
      headers: { 'content-type': 'text/csv' },
    });
    const written: { path: string; data: Buffer | string }[] = [];
    const writeFile = (path: string, data: Buffer | string) => written.push({ path, data });
    const r = await api.cli(
      ['openapi', 'sdk', 'download', ID, 'typescript', '--space', SPACE_ID, '--out', 'ts.zip'],
      { env, writeFile },
    );
    expect(r.code).toBe(0);
    expect(written[0]!.path).toBe('ts.zip');
    expect(Buffer.from(written[0]!.data).subarray(0, 4)).toEqual(zip.subarray(0, 4));
    expect(api.seen.at(-1)!.headers.accept).toBe('*/*');
    const csv = await api.cli(['audit', 'export', '--action', 'page.published'], {
      env,
      writeFile,
    });
    expect(csv.out).toBe('at,action\n2026-10-01,page.published');
    expect(api.seen.at(-1)!.query.action).toBe('page.published');
  });

  it('an upload sends the file’s bytes as multipart, not its path', async () => {
    api.on(`POST ${S}/assets`, { status: 201, body: { asset: { id: 'a1' } } });
    const r = await api.cli(['assets', 'upload', './logo.png', '--space', SPACE_ID], {
      env,
      readFile: () => Buffer.from('PNGDATA'),
    });
    expect(r.code).toBe(0);
    const sent = api.seen.at(-1)!;
    expect(String(sent.headers['content-type'])).toMatch(/^multipart\/form-data/);
    expect(sent.raw).toContain('PNGDATA');
    expect(sent.raw).toContain('filename="logo.png"');
  });

  it('removing a UI string override sends the locale and key the route reads', async () => {
    api.on('DELETE /orgs/acme/translation-overrides', { body: { ok: true } });
    const r = await api.cli(['orgs', 'strings', 'remove', 'es', 'reader.search', '--yes'], { env });
    expect(r.code).toBe(0);
    expect(api.seen.at(-1)!.query).toEqual({ locale: 'es', key: 'reader.search' });
  });

  it('blog translations put takes the body from --file; auto names the locale in the path', async () => {
    api.on(`PUT ${S}/blog/t1/translations/es`, { body: { translation: { code: 'es' } } });
    api.on(`POST ${S}/blog/t1/translations/es/auto`, { body: { translation: { code: 'es' } } });
    const file = join(tmpdir(), 'fm-es.md');
    const r = await api.cli(
      ['blog', 'translations', 'put', 't1', 'es', '--space', SPACE_ID, '--file', file],
      { env, readFile: () => '---\ntitle: Hola\n---\nTexto.\n' },
    );
    expect(r.code).toBe(0);
    expect(api.seen.at(-1)!.body).toEqual({ title: 'Hola', markdown: 'Texto.\n' });
    await api.cli(['blog', 'translations', 'auto', 't1', 'es', '--space', SPACE_ID, '--force'], {
      env,
    });
    expect(api.seen.at(-1)).toMatchObject({ method: 'POST', body: { force: true } });
  });

  it('docs schedule set / rollback / releases schedule read as English', async () => {
    api.on(`POST ${S}/pages/p1/schedule`, { status: 201, body: { schedule: {} } });
    api.on(`POST ${S}/pages/p1/rollback`, { body: { page: {} } });
    api.on('POST /orgs/acme/content/releases/r1/schedule', { body: { release: {} } });
    const at = '2026-11-01T09:00:00Z';
    expect(
      (await api.cli(['docs', 'schedule', 'set', 'p1', at, '--space', SPACE_ID], { env })).code,
    ).toBe(0);
    expect(api.seen.at(-1)!.body).toEqual({ publishAt: at });
    await api.cli(['docs', 'rollback', 'p1', 'rev9', '--mode', 'draft', '--space', SPACE_ID], {
      env,
    });
    expect(api.seen.at(-1)!.body).toEqual({ revisionId: 'rev9', mode: 'draft' });
    await api.cli(['releases', 'schedule', 'r1', at], { env });
    expect(api.seen.at(-1)!.body).toEqual({ publishAt: at });
  });

  it('a destructive verb asks first', async () => {
    api.on(`POST ${S}/pages/empty-trash`, { body: { ok: true } });
    const refused = await api.cli(['docs', 'trash', 'empty', '--space', SPACE_ID], { env });
    expect(refused.code).toBe(1);
    expect(refused.err).toContain('--yes');
    expect(api.seen).toEqual([]);
  });
});
