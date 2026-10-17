import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Http } from '../api/http';
import { run, type RunDeps } from '../run';

/**
 * A real HTTP server on 127.0.0.1 standing in for the API, so the transport,
 * retries, headers and paging are exercised over a socket rather than a
 * mocked `fetch`. Each handler sees the request and returns status/body; every
 * request is recorded for the test to assert on.
 */
export interface Seen {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: IncomingMessage['headers'];
  body: unknown;
  raw: string;
}

export interface Reply {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export type Handler = (req: Seen) => Reply | undefined;

export interface FakeApi {
  url: string;
  seen: Seen[];
  /** Add a route: `on('GET /orgs/acme/spaces', …)`; first match wins, later `on` calls are tried first. */
  on: (route: string, reply: Reply | Handler) => void;
  close: () => Promise<void>;
  /** Run the CLI against this server; collects stdout/stderr. */
  cli: (
    argv: string[],
    extra?: Partial<RunDeps>,
  ) => Promise<{ code: number; out: string; err: string }>;
}

export async function fakeApi(): Promise<FakeApi> {
  const routes: { route: string; handler: Handler }[] = [];
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.replace(/^\/api/, '');
      let body: unknown = raw;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        /* multipart or text: keep raw */
      }
      const s: Seen = {
        method: req.method ?? 'GET',
        path,
        query: Object.fromEntries(url.searchParams),
        headers: req.headers,
        body,
        raw,
      };
      seen.push(s);
      let reply: Reply | undefined;
      for (const r of routes) {
        const [m, p] = r.route.split(' ');
        if (m !== s.method || p !== path) continue;
        reply = r.handler(s);
        if (reply) break;
      }
      reply ??= {
        status: 404,
        body: { error: { code: 'not_found', message: `no fake for ${s.method} ${path}` } },
      };
      const text =
        typeof reply.body === 'string'
          ? reply.body
          : reply.body === undefined
            ? ''
            : JSON.stringify(reply.body);
      res.writeHead(reply.status ?? 200, {
        'content-type': typeof reply.body === 'string' ? 'text/html' : 'application/json',
        ...(reply.headers ?? {}),
      });
      res.end(text);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const api: FakeApi = {
    url,
    seen,
    on: (route, reply) => {
      routes.unshift({ route, handler: typeof reply === 'function' ? reply : () => reply });
    },
    close: () => new Promise((r) => server.close(() => r())),
    cli: async (argv, extra = {}) => {
      const out: string[] = [];
      const err: string[] = [];
      const http = new Http({
        baseUrl: url,
        token: 'pat_test',
        userAgent: 'cli-test',
        sleep: async () => {},
      });
      const code = await run(argv, {
        client: {} as never,
        http,
        env: { FORUMULATE_CONFIG_DIR: '/nonexistent-forumulate-test' },
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        ...extra,
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    },
  };
  return api;
}

export const SPACE_ID = '11111111-2222-4333-8444-555555555555';
export const ITEM_ID = '99999999-2222-4333-8444-555555555555';
