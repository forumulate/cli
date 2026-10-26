import { describe, it, expect } from 'vitest';
import { Http } from '../api/http';
import { readerAuthAtlasCheck } from './reader-auth-atlas';
import { runDoctorCommand } from './command';

/**
 * FMU-X01: `forumulate doctor` recommends the Atlas reader provider when the
 * API says this org uses Atlas but signs readers in another way — as advice
 * (a SKIP with the steps), never a FAIL.
 */
function api(body: unknown, status = 200): Http {
  const fetchImpl = (async (input: string | URL | Request) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.endsWith('/orgs/acme/reader-auth')) {
      return { status: 404, ok: false, headers: new Headers(), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) } as unknown as Response;
    }
    return {
      status,
      ok: status < 400,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return new Http({ baseUrl: 'https://api.example', userAgent: 'test', fetch: fetchImpl, retries: 0 });
}

const REC = {
  code: 'reader_auth.use_atlas',
  message: 'Use the Atlas reader provider.',
  docs: '/guides/reader-sign-in-with-your-app#atlas',
  patch: { providers: [{ method: 'atlas', config: { instanceId: 'ins_1', audience: 'forumulate:o1' } }] },
  manifest: { readerAuth: { method: 'atlas', instanceId: 'ins_1' } },
  relink: { from: { provider: 'external_jwt' }, to: { provider: 'atlas_byo', issuer: 'https://atlasauth.net' } },
};

describe('reader-auth-atlas', () => {
  it('prints the relink and the switch as advice when the API recommends Atlas', async () => {
    const c = await readerAuthAtlasCheck(api({ providers: [{ method: 'external_jwt' }], recommendations: [REC] }), 'acme');
    expect(c.state).toBe('skip');
    expect(c.detail).toContain('Recommended');
    expect(c.detail).toContain('POST /orgs/acme/members/relink');
    expect(c.detail).toContain('PATCH /orgs/acme/reader-auth');
    expect(c.detail).toContain('"readerAuth"');
  });

  it('passes when atlas_byo is configured or nothing is recommended', async () => {
    expect((await readerAuthAtlasCheck(api({ providers: [{ method: 'atlas_byo' }], recommendations: [] }), 'acme')).state).toBe('pass');
    expect((await readerAuthAtlasCheck(api({ providers: [{ method: 'oidc' }], recommendations: [] }), 'acme')).state).toBe('pass');
  });

  it('is a skip, not a crash, when the token cannot read reader sign-in', async () => {
    const c = await readerAuthAtlasCheck(api({ error: { code: 'rbac.forbidden' } }, 403), 'acme');
    expect(c.state).toBe('skip');
    expect(c.detail).toContain('403');
  });

  it('runs from `doctor --org` and never fails the run', async () => {
    const out: string[] = [];
    const http = api({ providers: [{ method: 'external_jwt' }], recommendations: [REC] });
    const notFound = (async () =>
      ({ status: 404, ok: false, headers: new Headers(), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }) as unknown as Response) as unknown as typeof fetch;
    const code = await runDoctorCommand(['https://acme.example/docs', '--org', 'acme', '--only', 'reader-auth-atlas', '--json'], {
      out: (l) => out.push(l),
      err: () => {},
      env: {},
      fetchImpl: notFound,
      http,
    });
    expect(code).toBe(0);
    const report = JSON.parse(out.join('\n')) as { checks: { id: string; state: string }[] };
    expect(report.checks).toEqual([expect.objectContaining({ id: 'reader-auth-atlas', state: 'skip' })]);
  });
});
