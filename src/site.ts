import { IndexNowError } from './errors.js';

/** A site origin that has been checked: `https://example.com`, with its host. */
export interface Site {
  /** `https://example.com` (no trailing slash). */
  origin: string;
  /** `example.com`, or `example.com:8080` when the port is not the default. */
  host: string;
}

/**
 * Parses a site origin. A trailing slash is fine; a path, query or fragment is
 * not, because the key file and the default sitemap both live at the root.
 */
export function parseSite(site: string): Site {
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    throw new IndexNowError('INVALID_SITE', `The site must be a full URL such as https://example.com (got "${site}").`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new IndexNowError('INVALID_SITE', `The site must use http or https (got "${url.protocol}").`);
  }
  if ((url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) {
    throw new IndexNowError(
      'INVALID_SITE',
      `The site must be an origin such as ${url.origin}, without a path (got "${site}"). Pass full URLs to submit pages under a path.`,
    );
  }
  return { origin: url.origin, host: url.host };
}

/**
 * Turns a full URL or a site-relative path into an absolute URL string.
 * `/about`, `about` and `https://example.com/about` all give the same result.
 * The fragment is dropped: engines ignore it, and it would defeat de-duplication.
 */
export function resolveUrl(site: Site, input: string): string {
  const value = input.trim();
  let url: URL;
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
      url = new URL(value);
    } else {
      url = new URL(value.startsWith('/') ? value : `/${value}`, `${site.origin}/`);
    }
  } catch {
    throw new IndexNowError('INVALID_URL', `"${input}" is not a valid URL or path.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new IndexNowError('INVALID_URL', `"${input}" is not an http or https URL.`);
  }
  url.hash = '';
  return url.href;
}
