import { describe, it, expect } from 'vitest';
import { Http } from '../api/http';
import { DOCTOR_CHECK_IDS, DOCTOR_HELP, runDoctorCommand } from './command';

type Reply = { status?: number; body?: string; headers?: Record<string, string> };
function fakeFetch(table: Record<string, Reply>, seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    seen.push(url);
    const reply = table[url];
    if (!reply) throw new Error(`no stub for ${url}`);
    return {
      status: reply.status ?? 200,
      ok: (reply.status ?? 200) < 400,
      headers: new Headers(reply.headers ?? { 'content-type': 'application/json' }),
      text: async () => reply.body ?? '',
      arrayBuffer: async () => new ArrayBuffer(0),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    deps: { out: (l: string) => out.push(l), err: (l: string) => err.push(l), env: {} },
  };
};

describe('forumulate doctor (command)', () => {
  it('prints its own help, naming every check and the exit codes', async () => {
    const t = io();
    expect(await runDoctorCommand(['--help'], t.deps)).toBe(0);
    for (const id of DOCTOR_CHECK_IDS) expect(DOCTOR_HELP).toContain(id);
    expect(t.out.join('\n')).toContain('Exit status');
  });

  it('is a usage error (2) with no URL, an unknown check, or a non-http URL', async () => {
    expect(await runDoctorCommand([], io().deps)).toBe(2);
    expect(await runDoctorCommand(['https://a.example', '--only', 'nope'], io().deps)).toBe(2);
    expect(await runDoctorCommand(['ftp://a.example'], io().deps)).toBe(2);
    expect(await runDoctorCommand(['--site', 'main'], io().deps)).toBe(2); // no org
  });

  it('emits the report as JSON only, and exits 1 on a FAIL', async () => {
    const t = io();
    const code = await runDoctorCommand(
      ['https://acme.example/docs', '--only', 'consent-tag,favicon', '--json'],
      {
        ...t.deps,
        fetchImpl: fakeFetch({
          'https://acme.example/docs': {
            body: '<html lang="de"><head><link rel="preload" href="https://cdn.cookiemunch.net/consent.js" as="script"/></head></html>',
            headers: { 'content-type': 'text/html' },
          },
        }),
      },
    );
    expect(code).toBe(1);
    const report = JSON.parse(t.out.join('\n')) as { checks: { id: string; state: string }[] };
    expect(report.checks.map((c) => c.id)).toEqual(['favicon', 'consent-tag']);
    expect(report.checks.find((c) => c.id === 'consent-tag')?.state).toBe('fail');
  });

  it('--site reads every address of every member space from the API', async () => {
    const seen: string[] = [];
    const table: Record<string, Reply> = {
      'https://api.example/orgs/acme/sites': {
        body: JSON.stringify({ sites: [{ id: 's1', slug: 'main', spaceIds: ['sp1'] }] }),
      },
      'https://api.example/orgs/acme/spaces/sp1/reader-auth': {
        body: JSON.stringify({
          readerEndpoints: [
            { url: 'https://platform.example/p/acme/docs', kind: 'platform', primary: false },
            { url: 'https://acme.example/docs', kind: 'domain', primary: true },
          ],
        }),
      },
      'https://acme.example/robots.txt': { body: 'Sitemap: https://acme.example/sitemap.xml' },
      'https://acme.example/sitemap.xml': {
        body: '<urlset><url><loc>https://acme.example/docs/a</loc></url></urlset>',
      },
      'https://acme.example/docs': {
        body: '<html lang="en"><head><link rel="canonical" href="https://acme.example/docs"/></head></html>',
        headers: { 'content-type': 'text/html' },
      },
      'https://platform.example/p/acme/docs': {
        body: '<html lang="en"><head><link rel="canonical" href="https://acme.example/docs"/></head></html>',
        headers: { 'content-type': 'text/html' },
      },
      'https://acme.example/docs/a': {
        body: '<html lang="en"><head><link rel="canonical" href="https://acme.example/docs/a"/></head></html>',
        headers: { 'content-type': 'text/html' },
      },
      // The platform copy of the page names ITSELF: the FMU-B01 shape.
      'https://platform.example/p/acme/docs/a': {
        body: '<html lang="en"><head><link rel="canonical" href="https://platform.example/p/acme/docs/a"/></head></html>',
        headers: { 'content-type': 'text/html' },
      },
    };
    const fetchImpl = fakeFetch(table, seen);
    const t = io();
    const http = new Http({
      baseUrl: 'https://api.example',
      userAgent: 'test',
      fetch: fetchImpl,
      retries: 0,
    });
    const code = await runDoctorCommand(
      ['--site', 'main', '--org', 'acme', '--only', 'canonical-both-addresses', '--json'],
      { ...t.deps, fetchImpl, http },
    );
    expect(code).toBe(1);
    const report = JSON.parse(t.out.join('\n')) as { url: string; checks: { detail: string }[] };
    expect(report.url).toBe('https://acme.example/docs');
    expect(report.checks[0]!.detail).toContain('https://platform.example/p/acme/docs/a names');
  });

  it('a site that does not exist is not-found (4)', async () => {
    const fetchImpl = fakeFetch({
      'https://api.example/orgs/acme/sites': { body: '{"sites":[]}' },
    });
    const http = new Http({
      baseUrl: 'https://api.example',
      userAgent: 'test',
      fetch: fetchImpl,
      retries: 0,
    });
    const t = io();
    expect(
      await runDoctorCommand(['--site', 'nope', '--org', 'acme'], { ...t.deps, fetchImpl, http }),
    ).toBe(4);
  });
});
