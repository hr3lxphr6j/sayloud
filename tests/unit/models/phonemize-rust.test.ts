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

/** Where the built dictionaries live. */
const ASSETS = resolve(dirname(fileURLToPath(import.meta.url)), '../../../public/dictionaries');

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
 * loaded nothing cannot look like one that worked. Every grammar is routed as
 * well as IPADic, because a `prepare('kokoro-v1', 'ja-JP')` now asks for three
 * files and the route table is what answers them.
 */
function phonemizerWith(bytes: DictionaryBytes = COMPRESSED) {
  const fetch = fakeFetch(served({ [IPADIC_URL]: bytes, ...grammarRoutes() }));
  const caches = new FakeCaches();
  const phonemizer = new RustPhonemizer({ wasm: WASM, fetch, cacheStorage: caches });
  return { phonemizer, fetch, caches };
}

/** The same, with the Chinese word list behind the wrapper's dictionary source. */
function chinesePhonemizerWith(bytes: DictionaryBytes) {
  const fetch = fakeFetch(served({ [JIEBA_URL]: bytes, ...grammarRoutes() }));
  const phonemizer = new RustPhonemizer({ wasm: WASM, fetch, cacheStorage: new FakeCaches() });
  return { phonemizer, fetch };
}

/**
 * Every text-normalization grammar the registry can ask for.
 *
 * All three languages read their numerals through the vendored WeText engine:
 * English's pair since phase 9B, Chinese's and Japanese's since 9E. English's
 * *pronunciation* dictionary is compiled into the wasm — the CMU
 * dictionary — so for English these two are the whole of what `prepare`
 * fetches, and for the other two they arrive alongside IPADic or jieba's word
 * list.
 *
 * Listed together because `phonemizerWith` has to satisfy `/dictionaries/*` for
 * whichever language a test asks about, and because the failure mode this
 * prevents is a route table that only knows about the language it was written
 * for — the phase 9E change broke exactly that in this file.
 */
const WETEXT = [
  'wetext-en-tn-tagger',
  'wetext-en-tn-verbalizer',
  'wetext-zh-tn-tagger',
  'wetext-zh-tn-verbalizer',
  'wetext-ja-tn-tagger',
  'wetext-ja-tn-verbalizer',
] as const;

/** Where the wrapper looks for one grammar. */
function dictionaryUrl(name: string): string {
  return `/dictionaries/${name}.bin.zst`;
}

/** The English pair, in the order the wasm asks for them. */
const WETEXT_EN = WETEXT.filter((name) => name.includes('-en-'));

/** Where the wrapper looks for each of the English grammars. */
const WETEXT_EN_URLS = WETEXT_EN.map(dictionaryUrl);

/** The Japanese pair. */
const WETEXT_JA_URLS = WETEXT.filter((name) => name.includes('-ja-')).map(dictionaryUrl);

/** The Chinese pair. */
const WETEXT_ZH_URLS = WETEXT.filter((name) => name.includes('-zh-')).map(dictionaryUrl);

/**
 * One grammar asset, or `null` when skipping was asked for.
 *
 * Read once at collection time, like the two dictionaries above and under the
 * same rule: missing is a failure, and skipping is asked for by name.
 */
function readGrammar(name: string): DictionaryBytes | null {
  try {
    return new Uint8Array(readFileSync(resolve(ASSETS, `${name}.bin.zst`))) as DictionaryBytes;
  } catch (error) {
    if (process.env.PHONEMIZE_SKIP_DICT_TESTS === '1') {
      console.warn(`SKIPPING the text-normalization tests: no ${name} (${String(error)})`);
      return null;
    }
    throw new Error(
      `no ${name} grammar (${String(error)}).\n` +
        'Run ./scripts/setup-wetext-fsts.sh to build them, or set ' +
        'PHONEMIZE_SKIP_DICT_TESTS=1 to skip the text-normalization tests.'
    );
  }
}

/**
 * A fake-fetch route table covering every grammar.
 *
 * The real assets, not a stand-in: `finish_loading` parses them, so a transport
 * fixture would fail there rather than pass quietly. In skip mode the fixture is
 * used instead — the tests that reach `finish_loading` have already guarded
 * themselves with `skipIf`, and the ones that do not never get that far.
 */
function grammarRoutes(): Record<string, DictionaryBytes> {
  const routes: Record<string, DictionaryBytes> = {};
  for (const name of WETEXT) routes[dictionaryUrl(name)] = readGrammar(name) ?? COMPRESSED;
  return routes;
}

