import { randomUUID } from 'node:crypto';

/**
 * The one HTTP path `forumulate api` and the resource commands share.
 *
 * Not the SDK's `request`, for two reasons that are both about what a terminal
 * user sees when something goes wrong: its error drops the response headers, so
 * a 429's `Retry-After` was unreadable and the retry could only guess; and it
 * parses every body as JSON, so the edge's HTML block page (Cloudflare 1010)
 * surfaced as `Unexpected token <` instead of "the edge refused this".
 *
 * What it does on every call:
 *  - `Authorization: Bearer` from the stored token or `FORUMULATE_TOKEN`.
 *  - A named `User-Agent` — a default library UA is answered with a block page.
 *  - `Forumulate-Version` (default {@link DEFAULT_API_VERSION}), so collections
 *    answer the paging envelope `--paginate` walks.
 *  - `Idempotency-Key` on writes whose operation declares one, generated once
 *    per command and reused across retries — a retried POST is the same POST.
 *  - Retries: a 429 always (it was not processed), a 502/503/504 or a dropped
 *    connection only when the request is safe to repeat (GET/PUT/DELETE, or a
 *    write carrying an idempotency key). `Retry-After` is honoured, seconds or
 *    an HTTP date, capped so a bad header cannot park a CI job for an hour.
 */
export const DEFAULT_API_VERSION = '2026-12-01';

export interface HttpOptions {
  baseUrl: string;
  token?: string;
  /**
   * The global `--token` (FMU-DOC01): the bearer instead of `token`, except on
   * a request whose operation owns a `token` parameter (`tokenIsParam`) — there
   * the flag's value was that parameter, and `token` is the bearer.
   */
  flagToken?: string;
  userAgent: string;
  apiVersion?: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  /** Retries after the first attempt. Default 3. */
  retries?: number;
  /** Called before each retry, so a person watching knows why it paused. */
  onRetry?: (info: { attempt: number; waitMs: number; status?: number }) => void;
}

export interface HttpRequest {
  method: string;
  path: string;
  query?: Record<string, string | undefined>;
  body?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** Send `Idempotency-Key` (generated unless `headers` already carries one). */
  idempotent?: boolean;
  /**
   * Keep a 2xx answer as bytes (a Buffer in `data`): an SDK archive, a PDF, a
   * CSV export. Read as text, a zip comes back as replacement characters and
   * the file a person saves will not open.
   */
  raw?: boolean;
  /** `--token` was this operation's own `token` parameter, not the bearer (FMU-DOC01). */
  tokenIsParam?: boolean;
}

export interface HttpResponse {
  status: number;
  headers: Headers;
  /** Parsed JSON, or the text of a non-JSON answer, or undefined for an empty one. */
  data: unknown;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: Record<string, string[]>,
    readonly docs?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const sleeper = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const MAX_WAIT_MS = 60_000;

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date; undefined when absent or unreadable. */
export function retryAfterMs(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined;
  const secs = Number(value);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, MAX_WAIT_MS);
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  return Math.min(Math.max(at - now, 0), MAX_WAIT_MS);
}

