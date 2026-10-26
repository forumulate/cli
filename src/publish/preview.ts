import { PublishApi } from './api';
import { spacePath, type SpaceCtx } from './context';
import type { DocsPlan } from './docs-plan';
import { payloadOf, uploadAssetsFor } from './docs-apply';

/**
 * `forumulate publish . --preview pr-123` (FMU-F01): the same folder, planned
 * against the live space exactly as a publish would plan it, but instead of
 * writing the pages, the pages the plan would send — added and edited, plus
 * the ones `--prune` would trash — go to a PREVIEW of that name. Nothing is
 * published; the answer is a tokened link on the space's own addresses that
 * shows the space as the change would publish it, a diff summary, and a
 * ready-made pull-request comment.
 *
 * Pictures the changed pages use are uploaded (content-addressed, so a re-run
 * uploads nothing new and the merge's real publish finds them already there),
 * because a preview with broken images previews nothing.
 */

/** Where the change came from, read from the CI the command runs in. */
export interface PreviewSource {
  provider?: string;
  repository?: string;
  number?: string;
  ref?: string;
  sha?: string;
  url?: string;
}

/** What one space's preview answered. */
export interface PreviewResult {
  space: string;
  id: string;
  name: string;
  token: string;
  urls: string[];
  expiresAt: string;
  summary: { added: number; changed: number; removed: number; unchanged: number };
  comment: string;
}

/** The name a preview may have — the API's rule (`pr-123`, `mr-45`, `feature-x`). */
export const PREVIEW_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

/**
 * The pull request this run is for, from the CI's own variables — GitHub
 * Actions, GitLab CI, Bitbucket Pipelines, Gitea/Forgejo Actions, Azure
 * Pipelines — or `FORUMULATE_PREVIEW_*` for anything else. Every field is
 * optional: a preview made from a laptop simply has no source.
 */
export function ciSource(env: NodeJS.ProcessEnv): PreviewSource {
  const pick = (...vals: (string | undefined)[]) => vals.find((v) => v && v.trim())?.trim();
  if (env.FORUMULATE_PREVIEW_PROVIDER || env.FORUMULATE_PREVIEW_URL)
    return clean({
      provider: env.FORUMULATE_PREVIEW_PROVIDER,
      repository: env.FORUMULATE_PREVIEW_REPOSITORY,
      number: env.FORUMULATE_PREVIEW_NUMBER,
      ref: env.FORUMULATE_PREVIEW_REF,
      sha: env.FORUMULATE_PREVIEW_SHA,
      url: env.FORUMULATE_PREVIEW_URL,
    });
  if (env.GITLAB_CI)
    return clean({
      provider: 'gitlab',
      repository: env.CI_PROJECT_PATH,
      number: env.CI_MERGE_REQUEST_IID,
      ref: pick(env.CI_MERGE_REQUEST_SOURCE_BRANCH_NAME, env.CI_COMMIT_REF_NAME),
      sha: env.CI_COMMIT_SHA,
      url:
        env.CI_PROJECT_URL && env.CI_MERGE_REQUEST_IID
          ? `${env.CI_PROJECT_URL}/-/merge_requests/${env.CI_MERGE_REQUEST_IID}`
          : undefined,
    });
  if (env.BITBUCKET_REPO_FULL_NAME)
    return clean({
      provider: 'bitbucket',
      repository: env.BITBUCKET_REPO_FULL_NAME,
      number: env.BITBUCKET_PR_ID,
      ref: env.BITBUCKET_BRANCH,
      sha: env.BITBUCKET_COMMIT,
      url: env.BITBUCKET_PR_ID
        ? `https://bitbucket.org/${env.BITBUCKET_REPO_FULL_NAME}/pull-requests/${env.BITBUCKET_PR_ID}`
        : undefined,
    });
  if (env.GITHUB_ACTIONS || env.GITEA_ACTIONS) {
    const number = /^refs\/pull\/(\d+)\//.exec(env.GITHUB_REF ?? '')?.[1];
    const server = (env.GITHUB_SERVER_URL ?? 'https://github.com').replace(/\/$/, '');
    return clean({
      provider: env.GITEA_ACTIONS ? 'gitea' : 'github',
      repository: env.GITHUB_REPOSITORY,
      number,
      ref: pick(env.GITHUB_HEAD_REF, env.GITHUB_REF_NAME),
      sha: env.GITHUB_SHA,
      url: number && env.GITHUB_REPOSITORY ? `${server}/${env.GITHUB_REPOSITORY}/pull/${number}` : undefined,
    });
  }
  if (env.TF_BUILD)
    return clean({
      provider: 'azure',
      repository: env.BUILD_REPOSITORY_NAME,
      number: env.SYSTEM_PULLREQUEST_PULLREQUESTID,
      ref: env.SYSTEM_PULLREQUEST_SOURCEBRANCH,
      sha: env.BUILD_SOURCEVERSION,
    });
  return {};
}

