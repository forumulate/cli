import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { VERSION, run } from './run';
import { apiBaseFromEnv, siteFromEnv } from './api-base';

/**
 * `--version` is the first thing anybody runs and the only thing a bug report
 * quotes. It said 0.1.0 while the published package was 0.2.1, so every report
 * named a release that does not exist.
 */
describe('the CLI version', () => {
  it('is the version of the package that ships it', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });
});

/**
 * The default base URL is the HOSTED API.
 *
 * `http://localhost:4000` is this repository's dev port and nothing on a
 * customer's machine: somebody who installed the CLI got a connection refused
 * and a `--help` confirming that address was intended (a customer report, CLI).
 */
describe('the default API base', () => {
  it('is the hosted API, not a dev port', () => {
    expect(apiBaseFromEnv({})).toBe('https://forumulate.com/api');
    expect(apiBaseFromEnv({ FORUMULATE_URL: '' })).toBe('https://forumulate.com/api');
    expect(apiBaseFromEnv({ FORUMULATE_URL: '   ' })).toBe('https://forumulate.com/api');
  });

  it('still lets the environment point it anywhere', () => {
    expect(apiBaseFromEnv({ FORUMULATE_API_URL: 'http://localhost:4000' })).toBe(
      'http://localhost:4000',
    );
    expect(
      apiBaseFromEnv({ FORUMULATE_API_URL: 'http://localhost:4000/', FORUMULATE_URL: 'x' }),
    ).toBe('http://localhost:4000');
  });

  /*
   * FORUMULATE_URL names the site, as it does for the SDK and @forumulate/mcp —
   * and the old API-base spelling keeps working rather than becoming `/api/api`.
   */
  it('reads FORUMULATE_URL as the site, and accepts the old /api spelling', () => {
    expect(apiBaseFromEnv({ FORUMULATE_URL: 'https://docs.acme.dev' })).toBe(
      'https://docs.acme.dev/api',
    );
    expect(apiBaseFromEnv({ FORUMULATE_URL: 'https://forumulate.com/api/' })).toBe(
      'https://forumulate.com/api',
    );
    expect(siteFromEnv({ FORUMULATE_URL: 'https://forumulate.com/api' })).toBe(
      'https://forumulate.com',
    );
    expect(siteFromEnv({ FORUMULATE_URL: ' ' })).toBeUndefined();
  });

  it('says the same thing in --help as it does in code', async () => {
    const lines: string[] = [];
    await run(['--help'], {
      client: {} as never,
      out: (l) => lines.push(l),
      err: (l) => lines.push(l),
    } as never);
    expect(lines.join('\n')).toContain('https://forumulate.com/api');
  });
});
