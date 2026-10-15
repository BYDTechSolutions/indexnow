import { IndexNowError } from './errors.js';
import { assertValidKey, keyFileUrl } from './key.js';
import { parseSite, resolveUrl } from './site.js';
import { USER_AGENT } from './version.js';

/** The shared IndexNow endpoint; a submission there reaches every participating engine. */
export const DEFAULT_ENDPOINT = 'https://api.indexnow.org/indexnow';

/** The protocol's limit on URLs in one POST request. */
export const MAX_URLS_PER_REQUEST = 10_000;

/** The JSON body of one IndexNow POST request. */
export interface IndexNowPayload {
  host: string;
  key: string;
  /** Present only when the key file is not at `<site>/<key>.txt`. */
  keyLocation?: string;
  urlList: string[];
}

/** Options for {@link prepareSubmission}. */
export interface PrepareOptions {
  /** The site origin, such as `https://example.com`. Every URL must be on its host. */
  site: string;
  /** The IndexNow key. */
  key: string;
  /** Full URLs or site-relative paths (`/about`). */
  urls: string[];
  /** Where the key file is served when it is not `<site>/<key>.txt`. A path or a full URL on the same host. */
  keyLocation?: string;
  /** URLs per request, from 1 to {@link MAX_URLS_PER_REQUEST}. Default {@link MAX_URLS_PER_REQUEST}. */
  batchSize?: number;
}

/** The checked, de-duplicated, batched request bodies, before anything is sent. */
export interface PreparedSubmission {
  /** The site origin. */
  site: string;
  host: string;
  /** Every unique URL, in first-seen order. */
  urls: string[];
  /** How many inputs were dropped as duplicates. */
  duplicates: number;
  /** One request body per batch. */
  payloads: IndexNowPayload[];
  /** Things that will not stop the submission but may make engines ignore some URLs. */
  warnings: string[];
}

const SHOW_AT_MOST = 10;

/**
 * Checks and batches a submission without sending it: resolves paths against
 * the site, drops fragments and duplicates, rejects any URL on another host
 * (the engines answer 422 for the whole request), and splits the list into
 * requests of at most `batchSize` URLs.
 */
export function prepareSubmission(options: PrepareOptions): PreparedSubmission {
  const site = parseSite(options.site);
  assertValidKey(options.key);
  const batchSize = options.batchSize ?? MAX_URLS_PER_REQUEST;
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_URLS_PER_REQUEST) {
    throw new IndexNowError(
      'INVALID_OPTION',
      `The batch size must be a whole number from 1 to ${MAX_URLS_PER_REQUEST} (got ${batchSize}).`,
    );
  }

  const unique = new Set<string>();
  const foreign: string[] = [];
  let duplicates = 0;
  for (const input of options.urls) {
    if (!input.trim()) continue;
    const url = resolveUrl(site, input);
    if (new URL(url).host !== site.host) {
      foreign.push(url);
      continue;
    }
    if (unique.has(url)) duplicates += 1;
    else unique.add(url);
  }
  if (foreign.length) {
    const shown = foreign.slice(0, SHOW_AT_MOST);
    if (foreign.length > SHOW_AT_MOST) shown.push(`...and ${foreign.length - SHOW_AT_MOST} more`);
    throw new IndexNowError(
      'FOREIGN_HOST',
      `${foreign.length} URL${foreign.length === 1 ? ' is' : 's are'} not on ${site.host}. IndexNow refuses the whole request (HTTP 422) when any URL is on another host, so nothing was sent. Submit each host separately, with its own key.`,
      shown,
    );
  }
  const urls = [...unique];
  if (!urls.length) {
    throw new IndexNowError('NO_URLS', 'Nothing to submit: the list of URLs is empty.');
  }

  const warnings: string[] = [];
  let keyLocation: string | undefined;
  if (options.keyLocation !== undefined) {
    keyLocation = keyFileUrl(site.origin, options.key, options.keyLocation);
    const scope = new URL(keyLocation).pathname.replace(/[^/]*$/, '');
    if (scope !== '/') {
      const outside = urls.filter((url) => !new URL(url).pathname.startsWith(scope));
      if (outside.length) {
        warnings.push(
          `${outside.length} URL${outside.length === 1 ? ' is' : 's are'} outside ${scope}, the folder of the key file; engines may ignore ${outside.length === 1 ? 'it' : 'them'}. Serve the key from the site root to cover every URL.`,
        );
      }
    }
  }

  const payloads: IndexNowPayload[] = [];
  for (let i = 0; i < urls.length; i += batchSize) {
    payloads.push({
      host: site.host,
      key: options.key,
      ...(keyLocation ? { keyLocation } : {}),
      urlList: urls.slice(i, i + batchSize),
    });
  }
  return { site: site.origin, host: site.host, urls, duplicates, payloads, warnings };
}

/**
 * A sentence explaining an IndexNow response status, following the protocol's
 * documented meanings (https://www.indexnow.org/documentation).
 */
