import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EXIT, main } from '../src/commands.js';
import { VERSION } from '../src/index.js';
import { KEY, captureIo, startServer, tempDir, urlset, type TestServer } from './helpers.js';

let server: TestServer;
let cwd: string;
let cleanup: () => Promise<void>;
let endpoint: string;

beforeEach(async () => {
  ({ dir: cwd, cleanup } = await tempDir());
  await mkdir(join(cwd, 'public'));
  await writeFile(join(cwd, 'public', `${KEY}.txt`), KEY);
  server = await startServer({ '/indexnow': { status: 200 }, [`/${KEY}.txt`]: { body: KEY } });
  server.routes.set('/sitemap.xml', { body: urlset([`${server.origin}/`, `${server.origin}/about`, `${server.origin}/about`]) });
  endpoint = `${server.origin}/indexnow`;
});
afterEach(async () => {
  await server.close();
  await cleanup();
});

const io = (extra: Parameters<typeof captureIo>[0] = {}) => captureIo({ cwd, ...extra });

describe('general', () => {
  it('prints help and exits 0', async () => {
    const out = io();
    expect(await main(['--help'], out)).toBe(EXIT.OK);
    expect(out.out()).toMatch(/Usage:/);
    expect(await main([], io())).toBe(EXIT.OK);
  });

  it('prints the version from package.json', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
    const out = io();
    expect(await main(['--version'], out)).toBe(EXIT.OK);
    expect(out.out().trim()).toBe(pkg.version);
    expect(VERSION).toBe(pkg.version);
  });

  it('exits 2 for an unknown command or option', async () => {
    const a = io();
    expect(await main(['publish'], a)).toBe(EXIT.USAGE);
    expect(a.err()).toMatch(/Unknown command "publish"/);
    const b = io();
    expect(await main(['submit', '--sitemaps', 'x'], b)).toBe(EXIT.USAGE);
    expect(b.err()).toMatch(/Unknown option/);
    expect(await main(['key', '--site', server.origin], io())).toBe(EXIT.USAGE);
  });
});

