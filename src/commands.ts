import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs, type ParseArgsConfig } from 'node:util';
import { IndexNowError } from './errors.js';
import { assertValidKey, findKey, verifyKey, writeKeyFile } from './key.js';
import { parseSite } from './site.js';
import { readSitemap } from './sitemap.js';
import { DEFAULT_ENDPOINT, MAX_URLS_PER_REQUEST, prepareSubmission, submit } from './submit.js';
import { VERSION } from './version.js';

/** Exit codes: 0 success, 1 a submission or check failed, 2 bad usage or input (nothing sent). */
export const EXIT = { OK: 0, FAILED: 1, USAGE: 2 } as const;

/** Everything the CLI touches outside itself, so tests can replace it. */
export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  readStdin: () => Promise<string>;
  env: Record<string, string | undefined>;
  cwd: string;
  fetch?: typeof fetch;
}

export const HELP = `indexnow ${VERSION}: tell IndexNow search engines which pages changed

Usage:
  indexnow submit [urls-or-paths...] [options]
  indexnow verify [options]
  indexnow key [options]

Commands:
  submit   Send URLs to IndexNow. With no URLs, sends every URL in the sitemap.
  verify   Check that the site serves the key file, as an engine would.
  key      Generate a key and write <key>.txt into the public directory.

Options for submit and verify:
  --site <url>           Site origin, e.g. https://example.com (env INDEXNOW_SITE)
  --key <key>            The key (env INDEXNOW_KEY; default: the key file in --public-dir)
  --public-dir <dir>     Directory holding <key>.txt (default: public)
  --key-location <url>   Key file URL or path, when it is not <site>/<key>.txt

Options for submit:
  --sitemap <url>        Sitemap or sitemap index to read (default: <site>/sitemap.xml
                         when no URLs and no --stdin are given)
  --stdin                Read URLs or paths from standard input, one per line
  --endpoint <url>       Where to send (default: ${DEFAULT_ENDPOINT})
  --batch-size <n>       URLs per request, 1 to ${MAX_URLS_PER_REQUEST} (default: ${MAX_URLS_PER_REQUEST})
  --skip-verify          Do not check the key file before sending
  --dry-run              Print the request bodies and send nothing

Options for key:
  --public-dir <dir>     Where to write <key>.txt (default: public)
  --force                Replace an existing, different key file

  -h, --help             Show this help
  -v, --version          Show the version

Exit codes: 0 ok, 1 submission refused or check failed, 2 usage or input error.
`;

class UsageError extends Error {}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

