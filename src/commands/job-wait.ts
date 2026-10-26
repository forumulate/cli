import type { CommandDeps } from './context';

/**
 * `--wait [--timeout <seconds>]` on every command that starts a background
 * job, and `forumulate jobs wait <id>` (FMU-D03).
 *
 * A CI step that starts a resync, an import or a manifest apply wants one
 * thing: block until it is done and say how it went in the exit code. Each
 * feature used to answer its own status shape, so every script wrote its own
 * poller; the API now answers one job object everywhere, and this is the one
 * poller.
 *
 * Exit codes (the same table as the API's own `JOB_WAIT_EXIT`, kept here
 * because the CLI does not depend on the package that holds it): 0 completed, 1 failed or canceled, 124 timed
 * out — 124 because that is what `timeout(1)` exits with, so a pipeline that
 * already handles a timed-out step handles this one.
 */
export const WAIT_EXIT = { completed: 0, failed: 1, timeout: 124 } as const;
export const FINAL_STATES = ['completed', 'failed', 'canceled'] as const;
/** The default `--timeout`, in seconds. */
export const DEFAULT_WAIT_SECONDS = 600;

export interface JobRef {
  id: string;
  kind?: string;
  state: string;
  error?: { code?: string; message?: string } | null;
  progress?: { done?: number; total?: number };
}

const looksLikeJob = (v: unknown): v is JobRef =>
  !!v &&
  typeof v === 'object' &&
  typeof (v as JobRef).id === 'string' &&
  typeof (v as JobRef).state === 'string' &&
  'links' in (v as object);

/**
 * The job a command's answer carries: the answer itself (a status route, an
 * import's 202), or its `job` (a resync's `{spec, job}`, a manifest apply's
 * `{steps, job}`). Null when the work already finished inline (a resync run
 * without `--background`), which `--wait` treats as done.
 */
export function jobOf(answer: unknown): JobRef | null {
  if (looksLikeJob(answer)) return answer;
  const nested = (answer as { job?: unknown } | null)?.job;
  return looksLikeJob(nested) ? nested : null;
}

export interface WaitOptions {
  timeoutSeconds: number;
  /** Poll interval; grows to 10 s so a long job is not polled every second for ten minutes. */
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** `--timeout 90` → 90; a missing or junk value is the default, never 0 (which would never wait). */
export function timeoutOf(raw: string | undefined): number {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 24 * 3600) : DEFAULT_WAIT_SECONDS;
}

/** Poll `GET /orgs/{orgId}/jobs/{id}` until the job is final or the timeout passes. */
export async function waitForJob(
  deps: CommandDeps,
  orgId: string,
  start: JobRef,
  opts: WaitOptions,
): Promise<{ code: number; job: JobRef }> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const deadline = now() + opts.timeoutSeconds * 1000;
  let interval = opts.intervalMs ?? 1000;
  let job = start;
  let lastLine = '';
  for (;;) {
    if ((FINAL_STATES as readonly string[]).includes(job.state)) {
      return { code: job.state === 'completed' ? WAIT_EXIT.completed : WAIT_EXIT.failed, job };
    }
    const line = `${job.kind ?? 'job'} ${job.id}: ${job.state}${
      job.progress?.total ? ` (${job.progress.done ?? 0}/${job.progress.total})` : ''
    }`;
    if (line !== lastLine) deps.err(line);
    lastLine = line;
    if (now() >= deadline) return { code: WAIT_EXIT.timeout, job };
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
    interval = Math.min(interval * 2, 10_000);
    const res = await deps.http.send({
      method: 'GET',
      path: `/orgs/${encodeURIComponent(orgId)}/jobs/${encodeURIComponent(job.id)}`,
      query: job.kind ? { kind: job.kind } : {},
    });
    if (looksLikeJob(res.data)) job = res.data;
  }
}

/** What `--wait` prints at the end: the outcome on stderr, the job (as JSON with `--json`) on stdout. */
export function reportWait(deps: CommandDeps, outcome: { code: number; job: JobRef }, json: boolean): number {
  const { code, job } = outcome;
  if (json) deps.out(JSON.stringify(job, null, 2));
  if (code === WAIT_EXIT.timeout) deps.err(`Still ${job.state} when --timeout passed (exit 124). The job keeps running: forumulate jobs wait ${job.id}`);
  else if (code === WAIT_EXIT.failed)
    deps.err(`${job.kind ?? 'Job'} ${job.id} ${job.state}${job.error?.message ? `: ${job.error.message}` : ''}`);
  else if (!json) deps.out(`${job.kind ?? 'Job'} ${job.id} completed.`);
  return code;
}
