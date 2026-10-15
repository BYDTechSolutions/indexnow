import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IndexNowError, findKey, generateKey, isValidKey, keyFileUrl, verifyKey, writeKeyFile } from '../src/index.js';
import { KEY, startServer, tempDir, type TestServer } from './helpers.js';

describe('isValidKey', () => {
  it('accepts 8 to 128 characters of letters, digits and dashes', () => {
    expect(isValidKey('abcd1234')).toBe(true);
    expect(isValidKey('A'.repeat(128))).toBe(true);
    expect(isValidKey('my-Index-Now-key-2026')).toBe(true);
    expect(isValidKey(KEY)).toBe(true);
  });

  it('rejects keys that are too short, too long or use other characters', () => {
    expect(isValidKey('abc1234')).toBe(false);
    expect(isValidKey('a'.repeat(129))).toBe(false);
    expect(isValidKey('abcd_1234')).toBe(false);
    expect(isValidKey('abcd 1234')).toBe(false);
    expect(isValidKey('abcd1234.txt')).toBe(false);
    expect(isValidKey('')).toBe(false);
  });
});

describe('generateKey', () => {
  it('returns 32 lowercase hex characters that pass validation', () => {
    const key = generateKey();
    expect(key).toMatch(/^[0-9a-f]{32}$/);
    expect(isValidKey(key)).toBe(true);
  });

  it('returns a different key each time', () => {
    const keys = new Set(Array.from({ length: 50 }, generateKey));
    expect(keys.size).toBe(50);
  });
});

describe('findKey', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir()));
  afterEach(() => cleanup());

  it('finds the one <key>.txt whose content is its own name', async () => {
    await writeFile(join(dir, `${KEY}.txt`), KEY);
    await writeFile(join(dir, 'robots.txt'), 'User-agent: *');
    await writeFile(join(dir, 'security.txt'), 'Contact: mailto:x@example.com');
    expect(await findKey(dir)).toEqual({ key: KEY, file: join(dir, `${KEY}.txt`) });
  });

  it('accepts a trailing newline and a byte order mark', async () => {
    await writeFile(join(dir, 'my-site-key-1.txt'), '﻿my-site-key-1\n');
    expect((await findKey(dir))?.key).toBe('my-site-key-1');
  });

  it('returns null when there is no key file', async () => {
    await writeFile(join(dir, 'robots.txt'), 'User-agent: *');
    expect(await findKey(dir)).toBeNull();
  });

  it('refuses to choose between two key files', async () => {
    const other = generateKey();
    await writeFile(join(dir, `${KEY}.txt`), KEY);
    await writeFile(join(dir, `${other}.txt`), other);
    await expect(findKey(dir)).rejects.toThrow(/holds 2 IndexNow key files/);
  });

  it('explains a 32-hex file whose content is not its name', async () => {
    await writeFile(join(dir, `${KEY}.txt`), 'something else');
    await expect(findKey(dir)).rejects.toThrow(/must contain exactly its own name/);
  });

  it('ignores a directory named like a key file', async () => {
    await mkdir(join(dir, `${KEY}.txt`));
    expect(await findKey(dir)).toBeNull();
  });

  it('throws KEY_FILE when the directory does not exist', async () => {
    const error = await findKey(join(dir, 'missing')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(IndexNowError);
    expect((error as IndexNowError).code).toBe('KEY_FILE');
  });
});

describe('writeKeyFile', () => {
  let dir: string;
  let cleanup: () => Promise<void>;
  beforeEach(async () => ({ dir, cleanup } = await tempDir()));
  afterEach(() => cleanup());

  it('writes <key>.txt containing exactly the key', async () => {
    const result = await writeKeyFile(dir);
    expect(result.file).toBe(join(dir, `${result.key}.txt`));
    expect(await readFile(result.file, 'utf8')).toBe(result.key);
    expect(await findKey(dir)).toEqual({ key: result.key, file: result.file });
  });

  it('refuses to replace a different existing key', async () => {
    await writeFile(join(dir, `${KEY}.txt`), KEY);
    await expect(writeKeyFile(dir)).rejects.toThrow(/already holds the key/);
    expect(await readdir(dir)).toEqual([`${KEY}.txt`]);
  });

  it('replaces the old key with force, leaving one key file', async () => {
    await writeFile(join(dir, `${KEY}.txt`), KEY);
    const result = await writeKeyFile(dir, { force: true });
    expect(result.replaced).toBe(join(dir, `${KEY}.txt`));
    expect(await readdir(dir)).toEqual([`${result.key}.txt`]);
  });

  it('does nothing when the same key is already there', async () => {
    await writeFile(join(dir, `${KEY}.txt`), KEY);
    expect((await writeKeyFile(dir, { key: KEY })).unchanged).toBe(true);
  });

  it('rejects an invalid key', async () => {
    await expect(writeKeyFile(dir, { key: 'short' })).rejects.toThrow(/not a valid IndexNow key/);
  });
});

describe('verifyKey', () => {
  let server: TestServer;
  beforeEach(async () => {
    server = await startServer({
      [`/${KEY}.txt`]: { body: `${KEY}\n` },
      '/keys/custom.txt': { body: KEY },
      '/wrong.txt': { body: 'not the key' },
    });
  });
  afterEach(() => server.close());

  it('passes when <site>/<key>.txt serves the key', async () => {
    const result = await verifyKey({ site: server.origin, key: KEY });
    expect(result).toMatchObject({ ok: true, status: 200, url: `${server.origin}/${KEY}.txt` });
  });

  it('uses keyLocation when given, as a path or a URL', async () => {
    expect((await verifyKey({ site: server.origin, key: KEY, keyLocation: '/keys/custom.txt' })).ok).toBe(true);
    expect((await verifyKey({ site: server.origin, key: KEY, keyLocation: `${server.origin}/keys/custom.txt` })).ok).toBe(true);
  });

  it('fails with the status when the file is missing', async () => {
    const result = await verifyKey({ site: server.origin, key: generateKey() });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.message).toMatch(/HTTP 404/);
  });

  it('fails when the file holds something else', async () => {
    const result = await verifyKey({ site: server.origin, key: KEY, keyLocation: '/wrong.txt' });
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/does not contain the key/);
  });

  it('fails without throwing when the site cannot be reached', async () => {
    const result = await verifyKey({ site: 'http://127.0.0.1:9', key: KEY, timeoutMs: 2000 });
    expect(result).toMatchObject({ ok: false, status: null });
  });

  it('rejects a key location on another host', () => {
    expect(() => keyFileUrl(server.origin, KEY, 'https://elsewhere.example/key.txt')).toThrow(/not on 127\.0\.0\.1/);
  });
});
