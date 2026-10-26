import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { slim } from './slim';
import type { OperationIndex } from './spec';

/**
 * The live API's operations, cached beside the bundled index (FMU-D13).
 *
 * `forumulate api list` said 1,810 operations while the live spec had 2,471:
 * the index is cut from the spec at the moment the CLI is built, and 0.8.0 was
 * built on 2026-10-17 — the API grew by six hundred operations in the week
 * after. Nothing was filtered; the CLI was simply older than the API, and
 * nothing said so. `api list --refresh` fetches the live `openapi.json` (an
 * `If-None-Match` revalidation when it already has one, so a refresh that finds
 * nothing new costs a 304), cuts the same slim index from it and keeps it per
 * API base. Every `api` command then runs from the newer of the two, and the
 * list's footer says which one it counted.
 */
export interface LiveMeta {
  url: string;
  etag: string | null;
  fetchedAt: string;
  ops: number;
}

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.FORUMULATE_CONFIG_DIR) return join(env.FORUMULATE_CONFIG_DIR, 'cache');
  if (env.XDG_CACHE_HOME) return join(env.XDG_CACHE_HOME, 'forumulate');
  return join(homedir(), '.cache', 'forumulate');
}

const keyOf = (apiBase: string) =>
  apiBase.replace(/^https?:\/\//, '').replace(/[^a-z0-9.-]+/gi, '_').toLowerCase();

function paths(apiBase: string, env: NodeJS.ProcessEnv) {
  const dir = cacheDir(env);
  const key = keyOf(apiBase);
  return { dir, index: join(dir, `operations-${key}.json`), meta: join(dir, `operations-${key}.meta.json`) };
}

/** The cached live index for this API base, when a refresh has made one. */
export function readLive(
  apiBase: string,
  env: NodeJS.ProcessEnv = process.env,
): { index: OperationIndex; meta: LiveMeta } | undefined {
  try {
    const p = paths(apiBase, env);
    return {
      index: JSON.parse(readFileSync(p.index, 'utf8')) as OperationIndex,
      meta: JSON.parse(readFileSync(p.meta, 'utf8')) as LiveMeta,
    };
  } catch {
    return undefined;
  }
}

export type SpecFetch = (
  url: string,
  init: { headers: Record<string, string> },
) => Promise<{ status: number; headers: { get(n: string): string | null }; text(): Promise<string> }>;

/**
 * Fetch the live spec (revalidating with the stored ETag) and store its slim
 * index. Answers whether it changed and how many operations the API has.
 */
export async function refreshLive(
  apiBase: string,
  opts: { env?: NodeJS.ProcessEnv; fetchImpl?: SpecFetch; userAgent?: string } = {},
): Promise<{ changed: boolean; meta: LiveMeta }> {
  const env = opts.env ?? process.env;
  const p = paths(apiBase, env);
  const prior = readLive(apiBase, env);
  const url = `${apiBase.replace(/\/+$/, '')}/openapi.json`;
  const doFetch: SpecFetch = opts.fetchImpl ?? ((u, init) => fetch(u, init));
  const res = await doFetch(url, {
    headers: {
      accept: 'application/json',
      'user-agent': opts.userAgent ?? '@forumulate/cli',
      ...(prior?.meta.etag ? { 'if-none-match': prior.meta.etag } : {}),
    },
  });
  if (res.status === 304 && prior) {
    const meta = { ...prior.meta, fetchedAt: new Date().toISOString() };
    writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`);
    return { changed: false, meta };
  }
  if (res.status < 200 || res.status >= 300)
    throw Object.assign(new Error(`GET ${url} answered ${res.status}`), { status: res.status });
  const index = slim(JSON.parse(await res.text()));
  const meta: LiveMeta = {
    url,
    etag: res.headers.get('etag'),
    fetchedAt: new Date().toISOString(),
    ops: index.ops.length,
  };
  mkdirSync(p.dir, { recursive: true });
  writeFileSync(p.index, JSON.stringify(index));
  writeFileSync(p.meta, `${JSON.stringify(meta, null, 2)}\n`);
  return { changed: true, meta };
}