export function describeStatus(status: number, retryAfter?: string | null): string {
  switch (status) {
    case 200:
      return 'OK: the URLs were received. This does not mean they will be crawled or indexed.';
    case 202:
      return 'Accepted: the URLs were received and the key is still being validated. The engine will fetch your key file.';
    case 400:
      return 'Bad request: the engine rejected the request format. Check that every URL is a valid, encoded http(s) URL.';
    case 403:
      return 'Forbidden: the key is not valid. The key file was not found, or it does not contain the key. Run "indexnow verify" and deploy the key file.';
    case 422:
      return 'Unprocessable: some URLs do not belong to the host, or the key does not match the protocol format.';
    case 429: {
      const wait = retryAfter ? ` The engine asks you to wait (Retry-After: ${retryAfter}).` : '';
      return `Too many requests: the engine treats this as possible spam.${wait} Submit less often, and only URLs that changed.`;
    }
    default:
      if (status >= 500) return `HTTP ${status}: the engine had a server error. Try again later.`;
      if (status >= 200 && status < 300) return `HTTP ${status}: received.`;
      return `HTTP ${status}: not a documented IndexNow response; the submission was not accepted.`;
  }
}

/** Options for {@link submit}. */
export interface SubmitOptions extends PrepareOptions {
  /** Where to send the requests. Default {@link DEFAULT_ENDPOINT}. */
  endpoint?: string;
  /** Build the payloads and return them, sending nothing. Default `false`. */
  dryRun?: boolean;
  /** A `fetch` implementation. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Milliseconds before each request is abandoned. Default `30000`. */
  timeoutMs?: number;
}

/** The outcome of one request. */
export interface BatchResult {
  payload: IndexNowPayload;
  /** The HTTP status, or `null` for a dry run or a request that did not complete. */
  status: number | null;
  /** `true` for 200 and 202 (and for every batch of a dry run). */
  ok: boolean;
  /** A sentence explaining the outcome. */
  message: string;
  /** The response body, trimmed and capped at 500 characters, when there was one. */
  body?: string;
  /** The `Retry-After` header of a 429 response. */
  retryAfter?: string;
}

/** The outcome of {@link submit}. */
export interface SubmitResult extends PreparedSubmission {
  endpoint: string;
  dryRun: boolean;
  /** `true` when every batch was accepted (or, for a dry run, built). */
  ok: boolean;
  /** One entry per request made. Sending stops at the first failure. */
  batches: BatchResult[];
  /** How many URLs were never sent because an earlier batch failed. */
  unsent: number;
}

function checkEndpoint(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url.href;
  } catch {
    // fall through
  }
  throw new IndexNowError('INVALID_OPTION', `The endpoint must be an http(s) URL (got "${endpoint}").`);
}

/**
 * Tells IndexNow engines that the given URLs changed. Validates and batches
 * with {@link prepareSubmission}, then POSTs each batch as JSON. Stops at the
 * first batch that is not accepted, since the next ones would fail the same way.
 *
 * Throws {@link IndexNowError} for bad input (nothing is sent). A refused or
 * failed request is not thrown: it comes back with `ok: false`.
 */
export async function submit(options: SubmitOptions): Promise<SubmitResult> {
  const endpoint = checkEndpoint(options.endpoint ?? DEFAULT_ENDPOINT);
  const prepared = prepareSubmission(options);
  const dryRun = options.dryRun ?? false;
  const batches: BatchResult[] = [];

  if (dryRun) {
    for (const payload of prepared.payloads) {
      batches.push({ payload, status: null, ok: true, message: 'Dry run: not sent.' });
    }
    return { ...prepared, endpoint, dryRun, ok: true, batches, unsent: 0 };
  }

  const doFetch = options.fetch ?? fetch;
  for (const payload of prepared.payloads) {
    let res: Response;
    try {
      res = await doFetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': USER_AGENT },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
      });
    } catch (error) {
      batches.push({ payload, status: null, ok: false, message: `Could not reach ${endpoint}: ${(error as Error).message}.` });
      break;
    }
    const text = (await res.text().catch(() => '')).trim();
    const retryAfter = res.headers.get('retry-after') ?? undefined;
    const accepted = res.status === 200 || res.status === 202;
    const batch: BatchResult = { payload, status: res.status, ok: accepted, message: describeStatus(res.status, retryAfter) };
    if (text) batch.body = text.length > 500 ? `${text.slice(0, 500)}...` : text;
    if (retryAfter) batch.retryAfter = retryAfter;
    batches.push(batch);
    if (!accepted) break;
  }
  const ok = batches.length === prepared.payloads.length && batches.every((b) => b.ok);
  const unsent = prepared.payloads.slice(batches.length).reduce((sum, p) => sum + p.urlList.length, 0);
  return { ...prepared, endpoint, dryRun, ok, batches, unsent };
}
