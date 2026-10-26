import { apiBaseFromEnv } from './api-base';
import { resolveTokenSource, type TokenSource } from './credentials';
import { EXIT, EXIT_CODES_HELP, exitCodeForError } from './exit-codes';

/**
 * `forumulate whoami` and `forumulate auth status` (FMU-D06).
 *
 * `whoami` printed a name and an email. The Referalli integrator had a PAT in
 * `FORUMULATE_TOKEN`, an older one in `credentials.json` and a third in CI,
 * plus `FORUMULATE_BASE` exported from a tutorial — a variable nothing reads —
 * and spent an afternoon on a 401 that any of the four could have caused. This
 * prints the token's source, which PAT it is (id, name, last four characters),
 * when it expires, everything it is narrowed to, and the API it was sent to;
 * and it names every `FORUMULATE_*` variable in the environment that nothing
 * reads, with the one it was probably meant to be.
 */

/** Every variable the CLI, the SDK and the MCP server read. */
export const KNOWN_ENV = [
  'FORUMULATE_TOKEN',
  'FORUMULATE_URL',
  'FORUMULATE_API_URL',
  'FORUMULATE_ORG',
  'FORUMULATE_SPACE',
  'FORUMULATE_LIBRARY',
  'FORUMULATE_API_VERSION',
  'FORUMULATE_CONFIG_DIR',
  'FORUMULATE_MCP',
  'FORUMULATE_MCP_URL',
] as const;

/** Spellings people reach for, mapped to the variable they meant. */
const ALIASES: Record<string, string> = {
  FORUMULATE_BASE: 'FORUMULATE_URL',
  FORUMULATE_BASE_URL: 'FORUMULATE_URL',
  FORUMULATE_HOST: 'FORUMULATE_URL',
  FORUMULATE_SITE: 'FORUMULATE_URL',
  FORUMULATE_ENDPOINT: 'FORUMULATE_API_URL',
  FORUMULATE_API: 'FORUMULATE_API_URL',
  FORUMULATE_API_BASE: 'FORUMULATE_API_URL',
  FORUMULATE_PAT: 'FORUMULATE_TOKEN',
  FORUMULATE_API_KEY: 'FORUMULATE_TOKEN',
  FORUMULATE_KEY: 'FORUMULATE_TOKEN',
  FORUMULATE_ACCESS_TOKEN: 'FORUMULATE_TOKEN',
  FORUMULATE_ORGANIZATION: 'FORUMULATE_ORG',
  FORUMULATE_ORG_ID: 'FORUMULATE_ORG',
  FORUMULATE_SPACE_ID: 'FORUMULATE_SPACE',
  FORUMULATE_VERSION: 'FORUMULATE_API_VERSION',
};