const SHARED = {
  site: { type: 'string' },
  key: { type: 'string' },
  'public-dir': { type: 'string' },
  'key-location': { type: 'string' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

const SUBMIT_OPTIONS = {
  ...SHARED,
  sitemap: { type: 'string' },
  stdin: { type: 'boolean' },
  endpoint: { type: 'string' },
  'batch-size': { type: 'string' },
  'skip-verify': { type: 'boolean' },
  'dry-run': { type: 'boolean' },
} as const satisfies ParseArgsConfig['options'];

const KEY_OPTIONS = {
  'public-dir': { type: 'string' },
  force: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
} as const satisfies ParseArgsConfig['options'];

function parse<O extends NonNullable<ParseArgsConfig['options']>>(args: string[], options: O, positionals: boolean) {
  try {
    return parseArgs({ args, options, allowPositionals: positionals, strict: true });
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

function originOf(value: string | undefined): string | undefined {
  if (!value || !/^https?:\/\//i.test(value)) return undefined;
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
}

async function resolveKey(values: { key?: string; 'public-dir'?: string }, io: CliIo): Promise<string> {
  const given = values.key ?? io.env.INDEXNOW_KEY;
  if (given !== undefined && given !== '') {
    assertValidKey(given);
    return given;
  }
  const dir = resolve(io.cwd, values['public-dir'] ?? 'public');
  const found = await findKey(dir);
  if (!found) {
    throw new UsageError(
      `No IndexNow key: no <key>.txt file in ${dir}. Pass --key, set INDEXNOW_KEY, or run "indexnow key" to create one.`,
    );
  }
  return found.key;
}

function requireSite(site: string | undefined): string {
  if (!site) throw new UsageError('Missing --site (or INDEXNOW_SITE), e.g. --site https://example.com.');
  return parseSite(site).origin;
}

async function runVerify(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, SHARED, true);
  if (values.help) return help(io);
  if (positionals.length) throw new UsageError(`verify takes no arguments (got "${positionals[0]}").`);
  const site = requireSite(values.site ?? io.env.INDEXNOW_SITE);
  const key = await resolveKey(values, io);
  const result = await verifyKey({ site, key, keyLocation: values['key-location'], fetch: io.fetch });
  if (result.ok) {
    io.stdout(`${result.message}\n`);
    return EXIT.OK;
  }
  io.stderr(`${result.message}\n`);
  return EXIT.FAILED;
}

async function runKey(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, KEY_OPTIONS, true);
  if (values.help) return help(io);
  if (positionals.length) throw new UsageError(`key takes no arguments (got "${positionals[0]}").`);
  const dir = resolve(io.cwd, values['public-dir'] ?? 'public');
  if (!(await isDirectory(dir))) {
    throw new UsageError(`The public directory ${dir} does not exist. Create it, or pass --public-dir.`);
  }
  let result;
  try {
    result = await writeKeyFile(dir, { force: values.force });
  } catch (error) {
    if (error instanceof IndexNowError && error.code === 'KEY_FILE') {
      io.stderr(`indexnow: ${error.message}\n`);
      for (const line of error.details) io.stderr(`  ${line}\n`);
      return EXIT.FAILED;
    }
    throw error;
  }
  if (result.replaced) io.stderr(`Removed the old key file ${result.replaced}.\n`);
  io.stderr(`Wrote ${result.file}. Deploy it, then run "indexnow verify --site <your site>".\n`);
  io.stdout(`${result.key}\n`);
  return EXIT.OK;
}

function splitList(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

async function runSubmit(args: string[], io: CliIo): Promise<number> {
  const { values, positionals } = parse(args, SUBMIT_OPTIONS, true);
  if (values.help) return help(io);

  let batchSize: number | undefined;
  if (values['batch-size'] !== undefined) {
    batchSize = Number(values['batch-size']);
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_URLS_PER_REQUEST) {
      throw new UsageError(`--batch-size must be a whole number from 1 to ${MAX_URLS_PER_REQUEST} (got "${values['batch-size']}").`);
    }
  }

  const inputs = [...positionals];
  if (values.stdin) inputs.push(...splitList(await io.readStdin()));

  const site = requireSite(
    values.site ?? io.env.INDEXNOW_SITE ?? inputs.map(originOf).find(Boolean) ?? originOf(values.sitemap),
  );
  const key = await resolveKey(values, io);

  const useSitemap = values.sitemap !== undefined || (!positionals.length && !values.stdin);
  if (useSitemap) {
    const sitemapUrl = values.sitemap ?? `${site}/sitemap.xml`;
    const fromSitemap = await readSitemap(sitemapUrl, { fetch: io.fetch });
    io.stderr(`Read ${fromSitemap.length} URL${fromSitemap.length === 1 ? '' : 's'} from ${sitemapUrl}.\n`);
    inputs.push(...fromSitemap);
  }

  const dryRun = values['dry-run'] ?? false;
  const options = {
    site,
    key,
    urls: inputs,
    keyLocation: values['key-location'],
    endpoint: values.endpoint ?? DEFAULT_ENDPOINT,
    batchSize,
    fetch: io.fetch,
  };

  prepareSubmission(options); // reject bad input before any request is made

  if (!values['skip-verify']) {
    const check = await verifyKey({ site, key, keyLocation: options.keyLocation, fetch: io.fetch });
    if (!check.ok) {
      io.stderr(`${check.message}\nEngines refuse submissions whose key they cannot read (HTTP 403). Fix the key file, or pass --skip-verify.\n`);
      return EXIT.FAILED;
    }
  }

  const result = await submit({ ...options, dryRun });
  for (const warning of result.warnings) io.stderr(`Warning: ${warning}\n`);
  if (result.duplicates) io.stderr(`Dropped ${result.duplicates} duplicate URL${result.duplicates === 1 ? '' : 's'}.\n`);

  if (dryRun) {
    const total = result.payloads.length;
    result.payloads.forEach((payload, i) => {
      io.stdout(`POST ${result.endpoint} (batch ${i + 1}/${total}, ${payload.urlList.length} URLs)\n`);
      io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
    });
    io.stderr(`Dry run: ${result.urls.length} URL${result.urls.length === 1 ? '' : 's'} in ${total} request${total === 1 ? '' : 's'}; nothing was sent.\n`);
    return EXIT.OK;
  }

  const total = result.payloads.length;
  result.batches.forEach((batch, i) => {
    const line = `IndexNow batch ${i + 1}/${total}: ${batch.payload.urlList.length} URLs -> ${batch.status === null ? 'no response' : `HTTP ${batch.status}`}. ${batch.message}\n`;
    if (batch.ok) io.stdout(line);
    else {
      io.stderr(line);
      if (batch.body) io.stderr(`Response: ${batch.body}\n`);
    }
  });
  if (!result.ok) {
    if (result.unsent) io.stderr(`Stopped; ${result.unsent} URL${result.unsent === 1 ? ' was' : 's were'} not sent.\n`);
    return EXIT.FAILED;
  }
  io.stdout(`Submitted ${result.urls.length} URL${result.urls.length === 1 ? '' : 's'} for ${result.host} to ${result.endpoint}.\n`);
  return EXIT.OK;
}

function help(io: CliIo): number {
  io.stdout(HELP);
  return EXIT.OK;
}

const USAGE_CODES = new Set(['INVALID_SITE', 'INVALID_KEY', 'INVALID_URL', 'INVALID_OPTION', 'FOREIGN_HOST', 'KEY_FILE']);

/** Runs the CLI with `argv` (without `node` and the script) and returns the exit code. */
export async function main(argv: string[], io: CliIo): Promise<number> {
  const [command, ...rest] = argv;
  try {
    switch (command) {
      case 'submit':
        return await runSubmit(rest, io);
      case 'verify':
        return await runVerify(rest, io);
      case 'key':
        return await runKey(rest, io);
      case undefined:
      case '-h':
      case '--help':
      case 'help':
        return help(io);
      case '-v':
      case '--version':
        io.stdout(`${VERSION}\n`);
        return EXIT.OK;
      default:
        throw new UsageError(`Unknown command "${command}". Use submit, verify or key.`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`indexnow: ${error.message}\nRun "indexnow --help" for usage.\n`);
      return EXIT.USAGE;
    }
    if (error instanceof IndexNowError) {
      io.stderr(`indexnow: ${error.message}\n`);
      for (const line of error.details) io.stderr(`  ${line}\n`);
      return USAGE_CODES.has(error.code) ? EXIT.USAGE : EXIT.FAILED;
    }
    io.stderr(`indexnow: ${(error as Error).message ?? String(error)}\n`);
    return EXIT.FAILED;
  }
}
