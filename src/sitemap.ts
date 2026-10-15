import { gunzipSync } from 'node:zlib';
import { IndexNowError } from './errors.js';
import { USER_AGENT } from './version.js';

/** What a single sitemap document holds. */
export interface ParsedSitemap {
  /** `urlset` lists pages; `sitemapindex` lists other sitemaps. */
  kind: 'urlset' | 'sitemapindex';
  /** Every `<loc>` value, entity-decoded, in document order. */
  locs: string[];
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (match, name: string) => {
    if (name[0] === '#') {
      const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : match;
    }
    return ENTITIES[name.toLowerCase()] ?? match;
  });
}

/**
 * Parses one sitemap XML document (sitemaps.org protocol). Only the plain
 * `<loc>` elements count; `<image:loc>` and other extension tags are ignored.
 * Throws `SITEMAP` when the document has neither `<urlset>` nor `<sitemapindex>`.
 */
export function parseSitemap(xml: string): ParsedSitemap {
  const text = xml.replace(/<!--[\s\S]*?-->/g, '');
  const root = /<(?:[A-Za-z_][\w.-]*:)?(urlset|sitemapindex)[\s>]/.exec(text);
  if (!root) {
    throw new IndexNowError('SITEMAP', 'This is not a sitemap: it has no <urlset> or <sitemapindex> element.');
  }
  const locs: string[] = [];
  const pattern = /<loc>\s*(?:<!\[CDATA\[([\s\S]*?)\]\]>|([^<]*?))\s*<\/loc>/g;
  for (const match of text.matchAll(pattern)) {
    const value = match[1] !== undefined ? match[1].trim() : decodeEntities(match[2] ?? '').trim();
    if (value) locs.push(value);
  }
  return { kind: root[1] as ParsedSitemap['kind'], locs };
}

/** Options for {@link readSitemap}. */
export interface ReadSitemapOptions {
  /** A `fetch` implementation. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Milliseconds before each request is abandoned. Default `30000`. */
  timeoutMs?: number;
  /** How many levels of sitemap index files to follow. Default `3`. */
  maxDepth?: number;
  /** The most sitemap files to fetch in total. Default `1000`. */
  maxSitemaps?: number;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function fetchSitemap(url: string, options: ReadSitemapOptions): Promise<string> {
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    });
  } catch (error) {
    throw new IndexNowError('SITEMAP', `Could not fetch the sitemap ${url}: ${(error as Error).message}.`);
  }
  if (!res.ok) {
    throw new IndexNowError('SITEMAP', `Could not read the sitemap ${url}: HTTP ${res.status}.`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (isGzip(bytes)) {
    try {
      return gunzipSync(bytes).toString('utf8');
    } catch (error) {
      throw new IndexNowError('SITEMAP', `The sitemap ${url} looks gzipped but could not be decompressed: ${(error as Error).message}.`);
    }
  }
  return new TextDecoder('utf-8').decode(bytes);
}

/**
 * Fetches a sitemap and returns every page URL in it, following sitemap index
 * files recursively. Gzipped sitemaps (`.xml.gz`) are decompressed with
 * `node:zlib`. URLs are returned in document order, duplicates included;
 * {@link submit} removes duplicates.
 */
export async function readSitemap(url: string, options: ReadSitemapOptions = {}): Promise<string[]> {
  const maxDepth = options.maxDepth ?? 3;
  const maxSitemaps = options.maxSitemaps ?? 1000;
  const seen = new Set<string>();
  const urls: string[] = [];

  async function visit(sitemapUrl: string, depth: number): Promise<void> {
    if (seen.has(sitemapUrl)) return;
    if (seen.size >= maxSitemaps) {
      throw new IndexNowError('SITEMAP', `Stopped after ${maxSitemaps} sitemap files; raise maxSitemaps if that is expected.`);
    }
    seen.add(sitemapUrl);
    const xml = await fetchSitemap(sitemapUrl, options);
    let parsed: ParsedSitemap;
    try {
      parsed = parseSitemap(xml);
    } catch (error) {
      throw new IndexNowError('SITEMAP', `${sitemapUrl}: ${(error as Error).message}`);
    }
    if (parsed.kind === 'urlset') {
      urls.push(...parsed.locs);
      return;
    }
    if (depth >= maxDepth) {
      throw new IndexNowError('SITEMAP', `${sitemapUrl} is a sitemap index nested more than ${maxDepth} levels deep.`);
    }
    for (const child of parsed.locs) {
      let childUrl: string;
      try {
        childUrl = new URL(child, sitemapUrl).href;
      } catch {
        throw new IndexNowError('SITEMAP', `${sitemapUrl} lists "${child}", which is not a URL.`);
      }
      await visit(childUrl, depth + 1);
    }
  }

  await visit(url, 0);
  return urls;
}
