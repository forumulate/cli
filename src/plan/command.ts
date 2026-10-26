import { PublishApi, lookupAsset } from '../publish/api';
import type { ApiClient } from '../publish/client';
import { findManifest } from '../publish/manifest';
import { rewriteAssets, rewriteValue } from '../publish/rewrite';
import { EXIT, exitCodeForError } from '../exit-codes';
import { dropImplied, loadPlanDocument, pagesOf, type PlanDocument } from './document';
import { formatApply, formatPlan, type ManifestAnswer } from './output';

/**
 * `forumulate plan` and `forumulate apply` (DX-D): one `forumulate.yaml`
 * (version 2) and its Markdown folders, planned as a diff and applied
 * idempotently through `PUT /orgs/{org}/manifest` — the API's own planner and
 * applier, so there is no second engine here that could disagree with it.
 *
 * What the CLI adds is only what needs the disk or the terminal: folders
 * become pages, local images are uploaded once by content hash and their
 * references rewritten, and a large apply is split into batches. The batches
 * exist because an apply is a request, and a request through the edge is cut
 * at 30 seconds while the work carries on: forty new pages, each written,
 * published and read back, do not fit in one. So the plan is computed first
 * and the CHANGED pages are sent a batch at a time, each request carrying
 * every page already settled (which plans `unchanged` and costs a read); the
 * last request is the whole document, and only it carries `prune`, so a
 * prune always sees every page that is declared.
 */
export interface PlanFlags {
  command: 'plan' | 'apply';
  file?: string;
  org?: string;
  prune: boolean;
  json: boolean;
  diff: boolean;
  /** `plan --check`: exit 1 when the plan is not empty (drift detection in CI). */
  check: boolean;
  verbose: boolean;
  /** Changed pages per apply request. */
  batch: number;
}

export interface PlanCliDeps {
  client: ApiClient;
  out: (l: string) => void;
  err: (l: string) => void;
  env?: NodeJS.ProcessEnv;
  upload?: (path: string, form: FormData) => Promise<unknown>;
  cwd?: string;
}

type Body = Record<string, unknown>;

export async function runPlanCommand(flags: PlanFlags, deps: PlanCliDeps): Promise<number> {
  const file = findManifest(deps.cwd ?? process.cwd(), flags.file);
  if (!file) {
    deps.err(`forumulate ${flags.command}: no forumulate.yaml here; pass the file: forumulate ${flags.command} path/to/forumulate.yaml`);
    return EXIT.USAGE;
  }
  let doc: PlanDocument;
  try {
    doc = loadPlanDocument(file);
  } catch (e) {
    deps.err((e as Error).message);
    return EXIT.USAGE;
  }
  const org = flags.org ?? doc.org ?? deps.env?.FORUMULATE_ORG ?? process.env.FORUMULATE_ORG;
  if (!org) {
    deps.err('Which organization? Put `org:` in forumulate.yaml, pass --org, or set FORUMULATE_ORG.');
    return EXIT.USAGE;
  }
  if (flags.prune) doc.body.prune = true;
  for (const s of doc.skipped) deps.err(`skipped ${s}`);

  const api = new PublishApi({
    client: deps.client,
    authed: true,
    readOnly: flags.command === 'plan',
    paceMs: 0,
    upload: deps.upload,
  });
  try {
    let spaces = await spaceIds(api, org);
    await settleImpliedCollections(api, org, doc, spaces);
    await resolveAssets(api, org, doc, spaces, flags.command === 'apply');
    const planned = await send(deps.client, org, doc.body, false);

    if (flags.command === 'plan') {
      if (flags.json) deps.out(JSON.stringify(planned, null, 2));
      else formatPlan(planned, { diff: flags.diff, verbose: flags.verbose }).forEach((l) => deps.out(l));
      if (!planned.ok) return EXIT.FAILED;
      return flags.check && hasChanges(planned) ? EXIT.FAILED : EXIT.OK;
    }

    // Pages pointing at local files in a space this apply creates: the space
    // must exist before its assets can be uploaded, so everything but the
    // pages lands first, then the uploads, then a fresh plan.
    const answers: ManifestAnswer[] = [];
    let plan = planned;
    if (pendingAssets(doc, spaces)) {
      const { pages: _p, prune: _x, ...rest } = doc.body;
      answers.push(await send(deps.client, org, rest, true));
      if (!answers[0]!.ok) return report(answers, flags, deps);
      spaces = await spaceIds(api, org);
      await resolveAssets(api, org, doc, spaces, true);
      plan = await send(deps.client, org, doc.body, false);
    }
    for (const body of batches(doc.body, plan, flags.batch)) {
      const answer = await send(deps.client, org, body, true);
      answers.push(answer);
      if (!answer.ok) break;
    }
    return report(answers, flags, deps);
  } catch (e) {
    const err = e as { message?: string; status?: number; details?: unknown };
    deps.err(`forumulate ${flags.command}: ${err.message ?? String(e)}`);
    if (err.details && typeof err.details === 'object') deps.err(JSON.stringify(err.details));
    return exitCodeForError(e);
  }
}

