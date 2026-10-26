import { parseArgs, flag, has, type Parsed } from './args';
import { EXIT } from '../exit-codes';
import { describe, expand } from './describe';
import { Http, type HttpRequest } from './http';
import { table } from './output';
import { printRequest, sendAndPrint } from './send';
import {
  filterOps,
  findById,
  findByPath,
  isMethod,
  loadIndex,
  setIndex,
  type Operation,
} from './spec';
import { readLive, refreshLive } from './live-spec';
import { VERSION } from '../version';

/** Named in the footer so "1,810 operations" says which CLI counted them. */
const VERSION_LABEL = `@forumulate/cli ${VERSION}`;
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
  forumulate api list [--tag <tag>] [--search <words>] [--method GET] [--refresh]
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

Operation list:
  --refresh               fetch the live API's spec (ETag-revalidated) and use it
                          from now on; the bundled list is the one this CLI was
                          built with, and the API keeps growing after a release

Output and exit:
  --jsonl                 with --paginate: one JSON row per line, streamed
  --out <file>            write the output to a file
  Exit 0 on a 2xx; 2 usage, 3 auth (401/403), 4 not found, 5 conflict (409/412),
  1 anything else.`;

const API_SWITCHES = new Set([
  'json',
  'jsonl',
  'paginate',
  'include-headers',
  'dry-run',
  'help',
  'verbose',
  'refresh',
]);

export async function runApi(argv: string[], deps: CommandDeps): Promise<number> {
  const parsed = parseArgs(argv, API_SWITCHES);
  const [first, ...rest] = parsed.positionals;
  const json = has(parsed, 'json');
  if (!first || first === 'help' || (has(parsed, 'help') && first !== 'describe')) {
    deps.out(API_HELP);
    return first || has(parsed, 'help') ? 0 : 1;
  }
  // The newer of the bundled index and a refreshed live one (FMU-D13).
  const source = await chooseIndex(parsed, deps);
  if (typeof source === 'number') return source;
  try {
    if (first === 'list' || first === 'ls') return list(parsed, rest, deps, json, source);
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
      return EXIT.USAGE;
    }
    throw e;
  }
}

function usage(deps: CommandDeps, form: string, got?: string): number {
  if (got) deps.err(`No operation matches "${got}". Try: forumulate api list --search <words>`);
  deps.err(`Usage: forumulate ${form}`);
  return EXIT.USAGE;
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

/** Which index this invocation runs from, and how to describe it in the footer. */
interface IndexSource {
  label: string;
}

async function chooseIndex(parsed: Parsed, deps: CommandDeps): Promise<IndexSource | number> {
  const apiBase = deps.http.opts.baseUrl;
  setIndex(undefined);
  const bundled = loadIndex().ops.length;
  if (has(parsed, 'refresh')) {
    try {
      const r = await refreshLive(apiBase, { env: deps.env });
      deps.err(
        r.changed
          ? `Fetched the live spec from ${r.meta.url}: ${r.meta.ops} operations (this CLI bundles ${bundled}).`
          : `The live spec has not changed since ${r.meta.fetchedAt.slice(0, 10)} (304).`,
      );
    } catch (e) {
      deps.err(`Could not refresh the operation list: ${(e as Error).message}`);
      return EXIT.FAILED;
    }
  }
  const live = readLive(apiBase, deps.env);
  if (live && live.meta.ops >= bundled) {
    setIndex(live.index);
    return { label: `live spec, fetched ${live.meta.fetchedAt.slice(0, 16).replace('T', ' ')}` };
  }
  return {
    label: `bundled with this CLI (${VERSION_LABEL}); the live API may have more — run \`forumulate api list --refresh\``,
  };
}

function list(
  parsed: Parsed,
  rest: string[],
  deps: CommandDeps,
  json: boolean,
  source: IndexSource,
): number {
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
    return EXIT.NOT_FOUND;
  }
  for (const l of table(
    ops.map((o) => ({ operationId: o.id, method: o.m, path: o.p, summary: o.s ?? '' })),
    ['operationId', 'method', 'path', 'summary'],
  ))
    deps.out(l);
  deps.out(`-- ${ops.length} of ${loadIndex().ops.length} operations (${source.label})`);
  return 0;
}

/**
 * Whether `--dry-run` belongs to the operation rather than to the CLI.
 *
 * A handful of writes have a dry run of their own that answers a DIFF
 * (`Site_replace`, the front pages), and `--dry-run` reaches those. Since
 * FMU-SI06 every authenticated write also carries the API's GENERIC `dryRun`
 * (validate, write nothing), and reading that as "the operation's own" turned
 * the documented "print the request, send nothing" into a live call for
 * ~1,200 operations — needing a token and a network. The generic one is
 * reachable as `--param dryRun=true`; it is told apart by the description
 * the API stamps on every copy of it (openapi-orchestration.ts).
 */
const GENERIC_DRY_RUN = '`true`: authenticate, authorize and validate this request';
function ownDryRun(op: Operation): boolean {
  return (op.q ?? []).some((p) => p.n === 'dryRun' && !(p.d ?? '').startsWith(GENERIC_DRY_RUN));
}

function withoutFlag(parsed: Parsed, name: string): Parsed {
  return { ...parsed, flags: new Map([...parsed.flags].filter(([k]) => k !== name)) };
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
    // A local dry run must not ALSO become the operation's `dryRun=true` —
    // printed, it is a request the user never meant to send.
    const planned = has(parsed, 'dry-run') && !ownDryRun(op) ? withoutFlag(parsed, 'dry-run') : parsed;
    ({ request } = await planRequest(op, planned, words.slice(target.used), src, target.values));
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
  if (has(parsed, 'dry-run') && !(op && ownDryRun(op))) {
    printRequest(http, request, deps);
    return 0;
  }

  await sendAndPrint(
    http,
    request,
    {
      json,
      paginate: has(parsed, 'paginate'),
      jsonl: has(parsed, 'jsonl'),
      maxPages: Number(flag(parsed, 'max-pages') ?? 1000),
      columns: columns(parsed),
      includeHeaders: has(parsed, 'include-headers'),
    },
    deps,
  );
  return 0;
}

const columns = (p: Parsed) => flag(p, 'columns')?.split(',').filter(Boolean);
