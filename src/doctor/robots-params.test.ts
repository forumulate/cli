import { describe, expect, it } from 'vitest';
import { disallowLines, linesByOrigin, robotsParams, VARIANT_PARAMS } from './robots-params';

/** SEO spec §1 item 5: the doctor prints the Disallow lines a host's robots.txt can carry. */
describe('robots-params', () => {
  it('writes one wildcard line per re-cut parameter, under the mount', () => {
    const lines = disallowLines('/community/');
    expect(lines).toHaveLength(VARIANT_PARAMS.length);
    expect(lines).toContain('Disallow: /community*?*sort=');
    expect(lines).toContain('Disallow: /community*?*range=');
    expect(lines.some((l) => l.includes('page='))).toBe(false);
    expect(disallowLines('')).toContain('Disallow: /*?*sort=');
  });

  it('groups roots by the host whose robots.txt carries them', () => {
    const m = linesByOrigin(['https://acme.com/community', 'https://acme.com/status', 'https://x.io']);
    expect([...m.keys()]).toEqual(['https://acme.com', 'https://x.io']);
    expect(m.get('https://acme.com')).toContain('Disallow: /status*?*range=');
  });

  it('suggests the missing lines (advice, never a failure)', () => {
    const c = robotsParams(['https://acme.com/community'], 'https://acme.com', 'User-agent: *\nAllow: /\n');
    expect(c.state).toBe('skip');
    expect(c.detail).toContain('# https://acme.com/robots.txt');
    expect(c.detail).toContain('Disallow: /community*?*order=');
  });

  it('passes once every line is there', () => {
    const robots = ['User-agent: *', ...disallowLines('/community')].join('\n');
    expect(robotsParams(['https://acme.com/community'], 'https://acme.com', robots).state).toBe('pass');
  });
});
