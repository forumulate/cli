import { splitFront } from '../publish/frontmatter';
import { slugify } from '../publish/names';
import { EXIT } from '../exit-codes';
import { flag, has, parseArgs, type Parsed } from '../api/args';
import type { HttpRequest } from '../api/http';
import { rowsOf } from '../api/output';
import { norm, planRequest, UsageError } from '../api/request';
import { print, printRequest, sendAndPrint } from '../api/send';
import { bodyProperties, findById, pathParams, type Operation } from '../api/spec';
import { setting } from './config';
import { confirm, isUuid, resolveChild, type CommandDeps } from './context';
import { jobOf, reportWait, timeoutOf, waitForJob } from './job-wait';

/**
 * The resource commands — `spaces list`, `webhooks create`, `tokens rotate` —
 * as DATA over the same operations `forumulate api` calls.
 *
 * Each verb names an operationId and how its positionals map; everything else
 * is derived from the bundled spec, which is why there is no per-command code
 * for flags: every query parameter of the operation is a flag (`--limit`,
 * `--state`), every top-level body field is a flag (`--name`, `--visibility`),
 * and `--data`/`--field` work as they do under `api`. A verb whose operation
 * disappears from the spec fails `operations.test.ts` rather than at a
 * customer's terminal.
 *
 * Consistent across every group:
 *  - `--org` (default from `forumulate config set org`), `--space`, `--library`
 *    accept an id or a slug.
 *  - `list`/`get`/`create`/`update`/`delete` are the verbs where they apply;
 *    `delete` asks first (`--yes` to skip; required with no terminal).
 *  - `--json` prints the API's answer untouched; `--paginate` walks a list.
 */
export interface VerbDef {
  op: string;
  about: string;
  /**
   * Positionals, in order. A path param of the operation fills it
   * (`spaceId`), a query param becomes that flag (`q`), anything else fills
   * that BODY field (`name`, `hostname`), so `spaces create Docs` reads as
   * English. A trailing `...` joins the rest (`search <q...>`).
   */
  args?: string[];
  /** The body field `--file <markdown>` fills (front matter sets title/slug). */
  markdown?: string;
  /** With `--file`, send the body through this operation instead (items: PUT …/content). */
  contentOp?: string;
  destructive?: boolean;
  /**
   * The query flag that makes this write a dry run (`dryRun`): the CLI sends
   * it first, prints the diff the API answers, and asks before the real write
   * unless `--yes` (FMU-D09). For a write that replaces a whole document,
   * where one forgotten key is a removal.
   */
  previewFirst?: string;
  columns?: string[];
  /** Query defaults the operation needs to be useful here (`include=sections,body`). */
  query?: Record<string, string>;
  /** After a create: `--publish` calls this operation on the new id. */
  publishOp?: string;
  /** Print this key of the answer as the list (the status board's `incidents`). */
  pick?: string;
  /** A path param that may be given by name: listed through `listOp`, matched on `match`. */
  lookup?: Record<string, { listOp: string; match: string[] }>;
  /**
   * The multipart field a positional names a LOCAL FILE for (`assets upload
   * ./logo.png`): its bytes are sent, not the path as text.
   */
  upload?: string;
  /**
   * The answer is a file (an SDK archive, a PDF, a CSV export): kept as bytes,
   * written to `--out <file>` (default: this name), or printed when it is
   * text and no `--out` is given.
   */
  download?: string;
  /**
   * Query parameters the route reads but the published spec does not declare
   * (`DELETE /translation-overrides?locale=&key=`). Sent as written, so the
   * command works now; the spec gap is the API's to close.
   */
  extraQuery?: string[];
  /**
   * Body fields of which at least one must be given (`openapi relabel` with no
   * label is a plain resync — a whole regeneration nobody asked for).
   */
  requireOne?: string[];
  /**
   * The command starts a background job (FMU-D03): `--wait [--timeout <s>]`
   * blocks until it is final and exits 0 completed / 1 failed / 124 timeout.
   */
  job?: boolean;
  /** The command IS a wait (`jobs wait <id>`): as if `--wait` were always given. */
  waits?: boolean;
}