function clean(s: PreviewSource): PreviewSource {
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v)) as PreviewSource;
}

/** Bytes per request: comfortably under the API's body limit. */
const BATCH_BYTES = 3_000_000;

/** Send this space's planned pages to the preview; returns what the API answered. */
export async function sendPreview(
  ctx: SpaceCtx,
  plan: DocsPlan,
  existingAssets: Map<string, string>,
  opts: { name: string; ttlDays?: number; source: PreviewSource },
): Promise<PreviewResult | null> {
  const sends = [...plan.sends.values()].flat();
  const removed = plan.prunePages.map((p) => p.slug);
  if (!sends.length && !removed.length) {
    ctx.line({ verb: 'same', what: `preview ${opts.name}`, detail: 'nothing differs from what is published' });
  }
  // A preview writes no page, but it does upload the pictures those pages use.
  const writer = new PublishApi({ ...ctx.api.opts, readOnly: false });
  const wctx: SpaceCtx = { ...ctx, api: writer };
  const urls = await uploadAssetsFor(wctx, sends.map((s) => s.page.file), existingAssets);
  const pages = sends.map((s) => ({
    slug: s.page.slug,
    title: s.page.title,
    file: s.page.file,
    markdown: payloadOf(wctx, s.page, urls.get(s.page.file) ?? new Map()),
  }));
  const batches: (typeof pages)[] = [[]];
  let size = 0;
  for (const p of pages) {
    if (size + p.markdown.length > BATCH_BYTES && batches[batches.length - 1]!.length) {
      batches.push([]);
      size = 0;
    }
    batches[batches.length - 1]!.push(p);
    size += p.markdown.length;
  }
  type Answer = {
    preview: { id: string; name: string; expiresAt: string; summary: PreviewResult['summary'] };
    token: string;
    urls: string[];
    comment: string;
  };
  let answer: Answer | null = null;
  for (const [i, batch] of batches.entries()) {
    answer = await writer.post<Answer>(spacePath(ctx, '/previews'), {
      name: opts.name,
      pages: batch,
      // Removals ride on the first request; later ones only add pages.
      ...(i === 0 && removed.length ? { removed } : {}),
      ...(i > 0 ? { append: true } : {}),
      ...(Object.keys(opts.source).length ? { source: opts.source } : {}),
      ...(opts.ttlDays ? { ttlDays: opts.ttlDays } : {}),
    });
  }
  if (!answer) return null;
  for (const s of sends)
    ctx.line({ verb: 'preview', what: `page ${s.page.slug}`, detail: `${s.why} — in preview ${opts.name}` });
  for (const slug of removed)
    ctx.line({ verb: 'preview', what: `page ${slug}`, detail: `removed — in preview ${opts.name}` });
  return {
    space: ctx.spec.space ?? ctx.spaceId,
    id: answer.preview.id,
    name: answer.preview.name,
    token: answer.token,
    urls: answer.urls,
    expiresAt: answer.preview.expiresAt,
    summary: answer.preview.summary,
    comment: answer.comment,
  };
}
