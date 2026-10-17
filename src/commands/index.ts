import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs, flag, has } from '../api/args';
import { runApi } from '../api/command';
import { Http, formatError } from '../api/http';
import { apiBaseFromEnv } from '../api-base';
import { resolveToken } from '../credentials';
import { readConfig, runConfig, setting, CONFIG_HELP } from './config';
import { complete, completionScript } from './completion';
import type { CommandDeps } from './context';
import { findGroup } from './groups';
import { runGroup } from './resource';

/**
 * The commands added for API parity — `api`, `config`, `completion`, and the
 * resource groups — routed before the older `switch` in `run.ts`.
 *
 * Returns undefined for anything it does not own, and for the older
 * positional forms (`spaces <orgId>`, `items <orgId> <spaceId>`,
 * `search <orgId> <query…>`, `domains [verify] <orgId> <spaceId>`), which keep
 * their exact output: scripts parse it.
 */
export interface RouteDeps {
  out: (l: string) => void;
  err: (l: string) => void;
  env?: NodeJS.ProcessEnv;
  baseUrl?: string;
  http?: Http;
  ask?: (q: string) => Promise<string>;
  readFile?: (path: string) => string | Buffer;
  writeFile?: (path: string, data: Buffer | string) => void;
  readStdin?: () => Promise<string>;
  userAgent?: string;
}

export function readAllStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (text += c));
    process.stdin.on('end', () => resolve(text));
    process.stdin.on('error', reject);
  });
}

function commandDeps(argv: string[], deps: RouteDeps): CommandDeps {
  const env = deps.env ?? process.env;
  const config = readConfig(env);
  const parsed = parseArgs(argv);
  const baseUrl = deps.baseUrl ?? apiBaseFromEnv(env);
  const onRetry = ({ waitMs, status }: { waitMs: number; status?: number }) =>
    deps.err(
      `${status ? `HTTP ${status}` : 'Connection failed'}; retrying in ${Math.ceil(waitMs / 1000)}s…`,
    );
  const apiVersion = setting('api-version', flag(parsed, 'api-version'), env, config);
  const http = deps.http
    ? new Http({ onRetry, ...deps.http.opts, ...(apiVersion ? { apiVersion } : {}) })
    : new Http({
        baseUrl,
        token: resolveToken(baseUrl, env),
        userAgent: deps.userAgent ?? '@forumulate/cli',
        apiVersion,
        onRetry,
      });
  return {
    http,
    out: deps.out,
    err: deps.err,
    env,
    config,
    ask: deps.ask,
    readFile: deps.readFile ?? ((p) => readFileSync(p)),
    writeFile: deps.writeFile ?? ((p, d) => writeFileSync(p, d)),
    readStdin: deps.readStdin ?? readAllStdin,
    defaultOrg: setting('org', undefined, env, config),
  };
}

export async function route(
  cmd: string,
  argv: string[],
  deps: RouteDeps,
): Promise<number | undefined> {
  // Everything after the command word; flags before it are kept.
  const at = argv.indexOf(cmd);
  const tail = [...argv.slice(0, at), ...argv.slice(at + 1)];
  if (cmd === '__complete') {
    for (const c of complete(tail)) deps.out(c);
    return 0;
  }
  if (cmd === 'completion') {
    const script = completionScript(tail.find((a) => !a.startsWith('-')) ?? '');
    if (!script) {
      deps.err('Usage: forumulate completion bash|zsh|fish');
      return 1;
    }
    deps.out(script);
    return 0;
  }
  if (cmd === 'config') {
    const p = parseArgs(tail);
    if (has(p, 'help')) {
      deps.out(CONFIG_HELP);
      return 0;
    }
    return runConfig(p.positionals, has(p, 'json'), {
      out: deps.out,
      err: deps.err,
      env: deps.env ?? process.env,
    });
  }
  const group = findGroup(cmd);
  if (cmd !== 'api' && !group) return undefined;
  const ctx = commandDeps(tail, deps);
  try {
    if (cmd === 'api') return await runApi(tail, ctx);
    const orgKnown = (p: ReturnType<typeof parseArgs>) =>
      Boolean(setting('org', flag(p, 'org'), ctx.env, ctx.config));
    const legacy: Parameters<typeof runGroup>[3] = (p, isVerb) => {
      if (isVerb)
        return (
          group!.name === 'domains' && p.positionals[0] === 'verify' && p.positionals.length >= 3
        );
      const n = p.positionals.length;
      switch (group!.name) {
        case 'orgs':
          return n === 0;
        case 'spaces':
          return n > 0 || !orgKnown(p);
        case 'items':
          return n > 0;
        case 'search':
          return !orgKnown(p);
        case 'domains':
          return n >= 2;
        default:
          return false;
      }
    };
    return await runGroup(group!, tail, ctx, legacy);
  } catch (e) {
    for (const l of formatError(e)) deps.err(l);
    return 1;
  }
}
