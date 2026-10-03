import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  type DictionaryBytes,
  DictionaryLoadError,
  fetchDictionary,
  isZstdFrame,
} from '~/lib/models/phonemize-dict';
import { FakeBucket, fakeFetch } from './fakes';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, '../../../tests/fixtures');

/**
 * What the reference `zstd` CLI produced from `test-dict.json`.
 *
 * The bytes that go *in* to the wasm, not what comes out: this side moves a
 * compressed dictionary and never opens it. That the plaintext inside is intact
 * is `crates/phonemize/tests/dictionary.rs`'s assertion, and it is the only
 * place it can be made — the wasm is what decodes.
 */
const COMPRESSED: DictionaryBytes = new Uint8Array(
  readFileSync(resolve(FIXTURES, 'test-dict.json.zst'))
);

const URL = '/dictionaries/test-dict.bin.zst';

/**
 * A bucket whose reads and writes can be made to fail.
 *
 * `FakeBucket` is the shared double and does not have the hooks; a full disk is
 * a case worth testing, because caching is an optimisation and an extension that
 * stops loading dictionaries when its cache is unwritable has turned one into a
 * requirement.
 */
class FlakyBucket extends FakeBucket {
  putCount = 0;
  readonly deleted: string[] = [];
  failPut = false;
  failMatch = false;

  override async match(key: string): Promise<Response | undefined> {
    if (this.failMatch) throw new Error('cache is unreadable');
    return super.match(key);
  }

  override async put(key: string, response: Response): Promise<void> {
    this.putCount += 1;
    if (this.failPut) throw new Error('no space left');
    return super.put(key, response);
  }

  override async delete(key: string): Promise<boolean> {
    this.deleted.push(key);
    return super.delete(key);
  }
}

/** The cache, opened under whatever name the module uses. */
function storageFor(bucket: FlakyBucket) {
  return { open: vi.fn(async () => bucket) };
}

/** A dictionary source that answers the one URL with `bytes`. */
function sourceFor(bytes: DictionaryBytes) {
  return fakeFetch({ [URL]: { bytes } });
}

describe('isZstdFrame', () => {
  it('recognises the fixture', () => {
    expect(isZstdFrame(COMPRESSED)).toBe(true);
  });

  it('rejects a gzip file, an empty one, and a truncated header', () => {
    expect(isZstdFrame(new Uint8Array([0x1f, 0x8b, 0x08, 0x00]))).toBe(false);
    expect(isZstdFrame(new Uint8Array([]))).toBe(false);
    expect(isZstdFrame(new Uint8Array([0x28, 0xb5, 0x2f]))).toBe(false);
  });
});

