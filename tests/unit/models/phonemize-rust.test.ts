import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { DictionaryBytes } from '~/lib/models/phonemize-dict';
import { DICTIONARIES_CACHE, DictionaryLoadError } from '~/lib/models/phonemize-dict';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';
import { Phonemizer as WasmPhonemizer } from '~/lib/models/phonemize-wasm/phonemize';
import { FakeCaches, fakeFetch } from './fakes';

/**
 * wasm-pack's generated JS resolves `phonemize_bg.wasm` with a URL relative to
 * itself and `fetch`es it. The unit environment has no server to answer that, so
 * the binary is read off disk and handed over directly — `init` takes bytes as
 * readily as a URL.
 */
const WASM = new Uint8Array(
  readFileSync(
    resolve(
      dirname(fileURLToPath(import.meta.url)),
      '../../../lib/models/phonemize-wasm/phonemize_bg.wasm'
    )
  )
);

const FIXTURES = resolve(dirname(fileURLToPath(import.meta.url)), '../../../tests/fixtures');

/** A real zstd frame — the reference CLI's, the same one the Rust tests read. */
const COMPRESSED: DictionaryBytes = new Uint8Array(
  readFileSync(resolve(FIXTURES, 'test-dict.json.zst'))
);

/** The dictionary the Japanese pipeline asks for. */
const IPADIC = 'lindera-ipadic-ja';

/** Where the wrapper looks for it, under the extension root. */
const IPADIC_URL = `/dictionaries/${IPADIC}.bin.zst`;

/**
 * A phonemizer with a dictionary source attached.
 *
 * The source records the URLs it was asked for, so a `prepare` that quietly
 * loaded nothing cannot look like one that worked.
 */
function phonemizerWith(bytes: DictionaryBytes = COMPRESSED) {
  const fetch = fakeFetch({ [IPADIC_URL]: { bytes } });
  const caches = new FakeCaches();
  const phonemizer = new RustPhonemizer({ wasm: WASM, fetch, cacheStorage: caches });
  return { phonemizer, fetch, caches };
}

describe('RustPhonemizer', () => {
  it('loads the wasm module', async () => {
    const phonemizer = new RustPhonemizer({ wasm: WASM });
    await phonemizer.ready;
    expect(phonemizer).toBeDefined();
  });

  /**
   * `ready` resolving is not by itself proof that the wasm instance was
   * constructed — a wrapper that forgot `new WasmPhonemizer()` would pass the
   * test above. Reaching the phonemize seam proves the instance exists.
   *
   * The stub returns no phonemes; this asserts the shape, not the output, so it
   * does not have to change when the real pipeline lands.
   */
  it('exposes a callable phonemize seam once ready', async () => {
    const phonemizer = new RustPhonemizer({ wasm: WASM });
    await phonemizer.ready;

    const result = phonemizer.phonemize('你好', { frontend: 'kokoro-v1', lang: 'zh-CN' });

    expect(typeof result.phonemes).toBe('string');
  });
});

