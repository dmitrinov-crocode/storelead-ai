import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Tiny local HTTP server for audit tests.
 *
 * The audit is defined by how a real browser reacts to real responses — status
 * codes, missing assets, slow replies — so the checks are tested against actual
 * traffic rather than a mocked Playwright API.
 */

export interface FixtureRoute {
  status?: number;
  contentType?: string;
  body?: string | Buffer;
  headers?: Record<string, string>;
  /** Delays the response, for timeout and throttling tests. */
  delayMs?: number;
}

export type RouteHandler = (req: IncomingMessage, res: ServerResponse) => void;

export interface RequestRecord {
  method: string;
  url: string;
  at: number;
}

export interface FixtureServer {
  /** Origin without a trailing slash, e.g. `http://127.0.0.1:53412`. */
  url: string;
  requests: RequestRecord[];
  /** Requests for one path, in arrival order. */
  hits(path: string): RequestRecord[];
  close(): Promise<void>;
}

function send(res: ServerResponse, route: FixtureRoute): void {
  const body = route.body ?? '';
  res.writeHead(route.status ?? 200, {
    'content-type': route.contentType ?? 'text/html; charset=utf-8',
    ...route.headers,
  });
  res.end(body);
}

export async function startFixtureServer(
  routes: Record<string, FixtureRoute | RouteHandler>,
): Promise<FixtureServer> {
  const requests: RequestRecord[] = [];

  const server: Server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/';
    requests.push({ method: req.method ?? 'GET', url: req.url ?? '/', at: Date.now() });

    const route = routes[path];
    if (!route) {
      res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<h1>Not Found</h1>');
      return;
    }
    if (typeof route === 'function') {
      route(req, res);
      return;
    }
    if (route.delayMs) {
      setTimeout(() => send(res, route), route.delayMs);
      return;
    }
    send(res, route);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    hits: (path) => requests.filter((r) => (r.url.split('?')[0] ?? '') === path),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/** Minimal but valid storefront-ish HTML, so tests only spell out what they assert. */
export function html(body: string, head = ''): string {
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">${head}</head>
<body>${body}</body></html>`;
}
