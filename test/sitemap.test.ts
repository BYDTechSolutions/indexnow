import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseSitemap, readSitemap } from '../src/index.js';
import { sitemapIndex, startServer, urlset, type TestServer } from './helpers.js';

describe('parseSitemap', () => {
  it('reads every <loc> of a urlset', () => {
    const parsed = parseSitemap(urlset(['https://example.com/', 'https://example.com/about']));
    expect(parsed).toEqual({ kind: 'urlset', locs: ['https://example.com/', 'https://example.com/about'] });
  });

  it('recognizes a sitemap index', () => {
    expect(parseSitemap(sitemapIndex(['https://example.com/a.xml'])).kind).toBe('sitemapindex');
  });

  it('decodes entities and CDATA, and trims whitespace', () => {
    const xml = `<urlset>
      <url><loc>
        https://example.com/?a=1&amp;b=2
      </loc></url>
      <url><loc><![CDATA[https://example.com/?c=3&d=4]]></loc></url>
      <url><loc>https://example.com/caf&#xE9;</loc></url>
    </urlset>`;
    expect(parseSitemap(xml).locs).toEqual([
      'https://example.com/?a=1&b=2',
      'https://example.com/?c=3&d=4',
      'https://example.com/café',
    ]);
  });

  it('ignores image locations, comments and empty locs', () => {
    const xml = `<urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
      <!-- <url><loc>https://example.com/commented</loc></url> -->
      <url>
        <loc>https://example.com/page</loc>
        <image:image><image:loc>https://example.com/photo.jpg</image:loc></image:image>
      </url>
      <url><loc></loc></url>
    </urlset>`;
    expect(parseSitemap(xml).locs).toEqual(['https://example.com/page']);
  });

  it('rejects a document that is not a sitemap', () => {
    expect(() => parseSitemap('<html><body>Not found</body></html>')).toThrow(/not a sitemap/);
  });
});

describe('readSitemap', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startServer();
  });
  afterEach(() => server.close());

  it('reads a plain sitemap', async () => {
    server.routes.set('/sitemap.xml', { body: urlset([`${server.origin}/`, `${server.origin}/a`]) });
    expect(await readSitemap(`${server.origin}/sitemap.xml`)).toEqual([`${server.origin}/`, `${server.origin}/a`]);
  });

  it('follows sitemap index files recursively, resolving relative children', async () => {
    const o = server.origin;
    server.routes.set('/sitemap.xml', { body: sitemapIndex([`${o}/pages.xml`, '/nested-index.xml']) });
    server.routes.set('/nested-index.xml', { body: sitemapIndex([`${o}/posts.xml`]) });
    server.routes.set('/pages.xml', { body: urlset([`${o}/`, `${o}/about`]) });
    server.routes.set('/posts.xml', { body: urlset([`${o}/blog/one`]) });
    expect(await readSitemap(`${o}/sitemap.xml`)).toEqual([`${o}/`, `${o}/about`, `${o}/blog/one`]);
  });

  it('decompresses a gzipped sitemap', async () => {
    const o = server.origin;
    server.routes.set('/sitemap.xml.gz', {
      headers: { 'content-type': 'application/gzip' },
      body: gzipSync(urlset([`${o}/zipped`])),
    });
    expect(await readSitemap(`${o}/sitemap.xml.gz`)).toEqual([`${o}/zipped`]);
  });

  it('fetches each sitemap once even when the index loops', async () => {
    const o = server.origin;
    server.routes.set('/a.xml', { body: sitemapIndex([`${o}/b.xml`, `${o}/a.xml`]) });
    server.routes.set('/b.xml', { body: urlset([`${o}/x`]) });
    expect(await readSitemap(`${o}/a.xml`)).toEqual([`${o}/x`]);
    expect(server.requests.map((r) => r.path)).toEqual(['/a.xml', '/b.xml']);
  });

  it('stops at the depth limit', async () => {
    const o = server.origin;
    server.routes.set('/0.xml', { body: sitemapIndex([`${o}/1.xml`]) });
    server.routes.set('/1.xml', { body: sitemapIndex([`${o}/2.xml`]) });
    server.routes.set('/2.xml', { body: urlset([`${o}/deep`]) });
    await expect(readSitemap(`${o}/0.xml`, { maxDepth: 1 })).rejects.toThrow(/nested more than 1 levels/);
  });

  it('reports the HTTP status of a missing sitemap', async () => {
    await expect(readSitemap(`${server.origin}/sitemap.xml`)).rejects.toThrow(/HTTP 404/);
  });

  it('names the file that is not a sitemap', async () => {
    server.routes.set('/sitemap.xml', { body: '<html></html>' });
    await expect(readSitemap(`${server.origin}/sitemap.xml`)).rejects.toThrow(/sitemap\.xml: This is not a sitemap/);
  });
});