describe('RustPhonemizer.prepare', () => {
  it('fetches what the wasm asks for and hands it over', async () => {
    const { phonemizer, fetch, caches } = phonemizerWith();
    await phonemizer.ready;

    await phonemizer.prepare('kokoro-v1', 'ja-JP');

    // The name comes from the wasm, not from this side — `required_dictionaries`
    // is the one place that decides what a language costs, which is what keeps a
    // dictionary swap from being a JavaScript change (spec §3.2).
    expect(fetch.calls).toEqual([IPADIC_URL]);
    expect(caches.bucket(DICTIONARIES_CACHE).has(IPADIC_URL)).toBe(true);
  });

  it('fetches nothing for a language that needs no dictionary', async () => {
    // English's espeak data is compiled into the wasm (spec §2.3). A `prepare`
    // that demanded a dictionary anyway would fail here, and would also make
    // every English voice unplayable.
    const { phonemizer, fetch } = phonemizerWith();
    await phonemizer.ready;

    await phonemizer.prepare('kokoro-v1', 'en-US');

    expect(fetch.calls).toEqual([]);
  });

  it('rejects a language the frontend cannot speak', async () => {
    // v1.1-zh has no Japanese frontend (spec §2.2, review focus #3). Reported
    // here rather than at the first sentence, because this runs when the voice
    // is picked — before anything is playing.
    const { phonemizer, fetch } = phonemizerWith();
    await phonemizer.ready;

    const error = (await phonemizer
      .prepare('kokoro-v11-zh', 'ja-JP')
      .catch((thrown: unknown) => thrown)) as DictionaryLoadError;

    expect(error).toBeInstanceOf(DictionaryLoadError);
    // The reason travelled as the `code` property of the `Error` the wasm threw.
    // Asserting the reason rather than the message is the point: a message is
    // free to change, and the caller switches on this.
    expect(error.reason).toBe('unsupported-language');
    expect(fetch.calls).toEqual([]);
  });

  it('rejects a file that is not a zstd frame before the wasm sees it', async () => {
    const { phonemizer } = phonemizerWith(
      new Uint8Array(new TextEncoder().encode('not compressed at all').buffer)
    );
    await phonemizer.ready;

    const error = (await phonemizer
      .prepare('kokoro-v1', 'ja-JP')
      .catch((thrown: unknown) => thrown)) as DictionaryLoadError;

    expect(error.reason).toBe('dictionary-format');
  });

  it('reports a frame that reaches the wasm but does not decode', async () => {
    // A valid magic number followed by noise: the bytes pass this side's check
    // and fail inside `ruzstd`. This is the one test that proves the bytes
    // actually arrive in the wasm's decoder — a `prepare` that never called
    // `load_dictionary` would fail as `missing-dictionaries` instead.
    const corrupt: DictionaryBytes = new Uint8Array(
      new Uint8Array([0x28, 0xb5, 0x2f, 0xfd, ...new Uint8Array(32).fill(0xff)]).buffer
    );
    const { phonemizer } = phonemizerWith(corrupt);
    await phonemizer.ready;

    const error = (await phonemizer
      .prepare('kokoro-v1', 'ja-JP')
      .catch((thrown: unknown) => thrown)) as DictionaryLoadError;

    expect(error).toBeInstanceOf(DictionaryLoadError);
    expect(error.reason).toBe('dictionary-decompress');
  });

  it('reports a dictionary the install does not have', async () => {
    // The extension's own files answered 404 — a packaging mistake, and the one
    // failure a user can actually act on ("reinstall the extension").
    const phonemizer = new RustPhonemizer({
      wasm: WASM,
      fetch: fakeFetch({ [IPADIC_URL]: { status: 404 } }),
      cacheStorage: null,
    });
    await phonemizer.ready;

    const error = (await phonemizer
      .prepare('kokoro-v1', 'ja-JP')
      .catch((thrown: unknown) => thrown)) as DictionaryLoadError;

    expect(error.reason).toBe('status');
    expect(error.message).toContain(IPADIC);
  });

  it('loads every dictionary and then finishes', async () => {
    // Spied on rather than inferred. Without this, a `prepare` that fetched and
    // dropped the bytes — or one that forgot `finish_loading` — passes every
    // other test in this file, and the failure it causes is a pipeline that runs
    // with half a dictionary rather than an error (review focus #2).
    const load = vi.spyOn(WasmPhonemizer.prototype, 'load_dictionary');
    const finish = vi.spyOn(WasmPhonemizer.prototype, 'finish_loading');

    try {
      const { phonemizer } = phonemizerWith();
      await phonemizer.ready;

      await phonemizer.prepare('kokoro-v1', 'ja-JP');

      expect(load).toHaveBeenCalledWith(IPADIC, COMPRESSED);
      expect(finish).toHaveBeenCalledTimes(1);
      // The order is the protocol: bytes first, then the check that they all
      // arrived. A `finish_loading` before the feed would always report a gap.
      expect(load.mock.invocationCallOrder[0]).toBeLessThan(
        finish.mock.invocationCallOrder[0] ?? 0
      );
    } finally {
      load.mockRestore();
      finish.mockRestore();
    }
  });
});
