/**
 * Tell Bing and the other IndexNow search engines which pages changed.
 *
 * @packageDocumentation
 */
export { IndexNowError, type IndexNowErrorCode } from './errors.js';
export { parseSite, resolveUrl, type Site } from './site.js';
export {
  KEY_PATTERN,
  assertValidKey,
  findKey,
  generateKey,
  isValidKey,
  keyFileUrl,
  verifyKey,
  writeKeyFile,
  type FoundKey,
  type VerifyKeyOptions,
  type VerifyKeyResult,
  type WriteKeyFileOptions,
  type WriteKeyFileResult,
} from './key.js';
export { parseSitemap, readSitemap, type ParsedSitemap, type ReadSitemapOptions } from './sitemap.js';
export {
  DEFAULT_ENDPOINT,
  MAX_URLS_PER_REQUEST,
  describeStatus,
  prepareSubmission,
  submit,
  type BatchResult,
  type IndexNowPayload,
  type PrepareOptions,
  type PreparedSubmission,
  type SubmitOptions,
  type SubmitResult,
} from './submit.js';
export { USER_AGENT, VERSION } from './version.js';
