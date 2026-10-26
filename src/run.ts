import type { ForumulateClient } from '@forumulate/sdk';
import { runConformance } from './conformance';
import { runDoctorCommand } from './doctor/command';
import { runValidateCommand } from './validate';
import { forgetToken, storeToken, takeTokenFlag } from './credentials';
import { runFolder, runPublishCli } from './publish-command';
import { runPlanCommand } from './plan/command';
import { runWhoami } from './whoami';
import { COMMAND_HELP } from './help-commands';
import { EXIT, exitCodeForError } from './exit-codes';
import { runDev } from './dev/command';
import { apiBaseFromEnv } from './api-base';
import { CONTENT_VALUE_FLAGS, runContent, type ContentDeps } from './content/command';
import { orgRows } from './content/library';
import { IMPORT_VALUE_FLAGS, runImportCommand } from './import/command';
import { runTranslations, TRANSLATIONS_VALUE_FLAGS } from './translations/command';
import { CHECK_VALUE_FLAGS, runCheck } from './check/command';
import type { SyncFiles } from './translations/sync';
import { HELP } from './help';
import { route } from './commands';
import { envWithConfig } from './commands/config';
import type { Http } from './api/http';

import { VERSION } from './version';
export { VERSION };

export interface RunDeps {
  /** The API client. Injected so the CLI is testable without a live server. */
  client: ForumulateClient;
  out: (line: string) => void;
  err: (line: string) => void;
  /**
   * The API this invocation is talking to, and how it reads a secret the user
   * types. Both injected for the same reason the client is: `login` writes a
   * file and reads a terminal, and a test must be able to do neither.
   */
  baseUrl?: string;
  prompt?: (question: string) => Promise<string>;
  env?: NodeJS.ProcessEnv;
  /**
   * Whether a token was found. A directory publish reads the PUBLIC space
   * without one (`--dry-run` only) instead of failing on the first 401.
   * Absent means yes — a test's fake client stands for an authenticated one.
   */
  authed?: boolean;
  /** Multipart POST (asset uploads) — the one call the SDK's JSON `request` cannot make. */
  upload?: (path: string, form: FormData) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
  /** A visible y/N question (`content push`); `prompt` hides what is typed, which suits a token only. */
  ask?: (question: string) => Promise<string>;
  /** File access for `content`, injected so its tests touch no disk. */
  files?: ContentDeps['files'];
  /**
   * The transport `api` and the resource commands use (see `api/http.ts` for
   * why it is not the SDK's). Built from `baseUrl` and the stored token when
   * absent; a test passes one aimed at its fake server.
   */
  http?: Http;
  readFile?: (path: string) => string | Buffer;
  /** Where `--out` writes a downloaded file (tests capture it). */
  writeFile?: (path: string, data: Buffer | string) => void;
  readStdin?: () => Promise<string>;
  userAgent?: string;
  /** File access for `translations pull|push`, which also walks a folder. */
  translationFiles?: SyncFiles;
}

/** Flags that take a value, so `--only intro` does not read `intro` as an argument. */
const VALUE_FLAGS = new Set([
  '--port',
  '--site',
  '--token',
  '--org',
  '--space',
  '--manifest',
  '--only',
  '--pace',
  '--purge',
  '--batch',
  ...CHECK_VALUE_FLAGS,
  ...CONTENT_VALUE_FLAGS,
  ...IMPORT_VALUE_FLAGS,
  ...TRANSLATIONS_VALUE_FLAGS,
]);

/**
 * Parse and execute a CLI invocation. Pure w.r.t. I/O (uses the injected deps),
 * so it can be unit-tested with a fake client. Returns a process exit code.
 */
/**
 * `publish|sync --preview <name> [--preview-ttl <days>]` (FMU-F01). Value flags
 * for those two commands only: `content types --preview` is a switch, and a
 * global entry would swallow the argument after it there.
 */
const PUBLISH_VALUE_FLAGS = ['--preview', '--preview-ttl'];