/** A route table of `url -> { bytes }`, which is what `fakeFetch` wants. */
function served(routes: Record<string, DictionaryBytes>) {
  return Object.fromEntries(Object.entries(routes).map(([url, bytes]) => [url, { bytes }]));
}

/** The same as `phonemizerWith`, with every grammar behind it as well. */
function phonemizerWithEnglish() {
  const fetch = fakeFetch(served(grammarRoutes()));
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

    // The names come from the wasm, not from this side — `required_dictionaries`
    // is the one place that decides what a language costs, which is what keeps a
    // dictionary swap from being a JavaScript change. Three since
    // phase 9E: IPADic and the two Japanese TN grammars.
    expect(fetch.calls).toEqual([IPADIC_URL, ...WETEXT_JA_URLS]);
    for (const url of fetch.calls) {
      expect(caches.bucket(DICTIONARIES_CACHE).has(url)).toBe(true);
    }
  });

  it('fetches the text-normalization grammars English needs', async () => {
    // English's *pronunciation* dictionary is compiled into the wasm (spec
    // §2.3) — the CMU dictionary — and this test used to assert that a
    // `prepare('kokoro-v1', 'en-US')` therefore fetched nothing. Phase 9B made
    // that false: the numerals go through vendored WeText grammars, and those
    // are 12 MB of OpenFST binary, so they are fetched on `prepare` the way
    // IPADic and jieba's word list are.
    //
    // Both, in the order the wasm asks for them, and parsed — `finish_loading`
    // is inside `prepare`, so a stand-in frame would fail here rather than pass
    // silently.
    const { phonemizer, fetch } = phonemizerWithEnglish();
    await phonemizer.ready;

    await phonemizer.prepare('kokoro-v1', 'en-US');

    expect(fetch.calls).toEqual(WETEXT_EN_URLS);
  });

  it('still phonemizes English with no dictionary at all', async () => {
    // The property phase 9B's fallback exists to keep. English used to be the
    // language `prepare` had nothing to do for, so a caller that never called it
    // is not an error: the hand-written numeral reader is still compiled in, and
    // the pipeline falls back to it rather than refusing or losing the digits.
    const phonemizer = new RustPhonemizer({ wasm: WASM });
    await phonemizer.ready;

    expect(
      phonemizer.phonemize('I have 3 cats', { frontend: 'kokoro-v1', lang: 'en-US' }).phonemes
    ).toBe('aɪ hæv θɹˈiː kˈæts');
  });

  it('rejects a language the frontend cannot speak', async () => {
    // v1.1-zh has no Japanese frontend. Reported
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

  it.skipIf(!hasDictionary)('reads a word the English dictionary does not have', async () => {
    const phonemizer = await prepared();

    // Phase 9A: OOV words go through the NRL 7948 letter-to-sound rules instead
    // of being spelled out letter by letter. CMU Dict has no `Kokoro`, so the
    // rules read it — `kɑkɔɹoʊ`, one reading, where phase 4's fallback spelled it
    // `kˈeɪ ˈoʊ kˈeɪ ˈoʊ ˈɑːɹ ˈoʊ` as K-O-K-O-R-O. The same change is asserted in
    // `crates/phonemize/tests/ja_pipeline.rs`; this one says it survives the wasm
    // boundary, which is the half a `cargo test` cannot check.
    const result = phonemizer.phonemize('Kokoroを使う', {
      frontend: 'kokoro-v1',
      lang: 'ja-JP',
    });

    expect(result).toEqual({
      phonemes: 'kɑkɔɹoʊoɕiu',
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
describe('RustPhonemizer and the Chinese dictionary', () => {
  it.skipIf(!hasJieba)('asks the wasm for the jieba word list', async () => {
    // The names are the wasm's to decide, and they changed twice: Chinese used to
    // fetch nothing, then just the word list (phase 6), and since phase 9E the
    // word list and its two TN grammars. Asserted here so that a change to the
    // dictionary table is visible on the wrapper side, which is the side that has
    // to be able to find the files.
    const { phonemizer, fetch } = chinesePhonemizerWith(REAL_JIEBA ?? new Uint8Array());
    await phonemizer.ready;
    await phonemizer.prepare('kokoro-v1', 'zh-CN');

    expect(fetch.calls).toEqual([JIEBA_URL, ...WETEXT_ZH_URLS]);
  });
});
