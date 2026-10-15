import { randomBytes } from 'node:crypto';
import { readdir, readFile, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { IndexNowError } from './errors.js';
import { parseSite, resolveUrl } from './site.js';
import { USER_AGENT } from './version.js';

/** The protocol's key format: 8 to 128 characters of `a-z`, `A-Z`, `0-9` and `-`. */
export const KEY_PATTERN = /^[A-Za-z0-9-]{8,128}$/;

/** Whether `key` follows the protocol's key format. */
export function isValidKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/** Throws a readable `INVALID_KEY` error when `key` breaks the protocol's format. */
export function assertValidKey(key: string): void {
  if (!isValidKey(key)) {
    throw new IndexNowError(
      'INVALID_KEY',
      `"${key}" is not a valid IndexNow key: it must be 8 to 128 characters of a-z, A-Z, 0-9 and "-".`,
    );
  }
}

/** Generates a new key: 32 lowercase hexadecimal characters from a secure random source. */
export function generateKey(): string {
  return randomBytes(16).toString('hex');
}

/** A key file found on disk. */
export interface FoundKey {
  /** The key itself. */
  key: string;
  /** The absolute path of `<key>.txt`. */
  file: string;
}

function keyFromContent(content: string): string {
  return content.replace(/^﻿/, '').trim();
}

async function isDirectory(dir: string): Promise<boolean> {
  try {
    return (await stat(dir)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Finds the key file in `dir`: the one `<key>.txt` whose name is a valid key
 * and whose content is that same key. Returns `null` when there is none.
 *
 * Throws `KEY_FILE` when `dir` does not exist, when more than one key file is
 * there (the engines would accept any of them, so the choice must be yours),
 * or when a file with a 32-hex name holds something other than its own name.
 */
export async function findKey(dir: string): Promise<FoundKey | null> {
  if (!(await isDirectory(dir))) {
    throw new IndexNowError('KEY_FILE', `The public directory ${dir} does not exist.`);
  }
  const names = (await readdir(dir)).filter((name) => name.endsWith('.txt')).sort();
  const found: FoundKey[] = [];
  const mismatched: string[] = [];
  for (const name of names) {
    const candidate = name.slice(0, -4);
    if (!isValidKey(candidate)) continue;
    const file = join(dir, name);
    if (!(await stat(file)).isFile()) continue;
    const content = keyFromContent(await readFile(file, 'utf8'));
    if (content === candidate) found.push({ key: candidate, file });
    else if (/^[0-9a-f]{32}$/i.test(candidate)) mismatched.push(name);
  }
  if (found.length > 1) {
    throw new IndexNowError(
      'KEY_FILE',
      `${dir} holds ${found.length} IndexNow key files; keep one, or pass the key with --key.`,
      found.map((f) => f.file),
    );
  }
  if (found[0]) return found[0];
  if (mismatched.length) {
    throw new IndexNowError(
      'KEY_FILE',
      `${join(dir, mismatched[0] as string)} looks like a key file, but it must contain exactly its own name, ${mismatched[0]?.slice(0, -4)}.`,
    );
  }
  return null;
}

/** Options for {@link writeKeyFile}. */
export interface WriteKeyFileOptions {
  /** The key to write. Default: a new {@link generateKey} key. */
  key?: string;
  /** Replace an existing, different key file instead of refusing. Default `false`. */
  force?: boolean;
}

/** What {@link writeKeyFile} did. */
export interface WriteKeyFileResult {
  key: string;
  file: string;
  /** `true` when the same key file already existed and nothing was written. */
  unchanged: boolean;
  /** The key file that was removed because `force` replaced it. */
  replaced?: string;
}

/**
 * Writes `<key>.txt` (content: the key, UTF-8, no trailing newline) into `dir`.
 * Refuses with `KEY_FILE` when `dir` already holds a different key file, unless
 * `force` is set, in which case the old file is deleted so only one key remains.
 */
export async function writeKeyFile(dir: string, options: WriteKeyFileOptions = {}): Promise<WriteKeyFileResult> {
  const key = options.key ?? generateKey();
  assertValidKey(key);
  const existing = await findKey(dir);
  const file = join(dir, `${key}.txt`);
  if (existing && existing.key === key) return { key, file, unchanged: true };
  if (existing && !options.force) {
    throw new IndexNowError(
      'KEY_FILE',
      `${existing.file} already holds the key ${existing.key}. Keep using it, or pass --force to replace it (the engines re-check the key on your next submission).`,
    );
  }
  await writeFile(file, key, 'utf8');
  if (existing) {
    await unlink(existing.file);
    return { key, file, unchanged: false, replaced: existing.file };
  }
  return { key, file, unchanged: false };
}

/** Options for {@link verifyKey}. */
export interface VerifyKeyOptions {
  /** The site origin, such as `https://example.com`. */
  site: string;
  key: string;
  /** Where the key file is served, when it is not `<site>/<key>.txt`. A path or a full URL on the same host. */
  keyLocation?: string;
  /** A `fetch` implementation. Default: the global `fetch`. */
  fetch?: typeof fetch;
  /** Milliseconds before the request is abandoned. Default `15000`. */
  timeoutMs?: number;
}

/** The outcome of {@link verifyKey}. */
export interface VerifyKeyResult {
  ok: boolean;
  /** The URL that was fetched. */
  url: string;
  /** The HTTP status, or `null` when the request did not complete. */
  status: number | null;
  /** A sentence saying what was found. */
  message: string;
}

/** Resolves the key file URL: `keyLocation` if given (same host only), else `<site>/<key>.txt`. */
export function keyFileUrl(site: string, key: string, keyLocation?: string): string {
  const parsed = parseSite(site);
  if (keyLocation === undefined) return `${parsed.origin}/${key}.txt`;
  const url = resolveUrl(parsed, keyLocation);
  if (new URL(url).host !== parsed.host) {
    throw new IndexNowError(
      'FOREIGN_HOST',
      `The key location ${url} is not on ${parsed.host}; IndexNow only accepts a key file on the same host as the URLs.`,
    );
  }
  return url;
}

/**
 * Fetches the key file the way an engine would and checks that it serves the key.
 * Run it before submitting: an engine that cannot read the key answers 403.
 */
export async function verifyKey(options: VerifyKeyOptions): Promise<VerifyKeyResult> {
  assertValidKey(options.key);
  const url = keyFileUrl(options.site, options.key, options.keyLocation);
  const doFetch = options.fetch ?? fetch;
  let res: Response;
  try {
    res = await doFetch(url, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    });
  } catch (error) {
    return { ok: false, url, status: null, message: `Could not fetch ${url}: ${(error as Error).message}.` };
  }
  if (!res.ok) {
    return { ok: false, url, status: res.status, message: `${url} answered HTTP ${res.status}; the key file is not live. Deploy it first.` };
  }
  const body = keyFromContent(await res.text());
  if (body !== options.key) {
    const shown = body.length > 60 ? `${body.slice(0, 60)}...` : body;
    return {
      ok: false,
      url,
      status: res.status,
      message: `${url} is live but does not contain the key ${options.key} (it contains "${shown}").`,
    };
  }
  return { ok: true, url, status: res.status, message: `${url} serves the key.` };
}
