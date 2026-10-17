import type { Http } from '../api/http';
import type { CliConfig } from './config';
import { UsageError } from '../api/request';

/**
 * What `forumulate api` and the resource commands need from the outside world,
 * all injected so the tests drive them against a fake server and no disk.
 */
export interface CommandDeps {
  http: Http;
  out: (line: string) => void;
  err: (line: string) => void;
  env: NodeJS.ProcessEnv;
  config: CliConfig;
  readFile: (path: string) => string | Buffer;
  /** Where `--out <file>` lands: a downloaded archive, PDF or export. */
  writeFile: (path: string, data: Buffer | string) => void;
  readStdin: () => Promise<string>;
  /** A visible y/N question; absent when nobody can answer (CI, a pipe). */
  ask?: (question: string) => Promise<string>;
  /** `--org` → `FORUMULATE_ORG` → `config set org`, already resolved. */
  defaultOrg?: string;
}

export const isUuid = (s: string): boolean =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);

/**
 * A space by id or slug. `/orgs/{orgId}` takes a slug; `/spaces/{spaceId}`
 * takes only the id, and "pass the uuid" is not an answer a person typing
 * `--space docs` should get. One list call, only when it is not already an id.
 */
export async function resolveChild(
  deps: CommandDeps,
  what: 'space' | 'library',
  orgId: string,
  ref: string,
): Promise<string> {
  if (isUuid(ref)) return ref;
  const path =
    what === 'space'
      ? `/orgs/${encodeURIComponent(orgId)}/spaces`
      : `/orgs/${encodeURIComponent(orgId)}/content/libraries`;
  const key = what === 'space' ? 'spaces' : 'libraries';
  let cursor: string | undefined;
  const seen: string[] = [];
  for (let i = 0; i < 50; i++) {
    const res = await deps.http.send({
      method: 'GET',
      path,
      query: { limit: '100', ...(cursor ? { cursor } : {}) },
    });
    const body = res.data as Record<string, unknown> & {
      page?: { hasMore?: boolean; nextCursor?: string | null };
    };
    const rows = (body[key] ?? body.data ?? []) as { id: string; slug?: string }[];
    const hit = rows.find((r) => r.slug === ref || r.id === ref);
    if (hit) return hit.id;
    seen.push(...rows.map((r) => r.slug ?? r.id));
    cursor = body.page?.nextCursor ?? undefined;
    if (!body.page?.hasMore || !cursor) break;
  }
  throw new UsageError(
    `No ${what} "${ref}" in ${orgId} (it has: ${seen.slice(0, 12).join(', ') || 'none'}${seen.length > 12 ? ', …' : ''})`,
  );
}

/**
 * The y/N before anything irreversible. `--yes` skips it; with no terminal to
 * ask on, `--yes` is required — a delete in CI that silently proceeds because
 * nobody could be asked is the outcome the question exists to prevent.
 */
export async function confirm(deps: CommandDeps, yes: boolean, question: string): Promise<boolean> {
  if (yes) return true;
  if (!deps.ask) {
    deps.err(`${question} Refusing without --yes (no terminal to ask on).`);
    return false;
  }
  const answer = (await deps.ask(`${question} [y/N] `)).trim().toLowerCase();
  if (answer === 'y' || answer === 'yes') return true;
  deps.err('Cancelled.');
  return false;
}
