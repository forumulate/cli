import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { credentialsPath } from '../credentials';

/**
 * `forumulate config` — defaults a person would otherwise type on every call.
 *
 * Stored beside the credentials (same directory, `FORUMULATE_CONFIG_DIR`
 * honoured) but in its own file: a config is something you paste into a bug
 * report, and a token must never ride along with it.
 *
 * Precedence for every key is flag → environment → this file, so CI that
 * passes `--org` or `FORUMULATE_ORG` is never overridden by a laptop's file.
 */
export const CONFIG_KEYS: Record<string, { env: string; about: string }> = {
  org: { env: 'FORUMULATE_ORG', about: 'default organization (id or slug) for --org' },
  space: { env: 'FORUMULATE_SPACE', about: 'default space (id or slug) for --space' },
  library: { env: 'FORUMULATE_LIBRARY', about: 'default content library for --library' },
  'api-version': {
    env: 'FORUMULATE_API_VERSION',
    about: 'Forumulate-Version header sent by `api` and the resource commands',
  },
};

export type CliConfig = Partial<Record<string, string>>;

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(dirname(credentialsPath(env)), 'config.json');
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): CliConfig {
  try {
    const parsed = JSON.parse(readFileSync(configPath(env), 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as CliConfig) : {};
  } catch {
    return {};
  }
}

export function writeConfig(cfg: CliConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = configPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** flag → env → file. */
export function setting(
  key: keyof typeof CONFIG_KEYS & string,
  flagValue: string | undefined,
  env: NodeJS.ProcessEnv,
  cfg: CliConfig,
): string | undefined {
  const fromEnv = env[CONFIG_KEYS[key]!.env]?.trim();
  return flagValue ?? (fromEnv || undefined) ?? cfg[key];
}

export const CONFIG_HELP = `forumulate config — defaults for every command

Usage:
  forumulate config set <key> <value>
  forumulate config get <key>
  forumulate config unset <key>
  forumulate config list [--json]
  forumulate config path

Keys:
${Object.entries(CONFIG_KEYS)
  .map(([k, v]) => `  ${k.padEnd(12)} ${v.about} (env ${v.env})`)
  .join('\n')}

A flag beats the environment, and the environment beats this file.`;

export function runConfig(
  positionals: string[],
  json: boolean,
  io: { out: (l: string) => void; err: (l: string) => void; env: NodeJS.ProcessEnv },
): number {
  const [verb, key, ...value] = positionals;
  const cfg = readConfig(io.env);
  const known = (k: string | undefined): k is string => {
    if (k && k in CONFIG_KEYS) return true;
    io.err(`Unknown key "${k ?? ''}". Keys: ${Object.keys(CONFIG_KEYS).join(', ')}`);
    return false;
  };
  switch (verb) {
    case 'set': {
      if (!known(key)) return 1;
      if (value.length === 0) {
        io.err(`Usage: forumulate config set ${key} <value>`);
        return 1;
      }
      cfg[key] = value.join(' ');
      const path = writeConfig(cfg, io.env);
      io.out(`${key} = ${cfg[key]}  (${path})`);
      return 0;
    }
    case 'get': {
      if (!known(key)) return 1;
      const v = setting(key, undefined, io.env, cfg);
      if (v === undefined) return 1;
      io.out(v);
      return 0;
    }
    case 'unset': {
      if (!known(key)) return 1;
      delete cfg[key];
      writeConfig(cfg, io.env);
      io.out(`${key} unset`);
      return 0;
    }
    case 'list':
    case undefined: {
      const rows = Object.keys(CONFIG_KEYS).map((k) => {
        const env = io.env[CONFIG_KEYS[k]!.env]?.trim();
        return { key: k, value: env || cfg[k] || '', from: env ? 'env' : cfg[k] ? 'file' : '' };
      });
      if (json)
        io.out(
          JSON.stringify(Object.fromEntries(rows.map((r) => [r.key, r.value || null])), null, 2),
        );
      else
        for (const r of rows)
          io.out(`${r.key.padEnd(12)} ${r.value || '-'}${r.from ? `  (${r.from})` : ''}`);
      return 0;
    }
    case 'path':
      io.out(configPath(io.env));
      return 0;
    default:
      io.out(CONFIG_HELP);
      return verb === 'help' ? 0 : 1;
  }
}

/**
 * The environment the older commands read (`content`, `import`), with the
 * config file's defaults filled in where the environment says nothing — so
 * `config set org` reaches them too without teaching each one to read a file.
 */
export function envWithConfig(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const cfg = readConfig(env);
  const out = { ...env };
  for (const [key, { env: name }] of Object.entries(CONFIG_KEYS))
    if (!out[name]?.trim() && cfg[key]) out[name] = cfg[key];
  return out;
}