export class Http {
  private readonly fetchImpl: typeof fetch;
  constructor(readonly opts: HttpOptions) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
  }

  get baseUrl(): string {
    return this.opts.baseUrl.replace(/\/+$/, '');
  }

  url(path: string, query: Record<string, string | undefined> = {}): string {
    const url = new URL(this.baseUrl + (path.startsWith('/') ? path : `/${path}`));
    for (const [k, v] of Object.entries(query)) if (v !== undefined) url.searchParams.set(k, v);
    return url.toString();
  }

  headersFor(req: HttpRequest): Record<string, string> {
    const h: Record<string, string> = {
      Accept: req.raw ? '*/*' : 'application/json',
      'User-Agent': this.opts.userAgent,
      'Forumulate-Version': this.opts.apiVersion ?? DEFAULT_API_VERSION,
    };
    const bearer = (req.tokenIsParam ? undefined : this.opts.flagToken) ?? this.opts.token;
    if (bearer) h.Authorization = `Bearer ${bearer}`;
    if (req.body !== undefined && !req.form) h['Content-Type'] = 'application/json';
    Object.assign(h, req.headers ?? {});
    const hasKey = Object.keys(h).some((k) => k.toLowerCase() === 'idempotency-key');
    if (req.idempotent && !hasKey) h['Idempotency-Key'] = randomUUID();
    return h;
  }

  async send(req: HttpRequest): Promise<HttpResponse> {
    const method = req.method.toUpperCase();
    const url = this.url(req.path, req.query);
    // Fixed once, outside the loop: the retry must carry the SAME key.
    const headers = this.headersFor(req);
    const repeatable =
      method === 'GET' ||
      method === 'PUT' ||
      method === 'DELETE' ||
      Object.keys(headers).some((k) => k.toLowerCase() === 'idempotency-key');
    const retries = this.opts.retries ?? 3;
    const sleep = this.opts.sleep ?? sleeper;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers,
          body: req.form ?? (req.body !== undefined ? JSON.stringify(req.body) : undefined),
        });
      } catch (e) {
        if (repeatable && attempt < retries) {
          const waitMs = 1000 * 2 ** attempt;
          this.opts.onRetry?.({ attempt: attempt + 1, waitMs });
          await sleep(waitMs);
          continue;
        }
        const cause = (e as { cause?: { code?: string } }).cause?.code;
        throw new ApiError(
          0,
          'network',
          `Could not reach ${this.baseUrl}${cause ? ` (${cause})` : ''}: ${(e as Error).message}`,
        );
      }
      const transient = res.status === 502 || res.status === 503 || res.status === 504;
      if ((res.status === 429 || (transient && repeatable)) && attempt < retries) {
        const waitMs = retryAfterMs(res.headers.get('retry-after')) ?? 1000 * 2 ** attempt;
        this.opts.onRetry?.({ attempt: attempt + 1, waitMs, status: res.status });
        await res.arrayBuffer().catch(() => undefined);
        await sleep(waitMs);
        continue;
      }
      if (req.raw && res.ok)
        return {
          status: res.status,
          headers: res.headers,
          data: Buffer.from(await res.arrayBuffer()),
        };
      const data = await readBody(res);
      if (!res.ok) throw toError(res, data);
      return { status: res.status, headers: res.headers, data };
    }
  }
}

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return undefined;
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('json') || /^[[{]/.test(text.trimStart())) {
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }
  return text;
}

function toError(res: Response, data: unknown): ApiError {
  const env = (
    data as {
      error?: {
        code?: string;
        message?: string;
        details?: Record<string, string[]>;
        docs?: string;
      };
    }
  )?.error;
  if (env && typeof env === 'object') {
    return new ApiError(
      res.status,
      env.code ?? 'error',
      env.message ?? res.statusText,
      env.details,
      env.docs,
    );
  }
  // Not our envelope: the edge, a proxy, or a crash page. Say which, briefly.
  const text = typeof data === 'string' ? data : '';
  const edge = /cloudflare|error code:? 10\d\d/i.test(text);
  const message = edge
    ? `${res.statusText || 'Refused'} by the edge in front of the API, not by the API (a Cloudflare block page)`
    : `${res.statusText || 'HTTP error'}${text ? `: ${text.replace(/\s+/g, ' ').slice(0, 200)}` : ''}`;
  return new ApiError(res.status, edge ? 'edge.blocked' : 'error', message);
}

/** The CLI's one error line, plus the field problems a 422 names. */
export function formatError(e: unknown): string[] {
  const err = e as {
    status?: number;
    code?: string;
    message?: string;
    details?: Record<string, string[]>;
    docs?: string;
  };
  const lines = [
    `Error${err.status ? ` ${err.status}` : ''}${err.code ? ` (${err.code})` : ''}: ${err.message ?? String(e)}`,
  ];
  for (const [field, problems] of Object.entries(err.details ?? {}))
    lines.push(`  ${field}: ${(problems ?? []).join('; ')}`);
  if (err.docs) lines.push(`  see: ${err.docs}`);
  return lines;
}
