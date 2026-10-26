import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Where a token lives between invocations.
 *
 * The CLI had no `login`: every command needed `FORUMULATE_TOKEN` exported in
 * the shell, which means the token is in the environment of everything else
 * that shell runs, and in the history file of whoever typed it (a customer DX report).
 * A file read by this process alone, mode 0600, is the smaller exposure — and
 * it is what every other CLI a developer already has does.
 *
 * Keyed by API base URL, so a token for staging cannot be sent to production by
 * forgetting to change one variable.
 *
 * `FORUMULATE_TOKEN` still wins over the file when it is set. CI sets it, and a
 * file on disk silently overriding what a pipeline passed in would be the worse
 * surprise. A `--token` on the command line wins over both: it is the most
 * specific thing the caller said.
 */
export interface Credentials {
  /** baseUrl → token. */
  tokens: Record<string, string>;
}

export function credentialsPath(env: NodeJS.ProcessEnv = process.env): string {
  const base =
    env.FORUMULATE_CONFIG_DIR ??
    (env.XDG_CONFIG_HOME
      ? join(env.XDG_CONFIG_HOME, 'forumulate')
      : join(homedir(), '.config', 'forumulate'));
  return join(base, 'credentials.json');
}

export function readCredentials(env: NodeJS.ProcessEnv = process.env): Credentials {
  try {
    const parsed = JSON.parse(readFileSync(credentialsPath(env), 'utf8')) as Partial<Credentials>;
    return { tokens: parsed.tokens ?? {} };
  } catch {
    // No file, unreadable, or not ours to parse: there is no stored token, which
    // is a state and not an error.
    return { tokens: {} };
  }
}

/** Where a token came from (FMU-D06): the answer `whoami` prints first. */
export type TokenSource = 'flag' | 'env' | 'credentials' | 'none';

/**
 * The token for a base URL, and where it was found: `--token` beats
 * `FORUMULATE_TOKEN` beats `credentials.json`. An integrator with one PAT in
 * the shell, another in the file and a third in CI could not tell which one a
 * 401 was about; this is the precedence, said once.
 */
export function resolveTokenSource(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  flagToken?: string,
): { token?: string; source: TokenSource; path?: string } {
  if (flagToken?.trim()) return { token: flagToken.trim(), source: 'flag' };
  if (env.FORUMULATE_TOKEN) return { token: env.FORUMULATE_TOKEN, source: 'env' };
  const stored = readCredentials(env).tokens[normalizeBase(baseUrl)];
  if (stored) return { token: stored, source: 'credentials', path: credentialsPath(env) };
  return { source: 'none' };
}

/**
 * The token for a base URL, by the same precedence as `resolveTokenSource`:
 * `--token`, then the environment, then what `login` stored.
 *
 * This used to skip the flag. `cli.ts` read `--token` for the SDK client only,
 * so `whoami --token x` used x while `items list --token x`, `api …`, `doctor
 * --site` and `validate` (each building its own transport through here) sent
 * `FORUMULATE_TOKEN` or the stored token instead: the documented precedence
 * held for two commands (FMU-DOC01). One resolver, every caller.
 */
export function resolveToken(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  flagToken?: string,
): string | undefined {
  return resolveTokenSource(baseUrl, env, flagToken).token;
}

/**
 * Take the global `--token <pat>` / `--token=<pat>` out of an argument list.
 *
 * The older commands in `run.ts` parse against a fixed list of value flags,
 * so the flag and its value are removed before they see the arguments. The
 * `api` and resource commands get the arguments as given: there an operation
 * that declares a `token` parameter (a registry's, a GitHub connection's)
 * owns the flag, and `api/request.ts` keeps it out of the query string
 * everywhere else. Nothing after `--` is touched; the last `--token` wins, as
 * with every other repeated flag.
 */
export function takeTokenFlag(argv: string[]): { argv: string[]; token?: string } {
  const rest: string[] = [];
  let token: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--') {
      rest.push(...argv.slice(i));
      break;
    }
    if (a.startsWith('--token=')) token = a.slice('--token='.length);
    else if (a === '--token') {
      const next = argv[i + 1];
      // `--token --json` is a missing value, not a token called "--json".
      if (next !== undefined && !next.startsWith('-')) {
        token = next;
        i += 1;
      } else token = '';
    } else rest.push(a);
  }
  const trimmed = token?.trim();
  return { argv: rest, token: trimmed ? trimmed : undefined };
}

export function storeToken(
  baseUrl: string,
  token: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const path = credentialsPath(env);
  const creds = readCredentials(env);
  creds.tokens[normalizeBase(baseUrl)] = token;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  // Explicit, because `writeFileSync`'s mode is ignored for a file that already
  // exists — and the one that already exists is the one with a token in it.
  chmodSync(path, 0o600);
  return path;
}

export function forgetToken(baseUrl: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const creds = readCredentials(env);
  const key = normalizeBase(baseUrl);
  if (!(key in creds.tokens)) return false;
  delete creds.tokens[key];
  const path = credentialsPath(env);
  if (Object.keys(creds.tokens).length === 0) {
    try {
      rmSync(path);
    } catch {
      /* already gone */
    }
    return true;
  }
  writeFileSync(path, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return true;
}

/** One spelling per host: a trailing slash is not a different server. */
export function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '').toLowerCase();
}
