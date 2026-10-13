import { statSync } from 'node:fs';
import type { ForumulateClient } from '@forumulate/sdk';
import { runConformance } from './conformance';
import { runDoctor } from './doctor';
import { forgetToken, storeToken } from './credentials';
import { describePlan, planPublish, readDocs } from './publish-dir';
import { apiBaseFromEnv, siteFromEnv } from './api-base';

/**
 * Kept in step with package.json by `cli-version.test.ts` — they had drifted to
 * 0.1.0 and 0.2.1, so `--version` reported a release that was never published.
 */
export const VERSION = '0.3.6';

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
}

const HELP = `forumulate — Forumulate command-line interface

Usage:
  forumulate <command> [args]

Commands:
  login [--token <pat>]              Store a token for this API, so every other
                                     command stops needing FORUMULATE_TOKEN in
                                     the environment
  logout                             Forget the stored token
  whoami                              Show the authenticated user
  orgs                               List your organizations
  spaces <orgId>                     List spaces in an org
  items <orgId> <spaceId>            List what is in a space, with where each
                                     piece's content lives
  search <orgId> <query...>          Unified search across docs/forum/blog
  publish <orgId> <spaceId> <pageId> Publish a page
  publish <orgId> <spaceId> <dir>    Publish every .md in a directory — add
                                     --dry-run to see the plan and write nothing
  domains <orgId> <spaceId>          List this space's domains and their state
  domains verify <orgId> <spaceId> <hostname>
                                     Re-run verification and say what is missing
  snapshot <orgId> <spaceId> <label> Create a space version snapshot
  conformance <collectionUrl>        Run the Content Sync Protocol suite against
                                     any platform's collection endpoint
  doctor <readerUrl>                 Check a live site from the outside: health,
                                     public read, canonical, cache headers,
                                     crawler access, feeds, HTML rewriting
  help                               Show this help

Environment:
  FORUMULATE_TOKEN   Personal Access Token (Bearer). Overrides a stored one, so
                     CI keeps working exactly as it did. Mint one at
                     https://forumulate.com/account/tokens
  FORUMULATE_URL     The site (default https://forumulate.com); the API is its
                     /api, i.e. https://forumulate.com/api. A value already
                     ending in /api is used as-is.
  FORUMULATE_API_URL Exact API base, for a local API with no /api prefix
                     (http://localhost:4000). Wins over FORUMULATE_URL.

The SDK (ForumulateClient.fromEnv) and the MCP server (@forumulate/mcp) read
the same variables. Guide: https://forumulate.com/guides/api-tokens-and-scopes

Flags:
  --json          Emit raw JSON instead of a formatted summary
  --dry-run       Plan the work and write nothing (publish of a directory)
  --version       Print the CLI version
`;

/**
 * Parse and execute a CLI invocation. Pure w.r.t. I/O (uses the injected deps),
 * so it can be unit-tested with a fake client. Returns a process exit code.
 */
export async function run(argv: string[], deps: RunDeps): Promise<number> {
  const args = argv.filter((a) => !a.startsWith('--'));
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

  if (flags.has('--version')) {
    deps.out(VERSION);
    return 0;
  }
  if (!cmd || cmd === 'help' || flags.has('--help')) {
    deps.out(HELP);
    return cmd && cmd !== 'help' ? 1 : 0;
  }

  const dump = (v: unknown) => deps.out(JSON.stringify(v, null, 2));

  try {
    switch (cmd) {
      case 'whoami': {
        const { user } = await deps.client.auth.me();
        if (json) dump(user);
        else deps.out(`${user.name} <${user.email}> (${user.id})`);
        return 0;
      }
      case 'orgs': {
        const { orgs } = await deps.client.orgs.list();
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
      case 'publish': {
        const [orgId, spaceId, target] = rest;
        if (!orgId || !spaceId || !target)
          return usage(deps, 'publish <orgId> <spaceId> <pageId|directory> [--dry-run]');
        /*
         * One verb, two objects. `publish <pageId>` published exactly one page
         * by id, which is the thing a person doing docs-as-code never has:
         * they have a directory (a customer DX report). A path that exists on disk is a
         * directory publish; anything else is the id form, unchanged.
         */
        const isDir = (() => {
          try {
            return statSync(target).isDirectory();
          } catch {
            return false;
          }
        })();
        if (!isDir) {
          await deps.client.spaces.publishPage(orgId, spaceId, target);
          deps.out(`Published ${target}.`);
          return 0;
        }
        const docs = readDocs(target);
        const { items } = await deps.client.items.list(orgId, spaceId, { limit: 200 });
        const plan = planPublish(docs, items as { id: string; slug?: string; title: string }[]);
        if (json) dump(plan);
        else {
          deps.out(`${docs.length} file(s) in ${target}:`);
          for (const line of describePlan(plan, target)) deps.out(line);
        }
        if (flags.has('--dry-run')) {
          if (!json) deps.out('--dry-run: nothing was written.');
          return 0;
        }
        for (const doc of plan.create) {
          const { item } = await deps.client.items.create(orgId, spaceId, {
            title: doc.title,
            slug: doc.slug,
            body: doc.markdown,
          });
          await deps.client.items.publish(orgId, spaceId, item.id);
        }
        for (const doc of plan.update) {
          await deps.client.items.setContent(orgId, spaceId, doc.itemId, { body: doc.markdown });
          await deps.client.items.publish(orgId, spaceId, doc.itemId);
        }
        if (!json)
          deps.out(
            `Published ${plan.create.length} new and ${plan.update.length} updated piece(s).`,
          );
        return 0;
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
          return 1;
        }
        const report = await runConformance({
          collection,
          token: process.env.FORUMULATE_TOKEN,
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
      case 'doctor': {
        const [url] = rest;
        if (!url) return usage(deps, 'doctor <readerUrl>');
        // Blank is the same as unset — see the note in `runDoctor`. Not
        // `apiBaseFromEnv()`: doctor defaults to the SITE's own origin, which
        // is the right probe for a reader URL on a customer's domain.
        const report = await runDoctor({
          url,
          apiBase: siteFromEnv(),
        });
        if (json) {
          dump(report);
        } else {
          deps.out(`Checking ${report.url}`);
          for (const check of report.checks) {
            const mark = check.state === 'pass' ? 'PASS' : check.state === 'fail' ? 'FAIL' : 'SKIP';
            deps.out(`  ${mark}  ${check.id}  ${check.title}`);
            deps.out(`        ${check.detail}`);
            if (check.state === 'fail' && check.matters)
              deps.out(`        why it matters: ${check.matters}`);
          }
          deps.out(`${report.passed} passed, ${report.failed} failed, ${report.warnings} skipped`);
        }
        return report.failed > 0 ? 1 : 0;
      }
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
        let token = flagValue('--token') ?? rest[0];
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
          return 1;
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
      default:
        deps.err(`Unknown command: ${cmd}`);
        deps.out(HELP);
        return 1;
    }
  } catch (e) {
    const err = e as { status?: number; code?: string; message?: string };
    deps.err(
      `Error${err.status ? ` ${err.status}` : ''}${err.code ? ` (${err.code})` : ''}: ${err.message ?? String(e)}`,
    );
    return 1;
  }
}

function usage(deps: RunDeps, form: string): number {
  deps.err(`Usage: forumulate ${form}`);
  return 1;
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
