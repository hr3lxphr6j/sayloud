import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { ChinesePhonemizer, ensureJieba } from '~/lib/models/phonemize/chinese';
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

/** The dictionary the Chinese pipeline asks for. */
const JIEBA = 'jieba-zh-dict';

/** Where the wrapper looks for it. */
const JIEBA_URL = `/dictionaries/${JIEBA}.bin.zst`;

/**
 * The real IPADic asset, or `null` when skipping was asked for.
 *
 * `test-dict.json.zst` is a stand-in for the *transport* — bytes arrive
 * compressed and come out whole — and that is all phase 2 defined. It stopped
 * being enough for `finish_loading` once that started building the segmenter
 * from the bytes (phase 3), because no small payload can satisfy lindera's nine
 * components. So the tests that reach that step use the dictionary itself.
 *
 * Missing is a failure, not a skip. These tests are the only JavaScript-side
 * check that the boundary works, and a test that passes because its input was
 * absent is a false green. Skipping is something you ask for by name, with
 * `PHONEMIZE_SKIP_DICT_TESTS=1`.
 */
function realDictionary(): DictionaryBytes | null {
  const asset = resolve(
    dirname(fileURLToPath(import.meta.url)),
    `../../../public/dictionaries/${IPADIC}.bin.zst`
  );
  try {
    return new Uint8Array(readFileSync(asset));
  } catch (error) {
    if (process.env.PHONEMIZE_SKIP_DICT_TESTS === '1') {
      console.warn(`SKIPPING the dictionary-backed tests: no ${asset}`);
      return null;
    }
    throw new Error(
      `no dictionary at ${asset} (${String(error)}).\n` +
        'Run ./scripts/setup-lindera-dict.sh to build it, or set ' +
        'PHONEMIZE_SKIP_DICT_TESTS=1 to skip the Japanese pipeline tests.'
    );
  }
}

/** Read once, at collection time, so the skip conditions are cheap to ask. */
const REAL_DICTIONARY = realDictionary();

/** Whether the tests that need the real dictionary can run at all. */
const hasDictionary = REAL_DICTIONARY !== null;

/**
 * The real jieba word list, or `null` when skipping was asked for.
 *
 * Unlike IPADic, this asset *is* a plain file — `word freq tag` per line — so a
 * stand-in could satisfy it in principle. It is the real one anyway, because the
 * point of the tests below is to compare the two pipelines' output, and a
 * stand-in word list would compare them on text neither can segment.
 */
function realJiebaDictionary(): DictionaryBytes | null {
  const asset = resolve(
    dirname(fileURLToPath(import.meta.url)),
    `../../../public/dictionaries/${JIEBA}.bin.zst`
  );
  try {
    return new Uint8Array(readFileSync(asset));
  } catch (error) {
    if (process.env.PHONEMIZE_SKIP_DICT_TESTS === '1') {
      console.warn(`SKIPPING the Chinese dictionary-backed tests: no ${asset}`);
      return null;
    }
    throw new Error(
      `no dictionary at ${asset} (${String(error)}).\n` +
        'Run ./scripts/setup-jieba-dict.sh to build it, or set ' +
        'PHONEMIZE_SKIP_DICT_TESTS=1 to skip the Chinese pipeline tests.'
    );
  }
}

/** Read once, at collection time, so the skip conditions are cheap to ask. */
const REAL_JIEBA = realJiebaDictionary();

/** Whether the tests that need the real word list can run at all. */
const hasJieba = REAL_JIEBA !== null;

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

/** The same, with the Chinese word list behind the wrapper's dictionary source. */
function chinesePhonemizerWith(bytes: DictionaryBytes) {
  const fetch = fakeFetch({ [JIEBA_URL]: { bytes } });
  const phonemizer = new RustPhonemizer({ wasm: WASM, fetch, cacheStorage: new FakeCaches() });
  return { phonemizer, fetch };
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
   * Chinese is used because reaching the seam needs no `prepare` — it needs a
   * dictionary to phonemize, but the seam is reached before that matters. What
   * comes back is `dictionary-not-loaded`, because phase 6 gave Chinese a
   * pipeline and a word list to wait for. That the seam throws a *coded* error
   * rather than returning empty phonemes is the assertion — an empty string
   * would be a sentence that plays as silence.
   */
  it('exposes a callable phonemize seam once ready', async () => {
    const phonemizer = new RustPhonemizer({ wasm: WASM });
    await phonemizer.ready;

    expect(() => phonemizer.phonemize('你好', { frontend: 'kokoro-v1', lang: 'zh-CN' })).toThrow(
      /dictionary-not-loaded/
    );
  });
});