function distance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0]![j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      d[i]![j] = Math.min(
        d[i - 1]![j]! + 1,
        d[i]![j - 1]! + 1,
        d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
  return d[a.length]![b.length]!;
}

/** `FORUMULATE_*` names nothing reads, each with its likely meaning (or none). */
export function unknownEnv(env: NodeJS.ProcessEnv): { name: string; didYouMean?: string }[] {
  const known = new Set<string>(KNOWN_ENV);
  return Object.keys(env)
    .filter((k) => k.startsWith('FORUMULATE_') && !known.has(k))
    .sort()
    .map((name) => {
      if (ALIASES[name]) return { name, didYouMean: ALIASES[name] };
      const best = [...known]
        .map((k) => ({ k, d: distance(name, k) }))
        .sort((x, y) => x.d - y.d)[0];
      return best && best.d <= 4 ? { name, didYouMean: best.k } : { name };
    });
}

/** The warning lines for unknown variables — printed by every command, on stderr. */
export function envWarnings(env: NodeJS.ProcessEnv): string[] {
  return unknownEnv(env).map(
    (u) =>
      `warning: ${u.name} is not read by forumulate${u.didYouMean ? `; did you mean ${u.didYouMean}?` : '.'}`,
  );
}

export interface WhoamiDeps {
  out: (l: string) => void;
  err: (l: string) => void;
  env: NodeJS.ProcessEnv;
  baseUrl?: string;
  /** `--token`, when given. */
  flagToken?: string;
  /** GET /auth/me with the resolved token (injected for tests). */
  me: () => Promise<{
    user: { id: string; name: string; email: string };
    token?: Record<string, unknown>;
  }>;
}

export const WHOAMI_HELP = `forumulate whoami — who the CLI is acting as, and with which token

Usage:
  forumulate whoami [--json] [--token <pat>]
  forumulate auth status [--json]          the same report, for scripts

Prints:
  user          name, email and id
  token source  --token flag | FORUMULATE_TOKEN | credentials.json (with its path)
  token         the PAT's id, name, last four characters, created, expires
  narrowed to   scopes, spaces, capabilities, constraints
  api           the API base the token was sent to (FORUMULATE_API_URL, FORUMULATE_URL
                or the default)
  warnings      every FORUMULATE_* variable nothing reads, with the one it was
                probably meant to be (FORUMULATE_BASE → FORUMULATE_URL)

Precedence: --token beats FORUMULATE_TOKEN beats the token \`forumulate login\` stored
for this API. Guide: https://forumulate.com/guides/api-tokens-and-scopes

${EXIT_CODES_HELP}`;

export async function runWhoami(json: boolean, deps: WhoamiDeps): Promise<number> {
  const apiBase = deps.baseUrl ?? apiBaseFromEnv(deps.env);
  const where = resolveTokenSource(apiBase, deps.env, deps.flagToken);
  const warnings = unknownEnv(deps.env);
  const report: {
    apiBase: string;
    tokenSource: TokenSource;
    credentialsPath?: string;
    user?: { id: string; name: string; email: string };
    token?: Record<string, unknown>;
    warnings: { name: string; didYouMean?: string }[];
    error?: { status?: number; code?: string; message: string };
  } = {
    apiBase,
    tokenSource: where.source,
    ...(where.path ? { credentialsPath: where.path } : {}),
    warnings,
  };
  let code: number = EXIT.OK;
  if (where.source === 'none') {
    report.error = { message: 'No token: run `forumulate login`, set FORUMULATE_TOKEN, or pass --token.' };
    code = EXIT.AUTH;
  } else {
    try {
      const me = await deps.me();
      report.user = me.user;
      if (me.token) report.token = me.token;
    } catch (e) {
      const err = e as { status?: number; code?: string; message?: string };
      report.error = { status: err.status, code: err.code, message: err.message ?? String(e) };
      code = exitCodeForError(e);
    }
  }
  if (json) {
    deps.out(JSON.stringify(report, null, 2));
    return code;
  }
  const t = report.token ?? {};
  const label: Record<TokenSource, string> = {
    flag: '--token flag',
    env: 'FORUMULATE_TOKEN (environment)',
    credentials: `credentials.json (${where.path ?? ''})`,
    none: 'none',
  };
  if (report.user) deps.out(`${report.user.name} <${report.user.email}> (${report.user.id})`);
  deps.out(`token source  ${label[where.source]}`);
  if (report.token) {
    deps.out(
      `token         ${t.name ?? '(unnamed)'}  id ${t.id ?? '—'}  …${t.last4 ?? '????'}`,
    );
    deps.out(`created       ${t.createdAt ?? '—'}`);
    deps.out(`expires       ${t.expiresAt ?? 'never'}`);
    deps.out(`scopes        ${(t.scopes as string[] | undefined)?.join(', ') || '—'}`);
    deps.out(`spaces        ${(t.spaceIds as string[] | null | undefined)?.join(', ') ?? 'all'}`);
    deps.out(
      `capabilities  ${(t.capabilities as string[] | null | undefined)?.join(', ') ?? 'not narrowed'}`,
    );
    deps.out(`constraints   ${t.constraints ? JSON.stringify(t.constraints) : 'none'}`);
  } else if (report.user) deps.out('token         a session, not a personal access token');
  deps.out(`api           ${apiBase}`);
  for (const w of warnings)
    deps.err(
      `warning: ${w.name} is not read by forumulate${w.didYouMean ? `; did you mean ${w.didYouMean}?` : '.'}`,
    );
  if (report.error)
    deps.err(
      `Error${report.error.status ? ` ${report.error.status}` : ''}${report.error.code ? ` (${report.error.code})` : ''}: ${report.error.message}`,
    );
  return code;
}
