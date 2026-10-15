/**
 * Why an operation stopped before anything was sent.
 *
 * - `INVALID_SITE`: the site is not an `http(s)://host` origin.
 * - `INVALID_KEY`: the key breaks the protocol's format (8-128 of `a-z A-Z 0-9 -`).
 * - `INVALID_URL`: a URL or path could not be turned into an `http(s)` URL.
 * - `INVALID_OPTION`: some other option has an impossible value.
 * - `FOREIGN_HOST`: a URL or the key location is on another host than the site.
 * - `NO_URLS`: there was nothing to submit.
 * - `SITEMAP`: a sitemap could not be fetched or parsed.
 * - `KEY_FILE`: the key file in the public directory is missing, ambiguous or wrong.
 */
export type IndexNowErrorCode =
  | 'INVALID_SITE'
  | 'INVALID_KEY'
  | 'INVALID_URL'
  | 'INVALID_OPTION'
  | 'FOREIGN_HOST'
  | 'NO_URLS'
  | 'SITEMAP'
  | 'KEY_FILE';

/** An error with a stable `code` and a message written for a person to read. */
export class IndexNowError extends Error {
  readonly code: IndexNowErrorCode;
  /** Extra lines, such as the URLs that were rejected. */
  readonly details: string[];

  constructor(code: IndexNowErrorCode, message: string, details: string[] = []) {
    super(message);
    this.name = 'IndexNowError';
    this.code = code;
    this.details = details;
  }
}
