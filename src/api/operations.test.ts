import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from './args';
import { findById, findByPath, loadIndex, pathParams } from './spec';
import { planRequest } from './request';
import { GROUPS } from '../commands/groups';

/**
 * Every operation the API publishes is reachable through `forumulate api` —
 * walked off the SDK's spec, not a list typed here, so a route added after
 * this file was written is covered by existing.
 */
const SPEC = JSON.parse(
  readFileSync(join(__dirname, '..', '..', '..', 'sdk', 'openapi.json'), 'utf8'),
) as { paths: Record<string, Record<string, { operationId: string }>> };

const METHODS = ['get', 'post', 'put', 'patch', 'delete'];
const all = Object.entries(SPEC.paths).flatMap(([path, item]) =>
  METHODS.filter((m) => item[m]).map((m) => ({
    path,
    method: m.toUpperCase(),
    id: item[m]!.operationId,
  })),
);

describe('the bundled operation index', () => {
  it('is the slim cut of the current SDK spec (run `pnpm --filter @forumulate/cli slim-spec`)', async () => {
    // @ts-expect-error — an .mjs script with no declaration file
    const { render } = (await import('../../scripts/slim-spec.mjs')) as {
      render: (s: unknown) => string;
    };
    const committed = readFileSync(join(__dirname, 'operations.json'), 'utf8');
    expect(committed === render(SPEC)).toBe(true);
  });

  it('holds every operation in the spec', () => {
    expect(all.length).toBeGreaterThan(1000);
    expect(loadIndex().ops.length).toBe(all.length);
  });

  it('reaches every operation by operationId and by METHOD path, and can plan a request for each', async () => {
    const unreachable: string[] = [];
    for (const { id, method, path } of all) {
      const byId = findById(id);
      const byPath = findByPath(method, path);
      if (!byId || byPath?.op.id !== id) {
        unreachable.push(`${id} (${method} ${path})`);
        continue;
      }
      const values = pathParams(byId).map((n) => `v-${n}`);
      const required = (byId.q ?? [])
        .filter((p) => p.r && p.in !== 'path')
        .map((p) => `--${p.n}=x`);
      const { request } = await planRequest(byId, parseArgs(required), values, {
        readFile: () => '',
        readStdin: async () => '',
      });
      if (request.method !== method || request.path.includes('{'))
        unreachable.push(`${id}: planned ${request.method} ${request.path}`);
    }
    expect(unreachable).toEqual([]);
  });

  it('resolves a concrete path to its template, literal segments first', () => {
    const hit = findByPath('GET', '/orgs/acme/members/invites');
    expect(hit?.op.id).toBe('Member_invites');
    const spaces = findByPath('GET', '/orgs/acme/spaces');
    expect(spaces).toMatchObject({ op: { id: 'Space_list' }, values: { orgId: 'acme' } });
  });

  it('names only operations that exist in every resource command', () => {
    const missing = GROUPS.flatMap((g) =>
      Object.entries(g.verbs).flatMap(([verb, v]) =>
        [v.op, v.publishOp, v.contentOp, ...Object.values(v.lookup ?? {}).map((l) => l.listOp)]
          .filter((id): id is string => Boolean(id))
          .filter((id) => !findById(id))
          .map((id) => `${g.name} ${verb}: ${id}`),
      ),
    );
    expect(missing).toEqual([]);
  });
});
