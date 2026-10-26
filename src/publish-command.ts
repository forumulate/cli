import { statSync } from 'node:fs';
import type { ForumulateClient } from '@forumulate/sdk';
import { runPublish, type PublishReport } from './publish/command';
import { EXIT } from './exit-codes';
import { postPreviewComment } from './preview-comment';

/**
 * `forumulate publish` and `forumulate sync` as the CLI runs them: the
 * argument forms, the purge, and the run report (FMU-DOC07, D04, D16).
 *
 * Three argument forms grew up over time — a page id, a folder, and the folder
 * with org and space as positionals — and the guides used all three, so an
 * integrator could not tell which was current. One form is documented now
 * (`publish <folder> --org … --space …`); the others still work and say so on
 * stderr, with the line to use instead.
 */
export interface PublishCliDeps {
  client: ForumulateClient;
  authed: boolean;
  out: (l: string) => void;
  err: (l: string) => void;
  env?: NodeJS.ProcessEnv;
  upload?: (path: string, form: FormData) => Promise<unknown>;
  sleep?: (ms: number) => Promise<void>;
}

export interface FolderFlags {
  org?: string;
  space?: string;
  manifest?: string;
  dryRun: boolean;
  prune: boolean;
  force: boolean;
  verify: boolean;
  only?: string[];
  paceMs: number;
  json: boolean;
  diff: boolean;
  purge?: string;
  report: boolean;
  command: 'publish' | 'sync';
  /** `--preview <name>` (FMU-F01): send the plan's pages to a preview, publish nothing. */
  preview?: string;
  /** `--preview-ttl <days>`. */
  previewTtl?: string;
  /** `--comment`: post (or update) the preview's comment on the pull request. */
  comment?: boolean;
}

const isDir = (p: string | undefined) => {
  try {
    return Boolean(p) && statSync(p!).isDirectory();
  } catch {
    return false;
  }
};

const PURGES = ['page', 'space', 'none'] as const;
type Purge = (typeof PURGES)[number];

/** `publish …` in any of its forms. */
export async function runPublishCli(
  rest: string[],
  flags: Omit<FolderFlags, 'command'>,
  deps: PublishCliDeps,
): Promise<number> {
  const purge = flags.purge ?? 'page';
  if (!(PURGES as readonly string[]).includes(purge)) {
    deps.err(`--purge takes page, space or none (got "${purge}").`);
    return EXIT.USAGE;
  }
  if (rest.length === 1 && isDir(rest[0]))
    return runFolder(rest[0]!, { ...flags, command: 'publish' }, deps);
  if (rest.length === 3 && isDir(rest[2])) {
    deps.err(
      `notice: \`publish <orgId> <spaceId> <folder>\` is deprecated; use \`forumulate publish ${rest[2]} --org ${rest[0]} --space ${rest[1]}\`.`,
    );
    return runFolder(rest[2]!, { ...flags, org: rest[0], space: rest[1], command: 'publish' }, deps);
  }
  const [orgId, spaceId, pageId] = rest;
  if (rest.length === 3 && orgId && spaceId && pageId) {
    deps.err(
      `notice: \`publish <orgId> <spaceId> <pageId>\` is deprecated; use \`forumulate items publish ${pageId} --org ${orgId} --space ${spaceId}\`, or publish the folder the page lives in.`,
    );
    const res = await deps.client.request<{ purged?: Record<string, unknown> }>(
      'POST',
      `/orgs/${orgId}/spaces/${spaceId}/pages/${pageId}/publish`,
      { body: { purge } },
    );
    if (flags.json) deps.out(JSON.stringify(res, null, 2));
    else deps.out(`Published ${pageId}${res?.purged ? `; purged (edge ${String(res.purged.edge)})` : ''}.`);
    return EXIT.OK;
  }
  if (rest.length === 1) deps.err(`${rest[0]} is not a folder.`);
  deps.err('Usage: forumulate publish <folder> --org <id|slug> --space <id|slug> [flags]');
  deps.err('       forumulate publish --help');
  return EXIT.USAGE;
}

