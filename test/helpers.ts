import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CliIo } from '../src/commands.js';

export interface Recorded {
  method: string;
  path: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export interface Reply {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

export type Handler = (req: Recorded) => Reply | undefined;

export interface TestServer {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  requests: Recorded[];
  /** Requests whose path is `/indexnow`. */
  submissions: () => Recorded[];
  routes: Map<string, Reply | Handler>;
  close: () => Promise<void>;
}

/** A local server standing in for both the site (sitemap, key file) and an IndexNow endpoint. */
export async function startServer(routes: Record<string, Reply | Handler> = {}): Promise<TestServer> {
  const map = new Map<string, Reply | Handler>(Object.entries(routes));
  const requests: Recorded[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const recorded: Recorded = {
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      };
      requests.push(recorded);
      const route = map.get(recorded.path.split('?')[0] as string);
      const reply = typeof route === 'function' ? route(recorded) : route;
      if (!reply) {
        res.writeHead(404).end('not found');
        return;
      }
      res.writeHead(reply.status ?? 200, reply.headers ?? {});
      res.end(reply.body ?? '');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    submissions: () => requests.filter((r) => r.path === '/indexnow'),
    routes: map,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

export function urlset(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join('\n')}
</urlset>`;
}

export function sitemapIndex(urls: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <sitemap><loc>${u}</loc></sitemap>`).join('\n')}
</sitemapindex>`;
}

export async function tempDir(): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'indexnow-test-'));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export interface CapturedIo extends CliIo {
  out: () => string;
  err: () => string;
}

export function captureIo(overrides: Partial<CliIo> & { stdinText?: string } = {}): CapturedIo {
  let out = '';
  let err = '';
  const { stdinText, ...rest } = overrides;
  return {
    stdout: (t) => {
      out += t;
    },
    stderr: (t) => {
      err += t;
    },
    readStdin: async () => stdinText ?? '',
    env: {},
    cwd: process.cwd(),
    ...rest,
    out: () => out,
    err: () => err,
  };
}

export const KEY = '0123456789abcdef0123456789abcdef';