describe('submit', () => {
  it('reads the sitemap, discovers the key, verifies it and submits once per batch', async () => {
    const out = io();
    expect(await main(['submit', '--site', server.origin, '--endpoint', endpoint], out)).toBe(EXIT.OK);
    const [request] = server.submissions();
    expect(JSON.parse(request?.body ?? '')).toEqual({
      host: new URL(server.origin).host,
      key: KEY,
      urlList: [`${server.origin}/`, `${server.origin}/about`],
    });
    expect(server.requests.map((r) => r.path)).toEqual(['/sitemap.xml', `/${KEY}.txt`, '/indexnow']);
    expect(out.out()).toMatch(/HTTP 200/);
    expect(out.err()).toMatch(/Dropped 1 duplicate URL/);
  });

  it('submits only the given paths, without reading the sitemap', async () => {
    expect(await main(['submit', '/services', 'about', '--site', server.origin, '--endpoint', endpoint], io())).toBe(EXIT.OK);
    expect(server.requests.some((r) => r.path === '/sitemap.xml')).toBe(false);
    expect(JSON.parse(server.submissions()[0]?.body ?? '').urlList).toEqual([`${server.origin}/services`, `${server.origin}/about`]);
  });

  it('reads URLs from stdin, skipping blank lines and comments, and takes the site from them', async () => {
    const stdinText = `# changed today\n${server.origin}/a\n\n${server.origin}/b\n`;
    expect(await main(['submit', '--stdin', '--endpoint', endpoint], io({ stdinText }))).toBe(EXIT.OK);
    expect(JSON.parse(server.submissions()[0]?.body ?? '').urlList).toEqual([`${server.origin}/a`, `${server.origin}/b`]);
  });

  it('takes the key from INDEXNOW_KEY and the site from INDEXNOW_SITE', async () => {
    const key = 'env-provided-key';
    server.routes.set(`/${key}.txt`, { body: key });
    const env = { INDEXNOW_KEY: key, INDEXNOW_SITE: server.origin };
    expect(await main(['submit', '/a', '--endpoint', endpoint, '--public-dir', 'nowhere'], io({ env }))).toBe(EXIT.OK);
    expect(JSON.parse(server.submissions()[0]?.body ?? '').key).toBe(key);
  });

  it('prints the payload and sends nothing on --dry-run', async () => {
    const out = io();
    expect(await main(['submit', '/a', '/b', '--site', server.origin, '--endpoint', endpoint, '--dry-run', '--skip-verify'], out)).toBe(EXIT.OK);
    expect(server.requests).toHaveLength(0);
    expect(out.out()).toContain(`POST ${endpoint}`);
    expect(JSON.parse(out.out().slice(out.out().indexOf('{')))).toEqual({
      host: new URL(server.origin).host,
      key: KEY,
      urlList: [`${server.origin}/a`, `${server.origin}/b`],
    });
    expect(out.err()).toMatch(/nothing was sent/);
  });

  it('exits 1 without submitting when the key file is not live', async () => {
    server.routes.delete(`/${KEY}.txt`);
    const out = io();
    expect(await main(['submit', '/a', '--site', server.origin, '--endpoint', endpoint], out)).toBe(EXIT.FAILED);
    expect(server.submissions()).toHaveLength(0);
    expect(out.err()).toMatch(/HTTP 404/);
  });

  it.each([400, 403, 422, 429])('exits 1 and explains an HTTP %i response', async (status) => {
    server.routes.set('/indexnow', { status });
    const out = io();
    expect(await main(['submit', '/a', '--site', server.origin, '--endpoint', endpoint], out)).toBe(EXIT.FAILED);
    expect(out.err()).toContain(`HTTP ${status}`);
  });

  it('exits 2, sending nothing, for a URL on another host', async () => {
    const out = io();
    expect(await main(['submit', 'https://other.example/a', '--site', server.origin, '--endpoint', endpoint], out)).toBe(EXIT.USAGE);
    expect(out.err()).toMatch(/not on 127\.0\.0\.1/);
    expect(out.err()).toContain('https://other.example/a');
    expect(server.requests).toHaveLength(0);
  });

  it('exits 2 without a site, a key, or with a bad key or batch size', async () => {
    expect(await main(['submit', '/a'], io())).toBe(EXIT.USAGE);
    expect(await main(['submit', '/a', '--site', server.origin, '--public-dir', 'empty'], io())).toBe(EXIT.USAGE);
    expect(await main(['submit', '/a', '--site', server.origin, '--key', 'no'], io())).toBe(EXIT.USAGE);
    expect(await main(['submit', '/a', '--site', server.origin, '--batch-size', '20000'], io())).toBe(EXIT.USAGE);
    expect(server.requests).toHaveLength(0);
  });

  it('exits 1 when the sitemap cannot be read', async () => {
    server.routes.delete('/sitemap.xml');
    const out = io();
    expect(await main(['submit', '--site', server.origin, '--endpoint', endpoint], out)).toBe(EXIT.FAILED);
    expect(out.err()).toMatch(/Could not read the sitemap .*HTTP 404/);
  });
});

describe('verify', () => {
  it('exits 0 when the key file is served', async () => {
    const out = io();
    expect(await main(['verify', '--site', server.origin], out)).toBe(EXIT.OK);
    expect(out.out()).toMatch(/serves the key/);
  });

  it('exits 1 when it is not', async () => {
    server.routes.set(`/${KEY}.txt`, { body: 'stale' });
    const out = io();
    expect(await main(['verify', '--site', server.origin], out)).toBe(EXIT.FAILED);
    expect(out.err()).toMatch(/does not contain the key/);
  });

  it('checks --key-location', async () => {
    server.routes.set('/k/key.txt', { body: KEY });
    expect(await main(['verify', '--site', server.origin, '--key-location', '/k/key.txt'], io())).toBe(EXIT.OK);
  });
});

describe('key', () => {
  it('writes a new key file and prints the key', async () => {
    const dir = join(cwd, 'static');
    await mkdir(dir);
    const out = io();
    expect(await main(['key', '--public-dir', 'static'], out)).toBe(EXIT.OK);
    const key = out.out().trim();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(await readFile(join(dir, `${key}.txt`), 'utf8')).toBe(key);
  });

  it('refuses to replace an existing key without --force (exit 1)', async () => {
    const out = io();
    expect(await main(['key'], out)).toBe(EXIT.FAILED);
    expect(out.err()).toMatch(/already holds the key/);
    expect(await readdir(join(cwd, 'public'))).toEqual([`${KEY}.txt`]);
  });

  it('replaces it with --force', async () => {
    const out = io();
    expect(await main(['key', '--force'], out)).toBe(EXIT.OK);
    expect(await readdir(join(cwd, 'public'))).toEqual([`${out.out().trim()}.txt`]);
  });

  it('exits 2 when the public directory does not exist', async () => {
    const out = io();
    expect(await main(['key', '--public-dir', 'missing'], out)).toBe(EXIT.USAGE);
    expect(out.err()).toMatch(/does not exist/);
  });
});
