import { parseArgs, flag, has, type Parsed } from './args';
import { describe, expand } from './describe';
import { Http, type HttpRequest } from './http';
import { table } from './output';
import { printRequest, sendAndPrint } from './send';
import { filterOps, findById, findByPath, isMethod, loadIndex, type Operation } from './spec';
import { API_FLAGS, planRequest, UsageError, type RequestSources } from './request';
import type { CommandDeps } from '../commands/context';

/**
 * `forumulate api` — every operation in the API, from the bundled spec.
 *
 *   forumulate api list [--tag Space] [--search webhook]
 *   forumulate api describe Space_create
 *   forumulate api Space_list acme --limit 20
 *   forumulate api GET /orgs/{orgId}/spaces acme --paginate
 *   forumulate api POST /orgs/acme/spaces --data @space.json
 *
 * The resource commands (`spaces`, `webhooks`, …) cover what people do daily;
 * this covers everything else, so a route that ships today is callable today
 * with no CLI release — `operations.test.ts` walks the spec to keep it so.
 */
export const API_HELP = `forumulate api — call any operation in the Forumulate API

Usage:
  forumulate api list [--tag <tag>] [--search <words>] [--method GET]
  forumulate api describe <operationId | METHOD path> [--json]
  forumulate api <operationId> [path params…] [flags]
  forumulate api <METHOD> <path> [path params…] [flags]

Parameters:
  --<name> <value>        a path, query or header parameter (--orgId, --org-id)
  -p, --param name=value  the same, for a name that collides with a flag below
  path params may also be given positionally, in path order; orgId defaults
  to --org / FORUMULATE_ORG / \`forumulate config set org …\`

Body:
  -d, --data '{…}' | @file.json | -   JSON body (- reads stdin)
  -f, --field a.b=value   one field, typed by the body schema (a:=<json> raw)
  --<field> <value>       a top-level body field the operation declares
  --form name=value | name=@file      multipart operations (uploads)

Output and transport:
  --json                  the response body, untouched
  --paginate              follow page.nextCursor to the end (one merged list)
  --max-pages <n>         stop after n pages (default 1000)
  --columns a,b,c         table columns for a list answer
  -i, --include-headers   print the status line and response headers
  -H, --header 'Name: v'  an extra request header
  --api-version <date>    Forumulate-Version to send (default 2026-12-01)
  --idempotency-key <k>   instead of the generated one
  --dry-run               print the request, send nothing

Exit status is 0 on a 2xx and 1 otherwise (usage errors included).`;

const API_SWITCHES = new Set(['json', 'paginate', 'include-headers', 'dry-run', 'help', 'verbose']);

export async function runApi(argv: string[], deps: CommandDeps): Promise<number> {
  const parsed = parseArgs(argv, API_SWITCHES);
  const [first, ...rest] = parsed.positionals;
  const json = has(parsed, 'json');
  if (!first || first === 'help' || (has(parsed, 'help') && first !== 'describe')) {
    deps.out(API_HELP);
    return first || has(parsed, 'help') ? 0 : 1;
  }
  try {
    if (first === 'list' || first === 'ls') return list(parsed, rest, deps, json);
    if (first === 'describe') {
      const target = resolveOp(rest);
      if (!target) return usage(deps, 'api describe <operationId | METHOD path>', rest.join(' '));
      if (json)
        deps.out(
          JSON.stringify(
            { ...target.op, b: undefined, body: target.op.b ? expand(target.op.b) : undefined },
            null,
            2,
          ),
        );
      else for (const l of describe(target.op)) deps.out(l);
      return 0;
    }
    return await invoke(parsed, deps, json);
  } catch (e) {
    if (e instanceof UsageError) {
      deps.err(`Usage: ${e.message}`);
      return 1;
    }
    throw e;
  }
}

function usage(deps: CommandDeps, form: string, got?: string): number {
  if (got) deps.err(`No operation matches "${got}". Try: forumulate api list --search <words>`);
  deps.err(`Usage: forumulate ${form}`);
  return 1;
}

