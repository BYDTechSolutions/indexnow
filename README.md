# @bydtech/indexnow

Tell Bing and the other IndexNow search engines which pages changed, from your sitemap or a list of paths.

[![npm version](https://img.shields.io/npm/v/@bydtech/indexnow.svg)](https://www.npmjs.com/package/@bydtech/indexnow)
[![CI](https://github.com/BYDTechSolutions/indexnow/actions/workflows/ci.yml/badge.svg)](https://github.com/BYDTechSolutions/indexnow/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

## Why it exists

After a deploy, search engines learn about new and changed pages only when they next crawl you. [IndexNow](https://www.indexnow.org) lets you tell them right away, but the protocol has sharp edges: a key file that must be live before you submit, a 10,000-URL limit per request, and a whole request refused when a single URL is on another host. This tool handles those, checks the key file before sending, and explains every response code in plain words.

**Google does not use IndexNow.** It is not one of the participating engines listed on indexnow.org. For Google, keep your sitemap submitted in Search Console. A submission here reaches the IndexNow engines, among them Bing, Naver, Seznam.cz, Yandex and Yep: the shared endpoint passes it on to all of them.

## Install

```sh
npm install --save-dev @bydtech/indexnow
```

Node.js 20 or later. No runtime dependencies.

## Quick start

```sh
# 1. Create a key file in your static folder (prints the key)
npx indexnow key --public-dir public

# 2. Deploy, then check that the site serves it
npx indexnow verify --site https://example.com

# 3. See what would be sent, without sending it
npx indexnow submit --site https://example.com --dry-run

# 4. Send every URL in https://example.com/sitemap.xml
npx indexnow submit --site https://example.com
```

Submit only what changed:

```sh
npx indexnow submit /pricing /blog/new-post --site https://example.com
printf '%s\n' /pricing /blog/new-post | npx indexnow submit --stdin --site https://example.com
```

## CLI reference

```
indexnow submit [urls-or-paths...] [options]
indexnow verify [options]
indexnow key [options]
```

### `indexnow submit`

Sends URLs to IndexNow. Arguments can be full URLs (`https://example.com/about`) or paths (`/about`, `about`). With no arguments and no `--stdin`, it reads the sitemap. Arguments, `--stdin` and `--sitemap` can be combined.

Before sending, it:

1. resolves paths against `--site`, drops `#fragments`, and removes duplicates;
2. rejects the run, sending nothing, if any URL is on another host (a different subdomain or port counts as another host);
3. fetches the key file, as an engine would, and stops if it is not live (skip with `--skip-verify`);
4. splits the list into requests of at most 10,000 URLs, and stops at the first request that is not accepted.

### `indexnow verify`

Fetches `<site>/<key>.txt` (or `--key-location`) and checks that it serves the key. Run it after deploying a new key.

### `indexnow key`

Generates a key (32 lowercase hex characters from `node:crypto`) and writes `<key>.txt`, containing only the key, into `--public-dir`. Prints the key on stdout. If the directory already holds a different key file, it refuses; `--force` replaces it and deletes the old file, so only one key remains.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Every request was accepted (HTTP 200 or 202), the key file checks out, or the key was written. |
| `1` | A request was refused or failed, the key file is not live, the sitemap could not be read, or `key` refused to overwrite. |
| `2` | Usage or input error: unknown option, missing site or key, invalid key, URL on another host. Nothing was sent. |

### Response codes

Each response is reported with what it means under the [protocol documentation](https://www.indexnow.org/documentation):

| HTTP | Meaning | Result |
|---|---|---|
| 200 | The URLs were received. This does not mean they will be crawled or indexed. | ok |
| 202 | Received; the engine is still validating the key. | ok |
| 400 | Bad request: the format is invalid. | refused |
| 403 | The key is not valid: the key file was not found, or does not contain the key. | refused |
| 422 | Some URLs do not belong to the host, or the key does not match the protocol format. | refused |
| 429 | Too many requests: possible spam. `Retry-After` is shown when sent. | refused |

## Configuration

| Option | Env | Default | Used by |
|---|---|---|---|
| `--site <url>` | `INDEXNOW_SITE` | the origin of the first full URL given | submit, verify |
| `--key <key>` | `INDEXNOW_KEY` | the key file found in `--public-dir` | submit, verify |
| `--public-dir <dir>` | | `public` | submit, verify, key |
| `--key-location <url>` | | none: the key is expected at `<site>/<key>.txt` | submit, verify |
| `--sitemap <url>` | | `<site>/sitemap.xml`, when no URLs and no `--stdin` are given | submit |
| `--stdin` | | off | submit |
| `--endpoint <url>` | | `https://api.indexnow.org/indexnow` | submit |
| `--batch-size <n>` | | `10000` (the protocol maximum) | submit |
| `--skip-verify` | | off | submit |
| `--dry-run` | | off | submit |
| `--force` | | off | key |

`--site` must be an origin such as `https://example.com`, without a path. The key must be 8 to 128 characters of `a-z`, `A-Z`, `0-9` and `-`. In `--stdin` input, blank lines and lines starting with `#` are skipped.

The key is found by looking in `--public-dir` for the one `<name>.txt` whose name is a valid key and whose content is that same name. Two such files are an error: pass `--key` to choose.

## API reference

```ts
import { submit, readSitemap, generateKey, findKey, verifyKey } from '@bydtech/indexnow';

const found = await findKey('public');            // { key, file } | null
const urls = await readSitemap('https://example.com/sitemap.xml');

const check = await verifyKey({ site: 'https://example.com', key: found!.key });
if (!check.ok) throw new Error(check.message);

const result = await submit({ site: 'https://example.com', key: found!.key, urls });
for (const batch of result.batches) console.log(batch.status, batch.message);
```

| Function | What it does |
|---|---|
| `submit(options)` | Validates, de-duplicates and batches `urls`, then POSTs each batch. Returns `{ ok, batches, urls, duplicates, payloads, warnings, unsent, ... }`. Throws `IndexNowError` for bad input (nothing sent); a refused request comes back with `ok: false`. Options: `site`, `key`, `urls`, `keyLocation?`, `batchSize?`, `endpoint?`, `dryRun?`, `fetch?`, `timeoutMs?` (30000). |
| `prepareSubmission(options)` | The same checks and batching, with no network. Returns the request bodies. |
| `readSitemap(url, options?)` | Returns every page URL in a sitemap, following sitemap index files. Options: `fetch?`, `timeoutMs?` (30000), `maxDepth?` (3), `maxSitemaps?` (1000). |
| `parseSitemap(xml)` | Parses one sitemap document: `{ kind: 'urlset' \| 'sitemapindex', locs }`. |
| `generateKey()` | A new 32-character hex key. |
| `findKey(dir)` | The key file in `dir`, or `null`. |
| `writeKeyFile(dir, { key?, force? })` | Writes `<key>.txt`; refuses to replace a different key unless `force`. |
| `verifyKey({ site, key, keyLocation?, fetch?, timeoutMs? })` | Fetches the key file and returns `{ ok, url, status, message }`. |
| `isValidKey(key)` | Whether the key follows the protocol format. |
| `describeStatus(status, retryAfter?)` | The sentence used for a response code. |

`IndexNowError` has a `code`: `INVALID_SITE`, `INVALID_KEY`, `INVALID_URL`, `INVALID_OPTION`, `FOREIGN_HOST`, `NO_URLS`, `SITEMAP` or `KEY_FILE`, and `details` listing rejected URLs where relevant. All types are exported.

## How it works, and its limits

- **Protocol.** Each batch is a `POST` to the endpoint with `Content-Type: application/json; charset=utf-8` and a body of `host`, `key`, `urlList` and, only when `--key-location` is set, `keyLocation`, as described in the [IndexNow documentation](https://www.indexnow.org/documentation). The engine then fetches your key file to confirm you control the host.
- **Key location.** With `--key-location` in a folder, the protocol only lets that key cover URLs under the same folder; the tool warns about URLs outside it. Serving the key at the root covers the whole host.
- **Sitemaps.** It reads `<loc>` elements from sitemaps.org XML, follows sitemap index files (three levels deep at most, each file once), and decompresses gzipped files with `node:zlib`. Text sitemaps, RSS and Atom feeds are not read. The XML is matched with regular expressions, not a full XML parser: that covers sitemaps as generators write them, and keeps the package free of dependencies.
- **Subdomains are separate hosts.** `www.example.com` and `example.com` each need their own run, and their own key file.
- **No retries.** A 429 or a network failure stops the run and is reported; when to try again is left to you.
- **Submit what changed.** Every URL counts against the crawl attention engines give your site, and the protocol advises against resubmitting unchanged pages. Sending the whole sitemap fits a first run or a redesign; after that, pass the paths that changed.
- **A 200 is not indexing.** It means the engine received the URLs, nothing more.
- **No runtime dependencies.** It uses Node's global `fetch`, `node:util` `parseArgs`, `node:crypto` and `node:zlib`.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Security issues: see [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)

---

Maintained by [BYD Tech](https://bydtech.in), a software studio that builds MVPs, AI agents, and web & mobile apps.