function report(answers: ManifestAnswer[], flags: PlanFlags, deps: PlanCliDeps): number {
  if (flags.json) deps.out(JSON.stringify({ ok: answers.every((a) => a.ok), batches: answers }, null, 2));
  else formatApply(answers, { verbose: flags.verbose }).forEach((l) => deps.out(l));
  const bad = answers.some(
    (a) => !a.ok || a.steps.some((s) => s.status === 'failed' || ('readBack' in s && s.readBack === 'mismatch')),
  );
  return bad ? EXIT.FAILED : EXIT.OK;
}

/** The manifest door: a dry run, or `?apply=true`. */
async function send(client: ApiClient, org: string, body: Body, apply: boolean): Promise<ManifestAnswer> {
  // The dry run writes nothing by the API's own contract (dry run is its
  // default), so it is sent straight through rather than through the
  // read-only guard that stops a planning bug from writing.
  return client.request<ManifestAnswer>('PUT', `/orgs/${encodeURIComponent(org)}/manifest`, {
    body,
    ...(apply ? { query: { apply: true } } : {}),
  });
}

export function hasChanges(answer: ManifestAnswer): boolean {
  return answer.steps.some((s) => s.action !== 'unchanged' && s.action !== 'unsupported');
}

async function spaceIds(api: PublishApi, org: string): Promise<Map<string, string>> {
  const rows = await api.all<{ id: string; slug: string }>(`/orgs/${encodeURIComponent(org)}/spaces`, 'spaces', { limit: 500 });
  return new Map(rows.map((s) => [s.slug, s.id]));
}

async function settleImpliedCollections(api: PublishApi, org: string, doc: PlanDocument, spaces: Map<string, string>) {
  for (const [space, slugs] of doc.implied) {
    const id = spaces.get(space);
    if (!id) continue;
    const have = await api.all<{ slug: string }>(`/orgs/${encodeURIComponent(org)}/spaces/${id}/collections`, 'collections');
    dropImplied(doc.body, space, new Set(have.map((c) => c.slug)), slugs);
  }
}

function pendingAssets(doc: PlanDocument, spaces: Map<string, string>): boolean {
  return [...doc.assets.keys()].some((space) => !spaces.has(space));
}

/**
 * Local references → asset URLs, in every page body, slot and metadata value.
 * A plan only LOOKS an asset up (by content hash); a file not uploaded yet
 * gets a placeholder, so the page shows as changing — which it will.
 */
async function resolveAssets(
  api: PublishApi,
  org: string,
  doc: PlanDocument,
  spaces: Map<string, string>,
  upload: boolean,
): Promise<void> {
  const pages = pagesOf(doc.body);
  for (const [space, byPage] of doc.assets) {
    const spaceId = spaces.get(space);
    const existing = spaceId ? await api.assets(org, spaceId) : new Map<string, string>();
    for (const [key, refs] of byPage) {
      const urls = new Map<string, string>();
      for (const [ref, abs] of refs) {
        const known = lookupAsset(existing, abs);
        if (known) urls.set(ref, known);
        else if (upload && spaceId) urls.set(ref, await api.upload(org, spaceId, abs, existing));
        else urls.set(ref, `https://assets.invalid/${encodeURIComponent(ref)}`);
      }
      const [slug, locale] = key.split('@');
      const page = pages.find((p) => p.space === space && p.slug === slug);
      if (!page) continue;
      const target = (locale ? page.translations?.[locale] : page) as
        | { body?: string; sections?: Record<string, string>; metadata?: Record<string, unknown> }
        | undefined;
      if (!target) continue;
      if (target.body) target.body = rewriteAssets(target.body, urls);
      if (target.sections)
        target.sections = Object.fromEntries(Object.entries(target.sections).map(([k, v]) => [k, rewriteAssets(v, urls)]));
      if (target.metadata) target.metadata = rewriteValue(target.metadata, urls);
    }
  }
}

/**
 * The apply requests: every page the plan leaves alone is in all of them;
 * the changed ones are added `size` at a time; the last request is the whole
 * document, and is the only one that may prune.
 */
export function batches(body: Body, plan: ManifestAnswer, size: number): Body[] {
  const pages = pagesOf(body);
  const changed = new Set(
    plan.steps
      .filter((s) => s.unit === 'pages' && s.action !== 'unchanged' && s.action !== 'delete')
      .map((s) => s.ref.split('@')[0]!),
  );
  const settled = pages.filter((p) => !changed.has(`${p.space}/${p.slug}`));
  const moving = pages.filter((p) => changed.has(`${p.space}/${p.slug}`));
  const n = Math.max(1, size);
  if (moving.length <= n) return [body];
  const out: Body[] = [];
  for (let end = n; end < moving.length; end += n) {
    out.push({ ...body, pages: [...settled, ...moving.slice(0, end)], prune: false });
  }
  out.push(body);
  return out;
}
