import { describe, expect, it } from 'vitest';
import { jobOf, reportWait, timeoutOf, waitForJob, WAIT_EXIT, type JobRef } from './job-wait';
import type { CommandDeps } from './context';

/**
 * FMU-D03 `--wait`: one poller for every job, exit 0 completed / 1 failed or
 * canceled / 124 timed out, on a fake clock and a scripted API.
 */
const job = (state: string, extra: Partial<JobRef> = {}): JobRef & { links: object } => ({
  id: 'j1',
  kind: 'org.import',
  state,
  links: { self: '/api/orgs/o/jobs/j1' },
  ...extra,
});

function deps(answers: unknown[]) {
  const out: string[] = [];
  const err: string[] = [];
  const paths: string[] = [];
  const d = {
    http: {
      send: async (req: { path: string; query?: Record<string, string> }) => {
        paths.push(`${req.path}?kind=${req.query?.kind ?? ''}`);
        return { data: answers.shift(), status: 200, headers: new Map() };
      },
    },
    out: (l: string) => out.push(l),
    err: (l: string) => err.push(l),
  } as unknown as CommandDeps;
  return { d, out, err, paths };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

describe('jobOf', () => {
  it('finds the job in a status answer or nested under `job`', () => {
    expect(jobOf(job('queued'))?.id).toBe('j1');
    expect(jobOf({ spec: {}, job: job('queued') })?.id).toBe('j1');
    expect(jobOf({ spec: {}, generated: 3 })).toBeNull();
  });
});

describe('waitForJob', () => {
  it('polls the shared job route until completed: exit 0', async () => {
    const { d, paths } = deps([job('running', { progress: { done: 1, total: 2 } }), job('completed')]);
    const r = await waitForJob(d, 'acme', job('queued'), { timeoutSeconds: 60, ...clock() });
    expect(r.code).toBe(WAIT_EXIT.completed);
    expect(paths).toEqual(['/orgs/acme/jobs/j1?kind=org.import', '/orgs/acme/jobs/j1?kind=org.import']);
  });

  it('a failed or canceled job exits 1 and says why', async () => {
    const { d, err } = deps([job('failed', { error: { code: 'job.failed', message: 'bad row 7' } })]);
    const r = await waitForJob(d, 'acme', job('running'), { timeoutSeconds: 60, ...clock() });
    expect(r.code).toBe(WAIT_EXIT.failed);
    expect(reportWait(d, r, false)).toBe(1);
    expect(err.at(-1)).toContain('bad row 7');
    const c = deps([job('canceled')]);
    expect((await waitForJob(c.d, 'acme', job('running'), { timeoutSeconds: 60, ...clock() })).code).toBe(1);
  });

  it('stops at --timeout with exit 124, and the job keeps running', async () => {
    const { d, err } = deps(Array.from({ length: 50 }, () => job('running')));
    const r = await waitForJob(d, 'acme', job('running'), { timeoutSeconds: 5, ...clock() });
    expect(r.code).toBe(WAIT_EXIT.timeout);
    reportWait(d, r, false);
    expect(err.at(-1)).toContain('exit 124');
  });

  it('an already-final job answers at once, without a request', async () => {
    const { d, paths } = deps([]);
    expect((await waitForJob(d, 'acme', job('completed'), { timeoutSeconds: 1, ...clock() })).code).toBe(0);
    expect(paths).toEqual([]);
  });
});

describe('timeoutOf', () => {
  it('defaults to 600 and never answers 0', () => {
    expect(timeoutOf(undefined)).toBe(600);
    expect(timeoutOf('0')).toBe(600);
    expect(timeoutOf('abc')).toBe(600);
    expect(timeoutOf('90')).toBe(90);
  });
});
