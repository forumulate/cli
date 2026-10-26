import { ciSource, type PreviewResult } from './publish/preview';

type Fetch = typeof fetch;

/**
 * `publish --preview <name> --comment` (FMU-F01): post the preview's link and
 * diff on the pull request it was built for — and on the next push EDIT that
 * comment rather than add another, found by the hidden
 * `<!-- forumulate-preview:<name> -->` marker the API puts in it.
 *
 * Host-neutral: GitHub, Gitea/Forgejo (the same REST shape), GitLab and
 * Bitbucket, each with the token its CI documents for writing comments
 * (`GITHUB_TOKEN`, `GITEA_TOKEN`, `GITLAB_TOKEN`, `BITBUCKET_TOKEN`). Any other
 * host: print the comment with `--json` (`previews[].comment`) and post it with
 * that host's own tool — the recipes in docs/guides/docs-workflow.md do both.
 *
 * Answers the pull request's address, or null when there is nothing to
 * comment on (not a PR build). Throws with a sentence when the host refuses.
 */
export async function postPreviewComment(
  preview: PreviewResult,
  env: NodeJS.ProcessEnv,
  doFetch: Fetch = fetch,
): Promise<string | null> {
  const src = ciSource(env);
  if (!src.provider || !src.repository || !src.number) return null;
  const marker = `<!-- forumulate-preview:${preview.name} -->`;
  const body = preview.comment.includes(marker) ? preview.comment : `${marker}\n${preview.comment}`;
  const call = async (url: string, init: RequestInit) => {
    const res = await doFetch(url, init);
    if (!res.ok) throw new Error(`${src.provider} answered ${res.status} for ${init.method ?? 'GET'} ${url}`);
    return res.status === 204 ? null : res.json();
  };
  switch (src.provider) {
    case 'github':
    case 'gitea': {
      const token = env.GITEA_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN;
      if (!token) throw new Error('no GITHUB_TOKEN (or GITEA_TOKEN) to comment with');
      const api = (env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');
      const headers = {
        authorization: src.provider === 'gitea' ? `token ${token}` : `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'content-type': 'application/json',
        'user-agent': 'forumulate-cli',
      };
      const base = `${api}/repos/${src.repository}/issues`;
      const list = (await call(`${base}/${src.number}/comments?per_page=100`, { headers })) as
        | { id: number; body?: string }[]
        | null;
      const mine = list?.find((c) => c.body?.includes(marker));
      if (mine)
        await call(`${base}/comments/${mine.id}`, { method: 'PATCH', headers, body: JSON.stringify({ body }) });
      else await call(`${base}/${src.number}/comments`, { method: 'POST', headers, body: JSON.stringify({ body }) });
      return src.url ?? `${src.repository}#${src.number}`;
    }
    case 'gitlab': {
      const token = env.GITLAB_TOKEN;
      if (!token) throw new Error('no GITLAB_TOKEN to comment with (CI_JOB_TOKEN cannot write notes)');
      const api = (env.CI_API_V4_URL || 'https://gitlab.com/api/v4').replace(/\/$/, '');
      const headers = { 'private-token': token, 'content-type': 'application/json' };
      const base = `${api}/projects/${encodeURIComponent(src.repository)}/merge_requests/${src.number}/notes`;
      const list = (await call(`${base}?per_page=100`, { headers })) as { id: number; body?: string }[] | null;
      const mine = list?.find((n) => n.body?.includes(marker));
      if (mine) await call(`${base}/${mine.id}`, { method: 'PUT', headers, body: JSON.stringify({ body }) });
      else await call(base, { method: 'POST', headers, body: JSON.stringify({ body }) });
      return src.url ?? `${src.repository}!${src.number}`;
    }
    case 'bitbucket': {
      const token = env.BITBUCKET_TOKEN;
      if (!token) throw new Error('no BITBUCKET_TOKEN (a repository access token) to comment with');
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      const base = `https://api.bitbucket.org/2.0/repositories/${src.repository}/pullrequests/${src.number}/comments`;
      const list = (await call(`${base}?pagelen=100`, { headers })) as
        | { values?: { id: number; content?: { raw?: string } }[] }
        | null;
      const mine = list?.values?.find((c) => c.content?.raw?.includes(marker));
      const payload = JSON.stringify({ content: { raw: body } });
      if (mine) await call(`${base}/${mine.id}`, { method: 'PUT', headers, body: payload });
      else await call(base, { method: 'POST', headers, body: payload });
      return src.url ?? `${src.repository}#${src.number}`;
    }
    default:
      throw new Error(
        `no built-in commenter for ${src.provider}; post previews[].comment from \`--json\` with your host's tool`,
      );
  }
}