export interface GroupDef {
  name: string;
  aliases?: string[];
  /** Singular, for "delete space docs?". */
  noun: string;
  about: string;
  verbs: Record<string, VerbDef>;
  /** Verb used when none is given (e.g. `forumulate members` → list). */
  defaultVerb?: string;
  /** Positionals with no verb go to the default verb (`search rate limits`). */
  bareArgs?: boolean;
}

/** Flags the resource layer consumes; everything else is handed to the operation. */
const OWN = new Set([
  'org',
  'space',
  'library',
  'yes',
  'file',
  'json',
  'columns',
  'help',
  'paginate',
  'max-pages',
  'dry-run',
  'include-headers',
  'publish',
  'out',
  'jsonl',
  'wait',
  'timeout',
]);

export function groupHelp(g: GroupDef): string {
  const lines = [`forumulate ${g.name} — ${g.about}`, '', 'Usage:'];
  for (const [verb, v] of Object.entries(g.verbs)) {
    const op = findById(v.op);
    const args = (v.args ?? []).map((a) => `<${a.replace('...', '…')}>`).join(' ');
    lines.push(
      `  forumulate ${g.name} ${verb}${args ? ` ${args}` : ''}${op ? scopeFlags(op, v) : ''}`,
    );
    lines.push(`      ${v.about}${op ? `  [${op.id}]` : ''}`);
  }
  lines.push(
    '',
    'Every query parameter and top-level body field of the operation is a flag',
    '(see `forumulate api describe <operationId>`). --json prints the raw answer,',
    '--paginate walks a list, --data/--field set a body as under `forumulate api`,',
    '--dry-run prints the request instead of sending it.',
  );
  return lines.join('\n');
}

function scopeFlags(op: Operation, v: VerbDef): string {
  const params = pathParams(op);
  const own = new Set(v.args ?? []);
  const parts: string[] = [];
  if (params.includes('orgId') && !own.has('orgId')) parts.push('[--org <org>]');
  if (params.includes('spaceId') && !own.has('spaceId')) parts.push('--space <space>');
  if (params.includes('libraryId') && !own.has('libraryId')) parts.push('--library <library>');
  if (v.markdown) parts.push('[--file <file.md>]');
  if (v.publishOp) parts.push('[--publish]');
  if (v.job) parts.push('[--wait [--timeout 600]]');
  if (v.download) parts.push(`[--out ${v.download}]`);
  if (v.destructive) parts.push('[--yes]');
  return parts.length ? ` ${parts.join(' ')}` : '';
}

/**
 * Run `forumulate <group> <verb> …`. Returns undefined when `legacy` claims
 * the invocation, so the caller can run the older positional form
 * (`forumulate spaces <orgId>`) that scripts already depend on.
 */
export async function runGroup(
  g: GroupDef,
  argv: string[],
  deps: CommandDeps,
  legacy?: (parsed: Parsed, isVerb: boolean) => boolean,
): Promise<number | undefined> {
  const parsed = parseArgs(argv);
  const [w0, w1, ...more] = parsed.positionals;
  let verb: string | undefined;
  let rest: string[] = [];
  if (w0 && w1 && `${w0} ${w1}` in g.verbs) {
    verb = `${w0} ${w1}`;
    rest = more;
  } else if (w0 && w0 in g.verbs) {
    verb = w0;
    rest = parsed.positionals.slice(1);
  }
  if (w0 === 'help' || (has(parsed, 'help') && (!w0 || verb))) {
    deps.out(groupHelp(g));
    return 0;
  }
  if (legacy?.(parsed, Boolean(verb))) return undefined;
  if (!verb) {
    if (g.defaultVerb && (!w0 || g.bareArgs)) {
      verb = g.defaultVerb;
      rest = parsed.positionals;
    } else {
      const sub = Object.keys(g.verbs).filter((k) => k.startsWith(`${w0} `));
      deps.err(
        w0
          ? `Unknown ${g.name} command: ${w0}${sub.length ? ` (try: ${sub.join(', ')})` : ''}`
          : `Usage: forumulate ${g.name} <command>`,
      );
      deps.out(groupHelp(g));
      return EXIT.USAGE;
    }
  }
  try {
    return await runVerb(g, verb, g.verbs[verb]!, parsed, rest, deps);
  } catch (e) {
    if (e instanceof UsageError) {
      deps.err(`Usage: ${e.message}`);
      return EXIT.USAGE;
    }
    throw e;
  }
}