/** `Space_list` or `GET /orgs/{orgId}/spaces` or `GET /orgs/acme/spaces`. */
function resolveOp(
  words: string[],
): { op: Operation; values: Record<string, string>; used: number } | undefined {
  const [a, b] = words;
  if (!a) return undefined;
  if (isMethod(a) && b?.startsWith('/')) {
    const hit = findByPath(a, b);
    return hit && { ...hit, used: 2 };
  }
  const op = findById(a);
  return op && { op, values: {}, used: 1 };
}

function list(parsed: Parsed, rest: string[], deps: CommandDeps, json: boolean): number {
  const ops = filterOps({
    tag: flag(parsed, 'tag'),
    search: [flag(parsed, 'search'), ...rest].filter(Boolean).join(' ') || undefined,
    method: flag(parsed, 'method'),
  });
  if (json) {
    deps.out(
      JSON.stringify(
        ops.map((o) => ({ operationId: o.id, method: o.m, path: o.p, summary: o.s, tags: o.t })),
        null,
        2,
      ),
    );
    return 0;
  }
  if (ops.length === 0) {
    deps.err('No operations match.');
    return 1;
  }
  for (const l of table(
    ops.map((o) => ({ operationId: o.id, method: o.m, path: o.p, summary: o.s ?? '' })),
    ['operationId', 'method', 'path', 'summary'],
  ))
    deps.out(l);
  deps.out(`-- ${ops.length} of ${loadIndex().ops.length} operations`);
  return 0;
}

async function invoke(parsed: Parsed, deps: CommandDeps, json: boolean): Promise<number> {
  const words = parsed.positionals;
  const target = resolveOp(words);
  const src: RequestSources = {
    readFile: deps.readFile,
    readStdin: deps.readStdin,
    defaultOrg: flag(parsed, 'org') ?? deps.defaultOrg,
  };
  let request: HttpRequest;
  let op: Operation | undefined;
  if (target) {
    op = target.op;
    ({ request } = await planRequest(op, parsed, words.slice(target.used), src, target.values));
  } else if (isMethod(words[0]) && words[1]?.startsWith('/')) {
    // A path the bundled spec does not know (a route newer than this CLI):
    // send it as written, unknown flags as query parameters.
    const query: Record<string, string> = {};
    for (const [k, v] of parsed.flags) if (!API_FLAGS.has(k)) query[k] = v.join(',');
    const fake: Operation = {
      id: `${words[0]!.toUpperCase()} ${words[1]}`,
      m: words[0]!.toUpperCase(),
      p: words[1]!.split('?')[0]!,
      b: {},
    };
    const withQuery = {
      ...parsed,
      flags: new Map([...parsed.flags].filter(([k]) => API_FLAGS.has(k))),
    };
    ({ request } = await planRequest(fake, withQuery, words.slice(2), src));
    request.query = {
      ...Object.fromEntries(new URLSearchParams(words[1]!.split('?')[1] ?? '')),
      ...query,
    };
    deps.err(
      `note: ${request.method} ${fake.p} is not in this CLI's bundled spec; sending it as written.`,
    );
  } else {
    return usage(deps, 'api <operationId | METHOD path> [flags]', words.join(' '));
  }

  const http = deps.http;
  if (has(parsed, 'dry-run') && !op?.q?.some((p) => p.n === 'dryRun')) {
    printRequest(http, request, deps);
    return 0;
  }

  await sendAndPrint(
    http,
    request,
    {
      json,
      paginate: has(parsed, 'paginate'),
      maxPages: Number(flag(parsed, 'max-pages') ?? 1000),
      columns: columns(parsed),
      includeHeaders: has(parsed, 'include-headers'),
    },
    deps,
  );
  return 0;
}

const columns = (p: Parsed) => flag(p, 'columns')?.split(',').filter(Boolean);