export async function run(argvIn: string[], deps: RunDeps): Promise<number> {
  /*
   * `--token` is global (FMU-DOC01): taken out here, before the commands below
   * parse their arguments, and handed to every transport this run builds. It
   * used to reach only the SDK client, so the commands that build their own
   * transport (`api`, the resource groups, `validate`, `doctor --site`) sent
   * FORUMULATE_TOKEN or the stored token instead of the one on the line.
   */
  const { argv, token: flagToken } = takeTokenFlag(argvIn);
  const word = argv.find((a) => !a.startsWith('-'));
  const valueFlags =
    word === 'publish' || word === 'sync' ? new Set([...VALUE_FLAGS, ...PUBLISH_VALUE_FLAGS]) : VALUE_FLAGS;
  const args = argv.filter(
    (a, i) =>
      !a.startsWith('--') && !(valueFlags.has(argv[i - 1] ?? '') && !argv[i - 1]!.includes('=')),
  );
  const flags = new Set(argv.filter((a) => a.startsWith('--')).map((a) => a.split('=')[0]!));
  /** `--token=abc` or `--token abc`, for the flags that carry a value. */
  const flagValue = (name: string): string | undefined => {
    const inline = argv.find((a) => a.startsWith(`${name}=`));
    if (inline) return inline.slice(name.length + 1);
    const at = argv.indexOf(name);
    return at >= 0 ? argv[at + 1] : undefined;
  };
  const json = flags.has('--json');
  const [cmd, ...rest] = args;

  /*
   * `api`, `config`, `completion` and the resource groups first: `api` passes
   * `--version` and `--help` on to operations that declare them, and the
   * groups keep the older positional forms below by handing them back.
   */
  if (cmd && !(flags.has('--version') && cmd !== 'api')) {
    // The arguments as given: an operation with a `token` parameter of its own
    // owns `--token` there (commands/index.ts), and the bearer is the usual one.
    const routed = await route(cmd, argvIn, {
      out: deps.out,
      err: deps.err,
      env: deps.env,
      baseUrl: deps.baseUrl,
      http: deps.http,
      ask: deps.ask,
      readFile: deps.readFile,
      writeFile: deps.writeFile,
      readStdin: deps.readStdin,
      userAgent: deps.userAgent ?? `@forumulate/cli/${VERSION}`,
      token: flagToken,
    });
    if (routed !== undefined) return routed;
  }

  if (flags.has('--version')) {
    deps.out(VERSION);
    return 0;
  }
  // A command's own help, never the global page (FMU-B14).
  if (cmd && flags.has('--help') && COMMAND_HELP[cmd]) {
    deps.out(COMMAND_HELP[cmd]!);
    return EXIT.OK;
  }
  if (cmd === 'help' && rest[0] && COMMAND_HELP[rest[0]]) {
    deps.out(COMMAND_HELP[rest[0]]!);
    return EXIT.OK;
  }
  if (!cmd || cmd === 'help' || flags.has('--help')) {
    deps.out(HELP);
    return cmd && cmd !== 'help' && !flags.has('--help') ? EXIT.USAGE : EXIT.OK;
  }

  const dump = (v: unknown) => deps.out(JSON.stringify(v, null, 2));

  /** The flags `publish` and `sync` share (see publish-command.ts). */
  const folderFlags = (o: { dryRun: boolean }) => {
    const only = argv
      .flatMap((a, i) =>
        a.startsWith('--only=') ? [a.slice(7)] : a === '--only' ? [argv[i + 1] ?? ''] : [],
      )
      .flatMap((v) => v.split(','))
      .filter(Boolean);
    const pace = Number(flagValue('--pace') ?? 250);
    return {
      org: flagValue('--org'),
      space: flagValue('--space'),
      manifest: flagValue('--manifest'),
      dryRun: o.dryRun,
      prune: flags.has('--prune'),
      force: flags.has('--force'),
      verify: !flags.has('--no-verify'),
      only: only.length ? only : undefined,
      paceMs: Number.isFinite(pace) && pace >= 0 ? pace : 250,
      json,
      diff: flags.has('--diff'),
      purge: flagValue('--purge'),
      report: !flags.has('--no-report'),
      preview: flagValue('--preview'),
      previewTtl: flagValue('--preview-ttl'),
      comment: flags.has('--comment'),
    };
  };
  const whoamiDeps = () => ({
    out: deps.out,
    err: deps.err,
    env: deps.env ?? process.env,
    baseUrl: deps.baseUrl,
    flagToken,
    me: () =>
      deps.client.auth.me() as unknown as Promise<{
        user: { id: string; name: string; email: string };
        token?: Record<string, unknown>;
      }>,
  });
  const publishDeps = {
    client: deps.client,
    authed: deps.authed ?? true,
    out: deps.out,
    err: deps.err,
    upload: deps.upload,
    env: deps.env,
    sleep: deps.sleep,
  };

  try {
    switch (cmd) {
      case 'whoami':
        return runWhoami(json, whoamiDeps());
      case 'auth': {
        if (rest[0] !== 'status') {
          deps.err('Usage: forumulate auth status [--json]');
          return EXIT.USAGE;
        }
        return runWhoami(json, whoamiDeps());
      }
      case 'orgs': {
        const orgs = orgRows(await deps.client.orgs.list());
        if (json) dump(orgs);
        else for (const o of orgs) deps.out(`${o.id}  ${o.slug}  ${o.name}`);
        return 0;
      }
      case 'spaces': {
        const [orgId] = rest;
        if (!orgId) return usage(deps, 'spaces <orgId>');
        const { spaces } = await deps.client.spaces.list(orgId);
        if (json) dump(spaces);
        else for (const s of spaces) deps.out(`${s.id}  ${s.slug}  [${s.type}]  ${s.name}`);
        return 0;
      }
      /*
       * Enumerate a space, and say where the content is.
       *
       * `spaces` tells you a space holds 1,226 pieces; nothing told you how to
       * walk them. The flag that matters is `contentIn`: `sections` is filled
       * only for a piece written against a shape, so a space of free-form pages
       * answers `include=sections` with empty objects and a sync reports
       * success having carried nothing. This asks for `body` as well, and
       * prints the per-row answer so the distinction is visible from a
       * terminal rather than discovered a week later.
       */
      case 'items': {
        const [orgId, spaceId] = rest;
        if (!orgId || !spaceId) return usage(deps, 'items <orgId> <spaceId>');
        const res = await deps.client.items.list(orgId, spaceId, {
          limit: 50,
          include: ['sections', 'body'],
        });
        if (json) dump(res);
        else {
          for (const i of res.items) {
            const where = i.contentIn ? `[${i.contentIn}]` : '[no content]';
            deps.out(`${i.id}  ${where}  ${i.title}`);
          }
          // `page.total` against what we actually printed: the check that would
          // have caught a sync that quietly carried 6 of 1,226 pieces.
          if (res.page) {
            const total = res.page.total;
            deps.out(
              `-- ${res.items.length} shown${total === undefined ? '' : ` of ${total}`}` +
                ((res.page.hasMore ?? res.page.has_more)
                  ? `, more available (cursor: ${res.page.nextCursor ?? res.page.next_cursor ?? ''})`
                  : ''),
            );
          }
        }
        return 0;
      }
      case 'search': {
        const [orgId, ...q] = rest;
        if (!orgId || q.length === 0) return usage(deps, 'search <orgId> <query...>');
        const { hits } = await deps.client.search.unified(orgId, q.join(' '));
        if (json) dump(hits);
        else for (const h of hits) deps.out(`[${h.sourceType}] ${h.title}  ${h.url}`);
        return 0;
      }
      case 'dev': {
        // A live local preview of a docs folder, rendered by the API (DOCS #244).
        const port = Number(flagValue('--port') ?? 4321);
        return runDev(
          {
            folder: rest[0] ?? '.',
            org: flagValue('--org'),
            space: flagValue('--space'),
            port: Number.isInteger(port) && port > 0 && port < 65536 ? port : 4321,
            site: flagValue('--site'),
          },
          { client: deps.client, out: deps.out, err: deps.err },
        );
      }
      case 'publish':
        // One documented form; the older two print a notice (FMU-DOC07).
        return runPublishCli(rest, folderFlags({ dryRun: flags.has('--dry-run') }), publishDeps);
      case 'sync': {
        /*
         * `publish`, the other way round: a plan by default, `--apply` to
         * write it. Content-as-code runs from a pull request as often as from
         * main, and "I typed the command and it published" is the one mistake
         * a docs-as-code pipeline cannot take back — so the safe form is the
         * one you get by not knowing any flags.
         */
        const folder = rest[0];
        if (!folder || rest.length > 1)
          return usage(deps, 'sync <folder> [--apply] [--prune] [--diff] [--org …] [--space …]');
        if (flags.has('--dry-run') && flags.has('--apply')) {
          deps.err('--dry-run and --apply contradict each other; sync plans unless told --apply.');
          return EXIT.USAGE;
        }
        return runFolder(
          folder,
          { ...folderFlags({ dryRun: !flags.has('--apply') }), command: 'sync' },
          publishDeps,
        );
      }
      case 'plan':
      case 'apply': {
        // The whole-site document (DX-D); see plan/command.ts.
        if (rest.length > 1) return usage(deps, `${cmd} [forumulate.yaml] [--org …]`);
        const batch = Number(flagValue('--batch') ?? 20);
        return runPlanCommand(
          {
            command: cmd === 'apply' ? 'apply' : 'plan',
            file: rest[0] ?? flagValue('--manifest'),
            org: flagValue('--org'),
            prune: flags.has('--prune'),
            json,
            diff: flags.has('--diff'),
            check: flags.has('--check'),
            verbose: flags.has('--verbose'),
            batch: Number.isInteger(batch) && batch > 0 ? batch : 20,
          },
          { client: deps.client, out: deps.out, err: deps.err, env: deps.env, upload: deps.upload },
        );
      }
      case 'snapshot': {
        const [orgId, spaceId, ...label] = rest;
        if (!orgId || !spaceId || label.length === 0)
          return usage(deps, 'snapshot <orgId> <spaceId> <label>');
        const { snapshot } = await deps.client.snapshots.create(orgId, spaceId, label.join(' '));
        if (json) dump(snapshot);
        else deps.out(`Snapshot created.`);
        return 0;
      }
      /*
       * The suite that says whether a platform can be synced correctly, run
       * against whichever one you point it at. Ours passes; publishing a
       * conformance suite that only runs against its author proves nothing.
       */
      case 'conformance': {
        const [collection] = rest;
        if (!collection) {
          deps.err('Usage: forumulate conformance <collectionUrl>');
          return EXIT.USAGE;
        }
        const report = await runConformance({
          collection,
          token: flagToken ?? process.env.FORUMULATE_TOKEN,
          versionHeader: { name: 'forumulate-version', value: '2026-09-01' },
        });
        if (json) {
          dump(report);
        } else {
          deps.out(`Content Sync Protocol ${report.protocol} — ${report.collection}`);
          for (const check of report.checks) {
            const mark = check.state === 'pass' ? 'PASS' : check.state === 'fail' ? 'FAIL' : 'SKIP';
            deps.out(`  ${mark}  ${check.id}  ${check.title}`);
            deps.out(`        ${check.detail}`);
            if (check.state === 'fail') deps.out(`        why it matters: ${check.matters}`);
          }
          deps.out(`${report.passed} passed, ${report.failed} failed`);
        }
        return report.failed > 0 ? 1 : 0;
      }
      /*
       * The going-live checklist, as something that runs.
       *
       * Every item here is one a customer found out about after readers did:
       * health answering plain text during a deploy, a canonical link pointing
       * at our host instead of theirs, a CDN rewriting their email addresses
       * into a script the CSP then refused, feeds that existed only at an API
       * URL. Read once, forgotten, discovered live. It takes a reader URL and
       * speaks plain HTTP, so it works against a staging mount or a competitor
       * just as well — a doctor that only passes on its author's deployment is
       * a checklist with extra steps.
       */
      // A folder's configuration against the published schemas (FMU-D11).
      case 'validate':
        return runValidateCommand(argv.slice(argv.indexOf('validate') + 1), {
          out: deps.out,
          err: deps.err,
          env: deps.env,
          http: deps.http,
          userAgent: deps.userAgent,
          flagToken,
        });
      case 'doctor':
        // Site-wide checks, --site, --json, non-zero exit on FAIL (FMU-D14).
        return runDoctorCommand(argv.slice(argv.indexOf('doctor') + 1), {
          out: deps.out,
          err: deps.err,
          env: deps.env,
          http: deps.http,
          userAgent: deps.userAgent,
          flagToken,
        });
      /*
       * A token, stored for this API.
       *
       * Everything here needed `FORUMULATE_TOKEN` exported in the shell, which
       * puts the token in the environment of every other process that shell
       * runs and in somebody's history file (a customer DX report). It is verified
       * before it is written — storing a token that does not work is a worse
       * state than storing none, because the next failure is reported
       * somewhere else entirely.
       */
      case 'login': {
        const base = deps.baseUrl ?? apiBaseFromEnv();
        let token = flagToken ?? rest[0];
        if (!token && deps.prompt) {
          deps.out(`Create a token at ${base.replace(/\/api$/, '')}/account/tokens`);
          token = (await deps.prompt('Token: ')).trim();
        }
        if (!token) return usage(deps, 'login --token <pat>');
        const probe = new (
          deps.client.constructor as new (o: { baseUrl: string; token: string }) => ForumulateClient
        )({
          baseUrl: base,
          token,
        });
        const { user } = await probe.auth.me();
        const path = storeToken(base, token, deps.env);
        deps.out(`Signed in as ${user.name} <${user.email}> for ${base}`);
        deps.out(`Token stored in ${path} (readable only by you).`);
        return 0;
      }
      case 'logout': {
        const base = deps.baseUrl ?? apiBaseFromEnv();
        const had = forgetToken(base, deps.env);
        deps.out(had ? `Forgot the token for ${base}.` : `No stored token for ${base}.`);
        if (deps.env?.FORUMULATE_TOKEN ?? process.env.FORUMULATE_TOKEN)
          deps.err('FORUMULATE_TOKEN is still set in this environment and still wins.');
        return 0;
      }
      /*
       * The domains a space answers at, and what a half-finished one is waiting
       * for. `verify` re-runs the check and prints the DNS the customer has not
       * added yet — the question "why is my domain not live" asked in the one
       * place that can answer it (DX-2).
       */
      case 'domains': {
        const [maybeVerb, ...tail] = rest;
        const verifying = maybeVerb === 'verify';
        const [orgId, spaceId, hostname] = verifying ? tail : rest;
        if (!orgId || !spaceId) return usage(deps, 'domains [verify] <orgId> <spaceId> [hostname]');
        const { domains } = await deps.client.domains.list(orgId, spaceId);
        if (!verifying) {
          if (json) dump(domains);
          else if (domains.length === 0) deps.out('No domains on this space.');
          else
            for (const d of domains) deps.out(`  ${stateOf(d)}  ${d.hostname}${d.basePath || ''}`);
          return 0;
        }
        const target = hostname
          ? domains.find((d) => d.hostname.toLowerCase() === hostname.toLowerCase())
          : domains[0];
        if (!target) {
          deps.err(hostname ? `No domain ${hostname} on this space.` : 'No domains on this space.');
          return EXIT.NOT_FOUND;
        }
        const { domain } = await deps.client.domains.verify(orgId, spaceId, target.id);
        const setup = await deps.client.domains.setup(orgId, spaceId, target.id).catch(() => null);
        if (json) dump({ domain, setup });
        else {
          deps.out(`${stateOf(domain)}  ${domain.hostname}${domain.basePath || ''}`);
          for (const line of setupLines(domain, setup)) deps.out(`  ${line}`);
        }
        // A failed verification is a 200 with `verified: false` — the exit code
        // is what a script reads, so it has to say which happened.
        return domain.verified ? 0 : 1;
      }
      // Broken links in a folder or a published space (FMU-F05).
      case 'check':
        return runCheck(argv, rest, {
          out: deps.out,
          err: deps.err,
          env: envWithConfig(deps.env),
          request: <T,>(
            method: string,
            path: string,
            opts?: { query?: Record<string, string | number | boolean | undefined> },
          ) => deps.client.request<T>(method, path, opts),
        });
      case 'content':
        return runContent(argv, rest, {
          client: deps.client,
          out: deps.out,
          err: deps.err,
          env: envWithConfig(deps.env),
          ask: deps.ask,
          files: deps.files,
        });
      case 'import':
        return runImportCommand(argv, rest, {
          client: deps.client,
          out: deps.out,
          err: deps.err,
          env: envWithConfig(deps.env),
          ask: deps.ask,
          upload: deps.upload,
          sleep: deps.sleep,
        });
      case 'translations':
      case 'i18n':
        return runTranslations(argv, rest, {
          client: deps.client,
          out: deps.out,
          err: deps.err,
          env: envWithConfig(deps.env),
          ask: deps.ask,
          files: deps.translationFiles,
        });
      default:
        deps.err(`Unknown command: ${cmd}`);
        deps.out(HELP);
        return EXIT.USAGE;
    }
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    deps.err(
      `Error${err.status ? ` ${err.status}` : ''}${err.code ? ` (${err.code})` : ''}: ${err.message ?? String(e)}`,
    );
    return exitCodeForError(e);
  }
}