describe('fetchDictionary', () => {
  it('fetches the bytes and stores them under the dictionary URL', async () => {
    const bucket = new FlakyBucket();

    const bytes = await fetchDictionary('test-dict', {
      fetch: sourceFor(COMPRESSED),
      cacheStorage: storageFor(bucket),
      url: () => URL,
    });

    expect(bytes).toEqual(COMPRESSED);
    // The whole point of caching a compressed dictionary: the *compressed*
    // bytes are what is stored, so the cache costs 10 MB rather than 45 MB.
    expect(bucket.entries.get(URL)).toEqual(COMPRESSED);
  });

  it('serves a cached dictionary without fetching it again', async () => {
    const bucket = new FlakyBucket();
    bucket.seed(URL, COMPRESSED.length);
    bucket.entries.set(URL, COMPRESSED);
    const fetch = sourceFor(COMPRESSED);

    const bytes = await fetchDictionary('test-dict', {
      fetch,
      cacheStorage: storageFor(bucket),
      url: () => URL,
    });

    expect(fetch.calls).toEqual([]);
    expect(bucket.putCount).toBe(0);
    expect(bytes).toEqual(COMPRESSED);
  });

  it('throws a network failure when the fetch itself fails', async () => {
    // No route for this URL, so the fake throws the way a dead connection does.
    const fetch = fakeFetch({});

    const error = await fetchDictionary('test-dict', {
      fetch,
      cacheStorage: storageFor(new FlakyBucket()),
      url: () => URL,
    }).catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DictionaryLoadError);
    expect((error as DictionaryLoadError).reason).toBe('network');
    // The name has to be in the message: `prepare` may be fetching several, and
    // "could not fetch" alone does not say which one is missing from the install.
    expect((error as DictionaryLoadError).message).toContain('test-dict');
    // The reason is what the caller switches on, so a test that only checked the
    // message would pass on an error that nothing can classify.
    expect((error as DictionaryLoadError).cause).toBeInstanceOf(TypeError);
  });

  it('throws a status failure when the extension answers 404', async () => {
    const fetch = fakeFetch({ [URL]: { status: 404 } });

    const error = (await fetchDictionary('test-dict', {
      fetch,
      cacheStorage: storageFor(new FlakyBucket()),
      url: () => URL,
    }).catch((thrown: unknown) => thrown)) as DictionaryLoadError;

    expect(error.reason).toBe('status');
    expect(error.status).toBe(404);
  });

  it('throws a format failure when the bytes are not a zstd frame', async () => {
    // A dictionary that shipped as plain text, or a redirect page. Caught here
    // rather than in the wasm so the message can say how many bytes arrived.
    const fetch = fakeFetch({
      [URL]: { bytes: new Uint8Array(new TextEncoder().encode('{"not":"zstd"}').buffer) },
    });

    const error = (await fetchDictionary('test-dict', {
      fetch,
      cacheStorage: storageFor(new FlakyBucket()),
      url: () => URL,
    }).catch((thrown: unknown) => thrown)) as DictionaryLoadError;

    expect(error.reason).toBe('dictionary-format');
    expect(error.message).toContain('14 bytes');
  });

  it('discards a cached entry that is not a zstd frame and fetches again', async () => {
    // What an interrupted write leaves behind. Without the check, one bad write
    // poisons every later cold start — and the symptom is a decompression error
    // from the wasm, which points at the wrong thing entirely.
    const bucket = new FlakyBucket();
    bucket.entries.set(URL, new Uint8Array(new TextEncoder().encode('half a dictionary').buffer));

    const bytes = await fetchDictionary('test-dict', {
      fetch: sourceFor(COMPRESSED),
      cacheStorage: storageFor(bucket),
      url: () => URL,
    });

    expect(bucket.deleted).toEqual([URL]);
    expect(bytes).toEqual(COMPRESSED);
    expect(bucket.entries.get(URL)).toEqual(COMPRESSED);
  });

  it('still returns the bytes when the cache cannot be written', async () => {
    // Caching is an optimisation. Failing to cache must not fail to phonemize.
    const bucket = new FlakyBucket();
    bucket.failPut = true;

    const bytes = await fetchDictionary('test-dict', {
      fetch: sourceFor(COMPRESSED),
      cacheStorage: storageFor(bucket),
      url: () => URL,
    });

    expect(bytes).toEqual(COMPRESSED);
  });

  it('still returns the bytes when the cache cannot be read', async () => {
    const bucket = new FlakyBucket();
    bucket.failMatch = true;

    const bytes = await fetchDictionary('test-dict', {
      fetch: sourceFor(COMPRESSED),
      cacheStorage: storageFor(bucket),
      url: () => URL,
    });

    expect(bytes).toEqual(COMPRESSED);
  });

  it('loads without a cache at all', async () => {
    const bytes = await fetchDictionary('test-dict', {
      fetch: sourceFor(COMPRESSED),
      cacheStorage: null,
      url: () => URL,
    });

    expect(bytes).toEqual(COMPRESSED);
  });

  it('asks for dictionaries under the extension root by default', async () => {
    // Root-relative, so the same spelling resolves against the extension's
    // origin from a page and from a worker alike — the arrangement the deleted
    // kuromoji dictionary used first, and the one `public/dictionaries/` keeps.
    const fetch = fakeFetch({ '/dictionaries/lindera-ipadic-ja.bin.zst': { bytes: COMPRESSED } });

    await fetchDictionary('lindera-ipadic-ja', { fetch, cacheStorage: null });

    expect(fetch.calls).toEqual(['/dictionaries/lindera-ipadic-ja.bin.zst']);
  });
});