const src = (deps: CommandDeps) => ({ readFile: deps.readFile, readStdin: deps.readStdin });

async function runVerb(
  g: GroupDef,
  verb: string,
  v: VerbDef,
  parsed: Parsed,
  positionals: string[],
  deps: CommandDeps,
): Promise<number> {
  const op = findById(v.op);
  if (!op) throw new UsageError(`${v.op} is not in this CLI's bundled spec`);
  const params = pathParams(op);
  const queryNames = new Set((op.q ?? []).filter((p) => p.in === 'query').map((p) => p.n));
  const bodyProps = op.b ? bodyProperties(op) : {};
  const preset: Record<string, string> = {};
  const fields: string[] = [];
  const queryArgs: Record<string, string> = {};

  const extra: Record<string, string> = {};
  for (const name of v.extraQuery ?? []) {
    const given = flag(parsed, name);
    if (given !== undefined) extra[name] = given;
  }
  const place = (name: string, value: string) => {
    if (params.includes(name)) preset[name] = value;
    else if (queryNames.has(name)) queryArgs[name] = value;
    else if (v.extraQuery?.includes(name)) extra[name] = value;
    else if (name === v.upload) fields.push(`${name}=@${value}`);
    else fields.push(`${name}=${value}`);
  };
  const queue = [...positionals];
  for (const name of v.args ?? []) {
    if (name.endsWith('...')) {
      if (queue.length) place(name.slice(0, -3), queue.join(' '));
      queue.length = 0;
    } else if (queue.length) place(name, queue.shift()!);
  }
  if (queue.length)
    throw new UsageError(`unexpected argument "${queue.join(' ')}". ${usageLine(g, verb, v)}`);
  const missing = (v.args ?? []).filter((a) => params.includes(a) && !preset[a]);
  if (missing.length) throw new UsageError(usageLine(g, verb, v));
  if (v.requireOne?.length) {
    const want = new Set(v.requireOne.map(norm));
    const named = [...parsed.flags.keys()].some((k) => want.has(norm(k)));
    const asField = [...(parsed.flags.get('field') ?? []), ...(parsed.flags.get('f') ?? [])].some(
      (f) => want.has(norm(f.split(/:?=/)[0] ?? '')),
    );
    if (!named && !asField && !parsed.flags.has('data'))
      throw new UsageError(
        `${usageLine(g, verb, v)} needs at least one of ${v.requireOne
          .map((n) => `--${n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
          .join(', ')}`,
      );
  }

  if (params.includes('orgId') && !preset.orgId) {
    const org = setting('org', flag(parsed, 'org'), deps.env, deps.config);
    if (!org)
      throw new UsageError(
        `${g.name} ${verb} needs --org <id|slug> (or: forumulate config set org <slug>)`,
      );
    preset.orgId = org;
  }
  for (const what of ['space', 'library'] as const) {
    const param = `${what}Id`;
    const given = setting(what, flag(parsed, what), deps.env, deps.config);
    if (params.includes(param)) {
      const ref = preset[param] ?? given;
      if (!ref) throw new UsageError(`${g.name} ${verb} needs --${what} <id|slug>`);
      preset[param] = await resolveChild(deps, what, preset.orgId!, ref);
    } else if (param in bodyProps && flag(parsed, what) && preset.orgId) {
      // `webhooks create --space docs`: the space is a body field there.
      fields.push(`${param}=${await resolveChild(deps, what, preset.orgId, flag(parsed, what)!)}`);
    }
  }
  for (const [param, how] of Object.entries(v.lookup ?? {}))
    if (preset[param]) preset[param] = await lookup(deps, how, preset, preset[param]!);

  const forwarded: Parsed = {
    positionals: [],
    flags: new Map([...parsed.flags].filter(([k]) => !OWN.has(k) && !v.extraQuery?.includes(k))),
  };
  for (const [k, val] of Object.entries({ ...v.query, ...queryArgs }))
    if (!forwarded.flags.has(k) || k in queryArgs) forwarded.flags.set(k, [val]);

  // `--file page.md`: the body, and title/slug from its front matter unless given.
  const file = flag(parsed, 'file');
  let content: string | undefined;
  if (file && !v.markdown) throw new UsageError(`${g.name} ${verb} takes no --file`);
  if (file) {
    const { data, body } = splitFront(String(deps.readFile(file)));
    content = body;
    for (const k of ['title', 'slug']) {
      const given = forwarded.flags.has(k) || fields.some((f) => f.startsWith(`${k}=`));
      if (!given && typeof data[k] === 'string' && k in bodyProps)
        fields.push(`${k}=${data[k] as string}`);
    }
  }
  if (content !== undefined && !v.contentOp) fields.push(`${v.markdown}=${content}`);
  if (fields.length)
    forwarded.flags.set('field', [...fields, ...(forwarded.flags.get('field') ?? [])]);

  const requests: HttpRequest[] = [];
  if (content !== undefined && v.contentOp) {
    const cop = findById(v.contentOp)!;
    const contentFlags: Parsed = {
      positionals: [],
      flags: new Map([['field', [`${v.markdown}=${content}`]]]),
    };
    requests.push((await planRequest(cop, contentFlags, [], src(deps), preset)).request);
  }
  // With `--file` and nothing else to change, the content write is the whole command.
  if (!(v.contentOp && content !== undefined && forwarded.flags.size === 0))
    requests.push((await planRequest(op, forwarded, [], src(deps), preset)).request);
  const main = requests.at(-1)!;
  if (Object.keys(extra).length) main.query = { ...main.query, ...extra };
  if (v.download) main.raw = true;

  if (has(parsed, 'dry-run')) {
    for (const r of requests) printRequest(deps.http, r, deps);
    return 0;
  }
  if (v.destructive) {
    const target =
      Object.entries(preset)
        .filter(([k]) => k !== 'orgId')
        .at(-1)?.[1] ?? preset.orgId;
    if (!(await confirm(deps, has(parsed, 'yes'), `${verb} ${g.noun} ${target}?`))) return 1;
  }
  if (v.previewFirst && !has(parsed, 'yes')) {
    const preview = await deps.http.send({
      ...main,
      query: { ...main.query, [v.previewFirst]: 'true' },
    });
    const diff = (preview.data as { diff?: unknown[] } | undefined)?.diff ?? [];
    deps.err(`This ${verb} would change ${diff.length} key(s):`);
    for (const d of diff.slice(0, 200)) deps.err(`  ${typeof d === 'string' ? d : JSON.stringify(d)}`);
    if (diff.length === 0) {
      deps.err('Nothing to change.');
      return EXIT.OK;
    }
    if (!(await confirm(deps, false, `Apply this ${verb} to ${g.noun}?`))) return EXIT.USAGE;
  }
  const json = has(parsed, 'json');
  const opts = {
    json,
    paginate: has(parsed, 'paginate'),
    jsonl: has(parsed, 'jsonl'),
    maxPages: Number(flag(parsed, 'max-pages') ?? 1000),
    columns: flag(parsed, 'columns')?.split(',') ?? v.columns,
    includeHeaders: has(parsed, 'include-headers'),
  };
  if (v.download) return download(deps, main, v.download, flag(parsed, 'out'));
  const wantWait = v.waits || has(parsed, 'wait');
  if (wantWait && !v.job && !v.waits)
    throw new UsageError(`${g.name} ${verb} starts no background job, so there is nothing to --wait for`);
  if (wantWait) {
    // Quiet until the end: one answer on stdout (the final job), progress on stderr.
    let answer: unknown;
    for (const request of requests) answer = (await deps.http.send(request)).data;
    const job = jobOf(answer);
    // No job in the answer: the work finished inline, which is "completed".
    if (!job) {
      print(answer, opts, deps);
      return EXIT.OK;
    }
    const outcome = await waitForJob(deps, preset.orgId!, job, {
      timeoutSeconds: timeoutOf(flag(parsed, 'timeout')),
    });
    return reportWait(deps, outcome, json);
  }
  let result: unknown;
  for (const request of requests) {
    if (v.pick && !opts.paginate) {
      const res = await deps.http.send(request);
      result = res.data;
      const picked = (res.data as Record<string, unknown> | undefined)?.[v.pick];
      print(json ? picked : { [v.pick]: picked ?? [] }, opts, deps);
    } else result = await sendAndPrint(deps.http, request, opts, deps);
  }
  if (v.publishOp && has(parsed, 'publish')) {
    const id = createdId(result);
    const pub = findById(v.publishOp);
    if (!id || !pub) throw new Error('Created, but the answer carried no id to publish.');
    const last = pathParams(pub).at(-1)!;
    const { request } = await planRequest(
      pub,
      { positionals: [], flags: new Map() },
      [],
      src(deps),
      { ...preset, [last]: id },
    );
    await deps.http.send(request);
    if (!json) deps.out(`Published ${id}.`);
  }
  return 0;
}

/**
 * A file answer: to `--out`, or to the terminal when it is text. A binary
 * answer printed to a terminal is noise, and to a pipe it is corrupted by the
 * line handling, so with no `--out` it lands in the suggested file instead.
 */
async function download(
  deps: CommandDeps,
  request: HttpRequest,
  suggested: string,
  out: string | undefined,
): Promise<number> {
  const res = await deps.http.send(request);
  const bytes = res.data as Buffer;
  const type = res.headers.get('content-type') ?? '';
  const text = /^text\/|json|xml|csv|svg|markdown/.test(type);
  if (!out && text) {
    deps.out(bytes.toString('utf8').replace(/\n$/, ''));
    return 0;
  }
  const file = out ?? suggested;
  deps.writeFile(file, bytes);
  deps.err(`Wrote ${bytes.length} bytes to ${file}.`);
  return 0;
}

/** The id of what a create made: `data` (the uniform create envelope), else the named resource. */
function createdId(result: unknown): string | undefined {
  const r = result as Record<string, unknown> | undefined;
  const data = r?.data as { id?: string } | undefined;
  if (data?.id) return data.id;
  for (const v of Object.values(r ?? {}))
    if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string')
      return (v as { id: string }).id;
  return undefined;
}

/** `tokens revoke ci-deploy` → the token whose name is `ci-deploy`. */
async function lookup(
  deps: CommandDeps,
  how: { listOp: string; match: string[] },
  preset: Record<string, string>,
  ref: string,
): Promise<string> {
  if (isUuid(ref)) return ref;
  const listOp = findById(how.listOp);
  if (!listOp) return ref;
  const { request } = await planRequest(
    listOp,
    { positionals: [], flags: new Map() },
    [],
    src(deps),
    preset,
  );
  const rows = (rowsOf((await deps.http.send(request)).data)?.rows ?? []) as Record<
    string,
    unknown
  >[];
  /*
   * A name, or the slug a person would type for it: `openapi relabel
   * referally-api` names the spec registered as "Referally API" (FMU-D10).
   * Things without a slug of their own are still called by one in a terminal.
   */
  // The CLI's mirror of the shared address rule (publish/names.ts), uncapped.
  const slugish = (v: string) => slugify(v, '', 200);
  const hits = rows.filter(
    (r) =>
      r.id === ref ||
      how.match.some((m) => String(r[m] ?? '').toLowerCase() === ref.toLowerCase()) ||
      how.match.some((m) => r[m] != null && slugish(String(r[m])) === slugish(ref)),
  );
  if (hits.length === 1) return String(hits[0]!.id);
  if (hits.length > 1) throw new UsageError(`"${ref}" matches ${hits.length}; pass the id`);
  return ref; // Not a name we know: let the API answer for the id as given.
}

function usageLine(g: GroupDef, verb: string, v: VerbDef): string {
  return `forumulate ${g.name} ${verb}${(v.args ?? []).map((a) => ` <${a.replace('...', '…')}>`).join('')}`;
}