function usage(deps: RunDeps, form: string): number {
  deps.err(`Usage: forumulate ${form}`);
  return EXIT.USAGE;
}

/** `live`, `verified (not serving yet)`, `unverified` — one word a person can scan. */
function stateOf(d: { verified: boolean; active?: boolean }): string {
  if (!d.verified) return 'unverified';
  return d.active === false ? 'verified (not serving)' : 'live';
}

/**
 * What a half-finished domain is still waiting for, in the words the API uses.
 *
 * `mode` is the state machine (`unverified` → `dns`/`path` → `pending` →
 * `verified`), `served` is whether traffic reaches us, and the verification
 * record is the thing somebody has to go and add. Printing all three is the
 * whole point: "not live" with no next step is the complaint this closes.
 */
function setupLines(
  domain: { verificationRecord?: { name: string; value: string } },
  setup: {
    mode?: string;
    served?: boolean;
    message?: string;
    crawlerBlocked?: boolean;
    dns?: { found?: string[]; expected?: string; reachesUs?: boolean };
    forward?: { path: string; origin: string };
  } | null,
): string[] {
  const out: string[] = [];
  if (setup?.mode)
    out.push(`state: ${setup.mode}${setup.served === false ? ' (not serving yet)' : ''}`);
  if (setup?.message) out.push(setup.message);
  const record = domain.verificationRecord;
  if (record) out.push(`TXT  ${record.name}  →  ${record.value}`);
  if (setup?.dns?.expected) {
    const found = setup.dns.found?.length ? setup.dns.found.join(', ') : 'nothing';
    out.push(`DNS  expected ${setup.dns.expected}, found ${found}`);
  }
  if (setup?.forward) out.push(`forward ${setup.forward.path} → ${setup.forward.origin}`);
  // Theirs to change, not ours — but invisible unless somebody says it.
  if (setup?.crawlerBlocked) out.push('a CDN in front of this domain is blocking AI crawlers');
  return out;
}
