import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bodyProperties, findById } from '../api/spec';
import { fakeApi, SPACE_ID, type FakeApi } from '../testing/fake-api';
import { findGroup } from './groups';
import { groupHelp } from './resource';

/**
 * `forumulate openapi relabel` (FMU-D10): the landing page of a reference,
 * renamed from a terminal — by the spec's id, its name, or the slug a person
 * would type for the name.
 */
const SPEC = '44444444-2222-4333-8444-555555555555';
const S = `/orgs/acme/spaces/${SPACE_ID}/docs/openapi/specs`;
const env = { FORUMULATE_ORG: 'acme', FORUMULATE_CONFIG_DIR: join(tmpdir(), 'fm-relabel-none') };

beforeAll(() => {
  // Until the bundled spec is refreshed with the new fields, describe them
  // here, the way the refreshed spec will; afterwards this is a no-op.
  const op = findById('OpenApi_resyncSpec')!;
  if (!('landingSlug' in bodyProperties(op)))
    op.b = {
      all: [
        ...(op.b ? [op.b] : []),
        {
          t: 'object',
          p: {
            landingSlug: { t: 'string' },
            landingTitle: { t: 'string' },
            landingDescription: { t: 'string' },
          },
        },
      ],
    };
});

let api: FakeApi;
beforeEach(async () => {
  api = await fakeApi();
  api.on(`GET ${S}`, { body: { specs: [{ id: SPEC, name: 'Referally API' }] } });
  api.on(`POST ${S}/${SPEC}/resync`, (req) => ({
    body: {
      spec: { id: SPEC, name: 'Referally API' },
      regenerated: {
        slug: (req.body as { landingSlug?: string }).landingSlug ?? 'ref-referally-api',
        landingMoved: { pageId: 'p1', from: 'ref-referally-api', to: 'ref-referalli-api' },
      },
    },
  }));
});
afterEach(() => api.close());

describe('openapi relabel', () => {
  it('finds the spec by the slug of its name and sends the labels to resync', async () => {
    const r = await api.cli(
      [
        'openapi',
        'relabel',
        'referally-api',
        '--space',
        SPACE_ID,
        '--landing-slug',
        'ref-referalli-api',
        '--landing-title',
        'Referalli API',
        '--landing-description',
        'Run referral programs.',
        '--json',
      ],
      { env },
    );
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    const sent = api.seen.at(-1)!;
    expect(sent.method).toBe('POST');
    expect(sent.path).toBe(`${S}/${SPEC}/resync`);
    expect(sent.body).toEqual({
      landingSlug: 'ref-referalli-api',
      landingTitle: 'Referalli API',
      landingDescription: 'Run referral programs.',
    });
    expect(JSON.parse(r.out).regenerated.landingMoved.to).toBe('ref-referalli-api');
  });

  it('refuses to run with no label at all — that would be a plain full resync', async () => {
    const r = await api.cli(['openapi', 'relabel', SPEC, '--space', SPACE_ID], { env });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('--landing-slug');
    expect(api.seen.filter((s) => s.method === 'POST')).toEqual([]);
  });

  it('prints the request and sends nothing with --dry-run', async () => {
    const r = await api.cli(
      ['openapi', 'relabel', SPEC, '--space', SPACE_ID, '--landing-slug', 'ref-x', '--dry-run'],
      { env },
    );
    expect(r.code).toBe(0);
    expect(r.out).toContain(`POST`);
    expect(r.out).toContain(`/specs/${SPEC}/resync`);
    expect(api.seen).toEqual([]);
  });

  it('is in the group help', () => {
    expect(groupHelp(findGroup('openapi')!)).toContain('forumulate openapi relabel <id>');
  });
});
