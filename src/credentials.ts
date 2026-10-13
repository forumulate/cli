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
 * `FORUMULATE_TOKEN` still wins when it is set. CI sets it, and a file on disk
 * silently overriding what a pipeline passed in would be the worse surprise.
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

/** The token for a base URL: the environment first, then what `login` stored. */
export function resolveToken(
  baseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (env.FORUMULATE_TOKEN) return env.FORUMULATE_TOKEN;
  return readCredentials(env).tokens[normalizeBase(baseUrl)];
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