/** The folder publish/sync, its run reported to the API, its summary printed. */
export async function runFolder(
  folder: string,
  flags: FolderFlags,
  deps: PublishCliDeps,
): Promise<number> {
  let report: PublishReport | undefined;
  const code = await runPublish(
    {
      folder,
      org: flags.org,
      space: flags.space,
      manifest: flags.manifest,
      dryRun: flags.dryRun,
      prune: flags.prune,
      force: flags.force,
      verify: flags.verify,
      only: flags.only,
      paceMs: flags.paceMs,
      json: flags.json,
      diff: flags.diff,
      command: flags.command,
      purge: (flags.purge as Purge | undefined) ?? 'page',
      preview: flags.preview,
      previewTtlDays:
        flags.previewTtl && /^\d+$/.test(flags.previewTtl) ? Number(flags.previewTtl) : undefined,
    },
    {
      client: deps.client,
      authed: deps.authed,
      out: deps.out,
      err: deps.err,
      upload: deps.upload,
      env: deps.env,
      sleep: deps.sleep,
      report: (r) => (report = r),
    },
  );
  if (!report) return code;
  const r = report as PublishReport;
  // The pull-request comment, on whatever host the CI runs on (FMU-F01).
  if (flags.comment && r.previews.length) {
    for (const p of r.previews) {
      const posted = await postPreviewComment(p, deps.env ?? process.env).catch((e: Error) => {
        deps.err(`warning: the pull-request comment was not posted (${e.message}).`);
        return null;
      });
      if (posted) deps.err(`Commented on ${posted}.`);
    }
  }
  const verify: 'ok' | 'mismatch' | 'skipped' =
    r.dryRun || !flags.verify ? 'skipped' : r.unverified.length ? 'mismatch' : 'ok';
  const spaces = [...new Set(r.lines.map((l) => l.space).filter((s) => s !== 'site'))];
  const runs: Record<string, unknown>[] = [];
  // Recorded only when something was attempted: a plan is the caller's to keep.
  if (flags.report && !r.dryRun && deps.authed)
    for (const space of spaces) {
      const run = await recordRun(deps, flags.org, space, r, verify).catch((e: Error) => {
        deps.err(`warning: the run was not recorded (${e.message}); publish.completed was not sent.`);
        return null;
      });
      if (run) runs.push(run);
    }
  if (flags.json) {
    const n = (k: string) => r.counts[k] ?? 0;
    deps.out(
      JSON.stringify(
        {
          space: spaces.length === 1 ? spaces[0] : spaces,
          created: n('create'),
          updated: n('update') + n('meta') + n('move') + n('order') + n('patch'),
          unchanged: r.unchanged,
          trashed: n('prune'),
          purged: mergePurged(r.purged),
          verify,
          diffUrl: (runs[0]?.summary as { diffUrl?: string } | undefined)?.diffUrl ?? null,
          runIds: runs.map((x) => x.id),
          conflicts: r.conflicts,
          previews: r.previews,
          dryRun: r.dryRun,
          writes: r.writes,
          counts: r.counts,
          errors: r.errors,
          unverified: r.unverified,
          lines: r.lines,
        },
        null,
        2,
      ),
    );
  } else if (runs.length) {
    const p = mergePurged(r.purged);
    if (p) deps.out(`Purged ${p.urlCount} address(es); edge ${p.edge}.`);
    for (const run of runs)
      deps.out(`Run ${String(run.id)}: ${String((run.summary as { diffUrl?: string })?.diffUrl ?? '')}`);
  }
  return code;
}

/** POST the run for one space (by slug or id) so the API records it and fires publish.completed. */
async function recordRun(
  deps: PublishCliDeps,
  orgRef: string | undefined,
  spaceRef: string,
  r: PublishReport,
  verify: 'ok' | 'mismatch' | 'skipped',
): Promise<Record<string, unknown> | null> {
  const org = orgRef ?? deps.env?.FORUMULATE_ORG ?? process.env.FORUMULATE_ORG;
  if (!org) return null;
  const spaceId = await spaceIdOf(deps, org, spaceRef);
  const lines = r.lines.filter((l) => l.space === spaceRef);
  const counts: Record<string, number> = {};
  for (const l of lines) counts[l.line.verb] = (counts[l.line.verb] ?? 0) + 1;
  const res = await deps.client.request<{ run: Record<string, unknown> }>(
    'POST',
    `/orgs/${org}/spaces/${spaceId}/publish-runs`,
    {
      body: {
        dryRun: false,
        counts: Object.fromEntries(Object.entries(counts).filter(([k]) => k !== 'same')),
        unchanged: counts.same ?? 0,
        writes: r.writes,
        lines: lines
          .filter((l) => l.line.verb !== 'same')
          .slice(0, 5000)
          .map((l) => ({ space: l.space, ...l.line })),
        errors: r.errors.filter((e) => e.startsWith(`${spaceRef}:`) || !e.includes(':')).slice(0, 500),
        verify,
        purged: mergePurged(r.purged),
      },
    },
  );
  return res.run;
}

async function spaceIdOf(deps: PublishCliDeps, org: string, ref: string): Promise<string> {
  if (/^[0-9a-f-]{36}$/i.test(ref)) return ref;
  const res = await deps.client.request<{ spaces?: { id: string; slug: string }[] }>(
    'GET',
    `/orgs/${org}/spaces`,
    { query: { limit: 200 } },
  );
  return res.spaces?.find((s) => s.slug === ref)?.id ?? ref;
}

/** Many `purged` answers (one per import batch) as one. */
export function mergePurged(
  answers: Record<string, unknown>[],
): { scope: string; urlCount: number; urls: string[]; edge: string; edges: unknown[] } | null {
  if (answers.length === 0) return null;
  const urls = new Set<string>();
  const edges: unknown[] = [];
  const names = new Set<string>();
  let scope = 'page';
  let count = 0;
  for (const a of answers) {
    for (const u of (a.urls as string[] | undefined) ?? []) urls.add(u);
    count += Number(a.urlCount ?? 0);
    for (const e of (a.edges as { name: string }[] | undefined) ?? []) {
      edges.push(e);
      names.add(e.name);
    }
    if (a.scope === 'space' || a.purged === 'space') scope = 'space';
  }
  return {
    scope,
    urlCount: Math.max(count, urls.size),
    urls: [...urls].slice(0, 200),
    edge: names.size === 0 ? 'none' : names.size === 1 ? [...names][0]! : 'multiple',
    edges,
  };
}
