/**
 * Where this CLI talks to, when nobody says.
 *
 * It defaulted to `http://localhost:4000`, which is the API's port on a
 * developer's machine and nothing at all on anybody else's. Forumulate is
 * hosted — we operate it and customers never run it — so somebody who
 * `npm i -g @forumulate/cli` and types `forumulate spaces` has a dev server's
 * address, a connection refused, and a `--help` that confirms the address is
 * the intended one. A customer read that and asked which host they were
 * supposed to be running (a customer's CLI finding).
 *
 * The hosted API is the default now, and `login` stores a token per base URL so
 * two environments do not collide.
 */
export const DEFAULT_API_BASE = 'https://forumulate.com/api';

type Env = Record<string, string | undefined>;

/** A blank variable is an unset one — `FOO= cmd` is how a shell clears it. */
function stated(env: Env, name: string): string | undefined {
  const v = env[name]?.trim();
  return v ? v.replace(/\/+$/, '') : undefined;
}

/**
 * The base URL to use.
 *
 * `FORUMULATE_URL` names the SITE (`https://forumulate.com`), the same value the
 * SDK's `ForumulateClient.fromEnv()` and `@forumulate/mcp` read, so one `.env`
 * configures all three. The API is its `/api`. This variable used to mean the
 * API base itself, so a value already ending in `/api` is taken as-is rather
 * than doubled — every value that worked before still works.
 *
 * `FORUMULATE_API_URL` is the exact API base, for the one case a site URL
 * cannot express: a local API on its own port with no `/api` prefix
 * (`http://localhost:4000`).
 */
export function apiBaseFromEnv(env: Env = process.env): string {
  const direct = stated(env, 'FORUMULATE_API_URL');
  if (direct) return direct;
  const site = stated(env, 'FORUMULATE_URL');
  if (!site) return DEFAULT_API_BASE;
  return /\/api$/i.test(site) ? site : `${site}/api`;
}

/**
 * The site origin `FORUMULATE_URL` names, or undefined when unset.
 *
 * `doctor` appends `/api/health` itself, so it wants the site and not the API
 * base — handed the old-style `…/api` value it probed `/api/api/health`.
 */
export function siteFromEnv(env: Env = process.env): string | undefined {
  return stated(env, 'FORUMULATE_URL')?.replace(/\/api$/i, '');
}