describe('RustPhonemizer.prepare', () => {
  it.skipIf(!hasDictionary)('fetches what the wasm asks for and hands it over', async () => {
    const { phonemizer, fetch, caches } = phonemizerWith(REAL_DICTIONARY ?? undefined);
    await phonemizer.ready;

    await phonemizer.prepare('kokoro-v1', 'ja-JP');

    // The name comes from the wasm, not from this side — `required_dictionaries`
    // is the one place that decides what a language costs, which is what keeps a
    // dictionary swap from being a JavaScript change (spec §3.2).
    expect(fetch.calls).toEqual([IPADIC_URL]);
    expect(caches.bucket(DICTIONARIES_CACHE).has(IPADIC_URL)).toBe(true);
  });

  it('fetches nothing for a language that needs no dictionary', async () => {
    // English's CMU dictionary is compiled into the wasm (spec §2.3), the way
    // espeak's data was meant to be. A `prepare` that demanded a dictionary
    // anyway would fail here, and would also make every English voice
    // unplayable.
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

  it.skipIf(!hasDictionary)('loads every dictionary and then finishes', async () => {
    // Spied on rather than inferred. Without this, a `prepare` that fetched and
    // dropped the bytes — or one that forgot `finish_loading` — passes every
    // other test in this file, and the failure it causes is a pipeline that runs
    // with half a dictionary rather than an error (review focus #2).
    const load = vi.spyOn(WasmPhonemizer.prototype, 'load_dictionary');
    const finish = vi.spyOn(WasmPhonemizer.prototype, 'finish_loading');

    try {
      const { phonemizer } = phonemizerWith(REAL_DICTIONARY ?? undefined);
      await phonemizer.ready;

      await phonemizer.prepare('kokoro-v1', 'ja-JP');

      // Not `toHaveBeenCalledWith(IPADIC, REAL_DICTIONARY)`: vitest's deep
      // equality on an 8.5 MB typed array takes ~10 s (measured), against 2 ms
      // for the memcmp below. The assertion is the same one either way — the
      // bytes the wasm was handed are the bytes that were fetched, all of them.
      const [name, handedOver] = load.mock.calls[0] ?? [];
      expect(name).toBe(IPADIC);
      expect(Buffer.from(handedOver as Uint8Array).equals(Buffer.from(REAL_DICTIONARY ?? []))).toBe(
        true
      );
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

/**
 * The boundary itself, which only a JavaScript test can check.
 *
 * The Rust parity corpus (`crates/phonemize/tests/ja_pipeline.rs`) proves the
 * pipeline produces the right phonemes; it cannot prove that they arrive in
 * JavaScript as `{ phonemes }` rather than, say, as a bare string or with the
 * field named differently. `serde_wasm_bindgen` is what decides that, and this is
 * where a change to it would show up.
 */
describe('RustPhonemizer.phonemize', () => {
  async function prepared(): Promise<RustPhonemizer> {
    const { phonemizer } = phonemizerWith(REAL_DICTIONARY ?? undefined);
    await phonemizer.ready;
    await phonemizer.prepare('kokoro-v1', 'ja-JP');
    return phonemizer;
  }

  it.skipIf(!hasDictionary)("returns the pipeline's phonemes", async () => {
    const phonemizer = await prepared();

    expect(phonemizer.phonemize('経営', { frontend: 'kokoro-v1', lang: 'ja-JP' })).toEqual({
      phonemes: 'keiei',
    });
  });

  it.skipIf(!hasDictionary)('phonemizes a Latin run instead of passing it through', async () => {
    const phonemizer = await prepared();
    const options = { frontend: 'kokoro-v1', lang: 'ja-JP' } as const;

    // Phase 3 handed the characters through, which is what these two samples
    // used to record as a divergence. The corpus says the same thing on the Rust
    // side; this says it survives the boundary.
    expect(phonemizer.phonemize('Chatを使う', options)).toEqual({ phonemes: 'tʃˈætoɕiu' });
    expect(phonemizer.phonemize('あQい', options)).toEqual({ phonemes: 'akjˈuːi' });
  });

  it.skipIf(!hasDictionary)('reports a word the English dictionary does not have', async () => {
    const phonemizer = await prepared();

    // Decision 1.B (Phase 4): OOV words are spelled letter by letter as a
    // fallback instead of being silently dropped. CMU Dict has no `Kokoro`,
    // so it's spelled K-O-K-O-R-O. The warning is no longer produced because
    // the phonemize result is non-empty (the letters were spelled).
    const result = phonemizer.phonemize('Kokoroを使う', {
      frontend: 'kokoro-v1',
      lang: 'ja-JP',
    });

    expect(result).toEqual({
      phonemes: 'kˈeɪ ˈoʊ kˈeɪ ˈoʊ ˈɑːɹ ˈoʊoɕiu',
    });
  });

  it('throws rather than degrading when nothing was prepared', async () => {
    // The seam is synchronous, so this is the failure a caller sees if it skips
    // `prepare` — and it must be an error, not an empty string, because an empty
    // string is a sentence that plays as silence. No dictionary is needed: the
    // call never reaches one.
    const { phonemizer } = phonemizerWith();
    await phonemizer.ready;

    expect(() => phonemizer.phonemize('経営', { frontend: 'kokoro-v1', lang: 'ja-JP' })).toThrow(
      /dictionary-not-loaded/
    );
  });
});

/**
 * Chinese, both pipelines, on the same input.
 *
 * The Rust corpus test (`crates/phonemize/tests/zh_pipeline.rs`) compares the
 * native pipeline against the same committed fixture. This runs the fixture
 * through the **wasm boundary** instead, which is the half only a JavaScript test
 * can check: that the build the extension ships behaves like the one `cargo test`
 * exercised, and that the strings survive `serde_wasm_bindgen` unchanged.
 *
 * The JavaScript half is `ChinesePhonemizer` — the production class, not a
 * reimplementation of it — with a Latin phonemizer that refuses to run, because
 * the fixture contains no Latin text (a Latin run is the one step where the two
 * pipelines deliberately use different engines; see below).
 */
describe('RustPhonemizer and the JavaScript Chinese pipeline', () => {
  /** The committed corpus, generated by `zh-frontend-parity.test.ts`. */
  const CORPUS = JSON.parse(
    readFileSync(
      resolve(
        dirname(fileURLToPath(import.meta.url)),
        '../../../crates/phonemize/tests/fixtures/zh-frontend-parity.json'
      ),
      'utf8'
    )
  ) as { samples: { input: string; js: string }[] };

  async function prepared(): Promise<RustPhonemizer> {
    const { phonemizer } = chinesePhonemizerWith(REAL_JIEBA ?? new Uint8Array());
    await phonemizer.ready;
    await phonemizer.prepare('kokoro-v1', 'zh-CN');
    return phonemizer;
  }

  it.skipIf(!hasJieba)('asks the wasm for the jieba word list', async () => {
    // The name is the wasm's to decide, and it changed in phase 6: Chinese used
    // to fetch nothing. Asserted here so that a change to the dictionary table is
    // visible on the JavaScript side, which is the side that has to be able to
    // find the file.
    const { phonemizer, fetch } = chinesePhonemizerWith(REAL_JIEBA ?? new Uint8Array());
    await phonemizer.ready;
    await phonemizer.prepare('kokoro-v1', 'zh-CN');

    expect(fetch.calls).toEqual([JIEBA_URL]);
  });

  it.skipIf(!hasJieba)('agrees with the JavaScript pipeline on the corpus', async () => {
    await ensureJieba();
    const phonemizer = await prepared();
    const javascript = new ChinesePhonemizer((text) =>
      Promise.reject(new Error(`the corpus must not contain Latin text: ${text}`))
    );

    const failures: string[] = [];
    for (const sample of CORPUS.samples) {
      const rust = phonemizer.phonemize(sample.input, { frontend: 'kokoro-v1', lang: 'zh-CN' });
      const js = await javascript.phonemize(sample.input, 'zh-CN');
      if (rust.phonemes !== js) {
        failures.push(
          `${JSON.stringify(sample.input)}\n  javascript ${JSON.stringify(js)}\n  rust       ${JSON.stringify(rust.phonemes)}`
        );
      }
    }

    expect(failures.join('\n')).toBe('');
  });

  it.skipIf(!hasJieba)('differs from JavaScript only where the Latin engine does', async () => {
    // The one deliberate divergence, recorded rather than left to be discovered.
    // `chinese.ts` sends a Latin run to espeak; the Rust pipeline sends it to its
    // CMU Dict backend (the phase 4 decision). The Han either side is identical,
    // and that is the part that has to be.
    await ensureJieba();
    const phonemizer = await prepared();
    const javascript = new ChinesePhonemizer(async (text) => `«${text}»`);

    const rust = phonemizer.phonemize('你好ABC世界', { frontend: 'kokoro-v1', lang: 'zh-CN' });
    const js = await javascript.phonemize('你好ABC世界', 'zh-CN');

    // The original text has no spaces, so there are none in the output either:
    // the runs are concatenated with nothing inserted between them.
    expect(js).toBe('ni↓xau↓«ABC»ʂɻ̩↘ʨje↘');
    // The Latin half is the English engine's, so it is not `«ABC»` — but the Han
    // halves are the same two strings, in the same order, with nothing inserted
    // between the runs.
    expect(rust.phonemes).not.toContain('«');
    expect(rust.phonemes.startsWith('ni↓xau↓')).toBe(true);
    expect(rust.phonemes.endsWith('ʂɻ̩↘ʨje↘')).toBe(true);
  });
});
