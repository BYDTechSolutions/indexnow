import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  IndexNowError,
  MAX_URLS_PER_REQUEST,
  describeStatus,
  prepareSubmission,
  submit,
  type IndexNowPayload,
} from '../src/index.js';
import { KEY, startServer, type TestServer } from './helpers.js';

const SITE = 'https://example.com';

describe('prepareSubmission', () => {
  it('resolves paths against the site and keeps full URLs', () => {
    const prepared = prepareSubmission({ site: `${SITE}/`, key: KEY, urls: ['/about', 'services', `${SITE}/work?x=1`] });
    expect(prepared.urls).toEqual([`${SITE}/about`, `${SITE}/services`, `${SITE}/work?x=1`]);
    expect(prepared.host).toBe('example.com');
  });

  it('removes duplicates, including ones that differ only by fragment or form', () => {
    const prepared = prepareSubmission({
      site: SITE,
      key: KEY,
      urls: ['/about', `${SITE}/about`, `${SITE}/about#team`, 'about', '', '  ', '/'],
    });
    expect(prepared.urls).toEqual([`${SITE}/about`, `${SITE}/`]);
    expect(prepared.duplicates).toBe(3);
  });

  it('allows http and https URLs of the same host together', () => {
    const prepared = prepareSubmission({ site: SITE, key: KEY, urls: ['http://example.com/a', 'https://example.com/a'] });
    expect(prepared.urls).toHaveLength(2);
  });

  it('rejects URLs on another host, naming them, before anything is sent', () => {
    const error = (() => {
      try {
        prepareSubmission({ site: SITE, key: KEY, urls: ['/ok', 'https://www.example.com/a', 'https://other.example/b'] });
      } catch (e) {
        return e as IndexNowError;
      }
    })();
    expect(error).toBeInstanceOf(IndexNowError);
    expect(error?.code).toBe('FOREIGN_HOST');
    expect(error?.message).toMatch(/2 URLs are not on example\.com/);
    expect(error?.details).toEqual(['https://www.example.com/a', 'https://other.example/b']);
  });

  it('treats a different port as a different host', () => {
    expect(() => prepareSubmission({ site: SITE, key: KEY, urls: ['https://example.com:8443/a'] })).toThrow(/not on example\.com/);
  });

  it('rejects an empty list', () => {
    expect(() => prepareSubmission({ site: SITE, key: KEY, urls: [] })).toThrow(/Nothing to submit/);
  });

  it('rejects an invalid key, site or URL', () => {
    expect(() => prepareSubmission({ site: SITE, key: 'bad_key!', urls: ['/'] })).toThrow(/not a valid IndexNow key/);
    expect(() => prepareSubmission({ site: 'example.com', key: KEY, urls: ['/'] })).toThrow(/full URL/);
    expect(() => prepareSubmission({ site: `${SITE}/blog`, key: KEY, urls: ['/'] })).toThrow(/without a path/);
    expect(() => prepareSubmission({ site: SITE, key: KEY, urls: ['ftp://example.com/a'] })).toThrow(/not an http or https URL/);
  });

  it('batches at the protocol limit of 10,000 URLs per request', () => {
    const urls = Array.from({ length: 25_001 }, (_, i) => `/p/${i}`);
    const prepared = prepareSubmission({ site: SITE, key: KEY, urls });
    expect(MAX_URLS_PER_REQUEST).toBe(10_000);
    expect(prepared.payloads.map((p) => p.urlList.length)).toEqual([10_000, 10_000, 5_001]);
    expect(prepared.payloads.flatMap((p) => p.urlList)).toEqual(prepared.urls);
  });

  it('honors a smaller batch size and rejects an impossible one', () => {
    const urls = ['/a', '/b', '/c', '/d', '/e'];
    expect(prepareSubmission({ site: SITE, key: KEY, urls, batchSize: 2 }).payloads.map((p) => p.urlList.length)).toEqual([2, 2, 1]);
    expect(() => prepareSubmission({ site: SITE, key: KEY, urls, batchSize: 10_001 })).toThrow(/from 1 to 10000/);
    expect(() => prepareSubmission({ site: SITE, key: KEY, urls, batchSize: 0 })).toThrow(/from 1 to 10000/);
  });

  it('builds host, key and urlList, adding keyLocation only when given', () => {
    const plain = prepareSubmission({ site: SITE, key: KEY, urls: ['/a'] }).payloads[0];
    expect(plain).toEqual({ host: 'example.com', key: KEY, urlList: [`${SITE}/a`] });
    const located = prepareSubmission({ site: SITE, key: KEY, urls: ['/a'], keyLocation: '/keys/k.txt' }).payloads[0];
    expect(Object.keys(located as IndexNowPayload)).toEqual(['host', 'key', 'keyLocation', 'urlList']);
    expect(located?.keyLocation).toBe(`${SITE}/keys/k.txt`);
  });

  it('warns when URLs fall outside the folder of the key file', () => {
    const prepared = prepareSubmission({ site: SITE, key: KEY, urls: ['/catalog/a', '/help/b'], keyLocation: '/catalog/key.txt' });
    expect(prepared.warnings).toEqual([expect.stringMatching(/1 URL is outside \/catalog\//)]);
  });

  it('rejects a key location on another host', () => {
    expect(() => prepareSubmission({ site: SITE, key: KEY, urls: ['/a'], keyLocation: 'https://cdn.example.net/k.txt' })).toThrow(
      /key location .* is not on example\.com/,
    );
  });
});

describe('describeStatus', () => {
  it.each([
    [200, /^OK: .*does not mean they will be crawled or indexed/],
    [202, /^Accepted: .*key is still being validated/],
    [400, /^Bad request/],
    [403, /^Forbidden: the key is not valid/],
    [422, /^Unprocessable: some URLs do not belong to the host, or the key does not match/],
    [429, /^Too many requests: .*possible spam/],
    [500, /server error/],
    [418, /not a documented IndexNow response/],
  ])('explains HTTP %i', (status, pattern) => {
    expect(describeStatus(status)).toMatch(pattern);
  });

  it('passes on Retry-After for 429', () => {
    expect(describeStatus(429, '600')).toMatch(/Retry-After: 600/);
  });
});

describe('submit', () => {
  let server: TestServer;
  let endpoint: string;
  beforeEach(async () => {
    server = await startServer({ '/indexnow': { status: 200 } });
    endpoint = `${server.origin}/indexnow`;
  });
  afterEach(() => server.close());

  it('POSTs the payload as JSON with the protocol content type', async () => {
    const result = await submit({ site: SITE, key: KEY, urls: ['/a', '/b'], endpoint });
    expect(result.ok).toBe(true);
    expect(result.batches[0]).toMatchObject({ status: 200, ok: true });
    const [request] = server.submissions();
    expect(request?.method).toBe('POST');
    expect(request?.headers['content-type']).toBe('application/json; charset=utf-8');
    expect(request?.headers['user-agent']).toMatch(/^@bydtech\/indexnow\//);
    expect(JSON.parse(request?.body ?? '')).toEqual({ host: 'example.com', key: KEY, urlList: [`${SITE}/a`, `${SITE}/b`] });
  });

  it('counts 202 as accepted', async () => {
    server.routes.set('/indexnow', { status: 202 });
    const result = await submit({ site: SITE, key: KEY, urls: ['/a'], endpoint });
    expect(result.ok).toBe(true);
    expect(result.batches[0]?.message).toMatch(/still being validated/);
  });

  it.each([400, 403, 422, 429])('reports HTTP %i as refused, with its message and body', async (status) => {
    server.routes.set('/indexnow', { status, body: `engine says ${status}` });
    const result = await submit({ site: SITE, key: KEY, urls: ['/a'], endpoint });
    expect(result.ok).toBe(false);
    expect(result.batches[0]).toMatchObject({ status, ok: false, message: describeStatus(status), body: `engine says ${status}` });
  });

  it('keeps the Retry-After header of a 429', async () => {
    server.routes.set('/indexnow', { status: 429, headers: { 'retry-after': '120' } });
    const result = await submit({ site: SITE, key: KEY, urls: ['/a'], endpoint });
    expect(result.batches[0]?.retryAfter).toBe('120');
    expect(result.batches[0]?.message).toMatch(/Retry-After: 120/);
  });

  it('sends every batch, and stops at the first refusal', async () => {
    let calls = 0;
    server.routes.set('/indexnow', () => ({ status: ++calls === 2 ? 429 : 200 }));
    const urls = Array.from({ length: 7 }, (_, i) => `/p/${i}`);
    const result = await submit({ site: SITE, key: KEY, urls, endpoint, batchSize: 2 });
    expect(result.ok).toBe(false);
    expect(result.batches.map((b) => b.status)).toEqual([200, 429]);
    expect(server.submissions()).toHaveLength(2);
    expect(result.unsent).toBe(3);
  });

  it('sends nothing on a dry run', async () => {
    const result = await submit({ site: SITE, key: KEY, urls: ['/a', '/a', '/b'], endpoint, dryRun: true });
    expect(result.ok).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.payloads[0]?.urlList).toEqual([`${SITE}/a`, `${SITE}/b`]);
    expect(server.requests).toHaveLength(0);
  });

  it('sends nothing when a URL is on another host', async () => {
    await expect(submit({ site: SITE, key: KEY, urls: ['https://other.example/'], endpoint })).rejects.toThrow(/not on example\.com/);
    expect(server.requests).toHaveLength(0);
  });

  it('returns a failure, not an exception, when the endpoint is unreachable', async () => {
    const result = await submit({ site: SITE, key: KEY, urls: ['/a'], endpoint: 'http://127.0.0.1:9/indexnow', timeoutMs: 2000 });
    expect(result.ok).toBe(false);
    expect(result.batches[0]).toMatchObject({ status: null, ok: false });
    expect(result.batches[0]?.message).toMatch(/Could not reach/);
  });

  it('rejects an endpoint that is not an http(s) URL', async () => {
    await expect(submit({ site: SITE, key: KEY, urls: ['/a'], endpoint: 'api.indexnow.org' })).rejects.toThrow(/endpoint must be/);
  });
});
