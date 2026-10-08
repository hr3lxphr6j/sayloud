/**
 * The phonemize worker's behaviour, against the real wasm and the real
 * dictionaries.
 *
 * `phonemize-rust.test.ts` proves `RustPhonemizer` itself; this proves the
 * layer the worker actually drives — that `init` can be retried, that `prepare`
 * is what makes a language usable, and that the three languages the extension
 * ships come back with the phonemes the corpus expects. The last part matters
 * because a worker that answered `{ phonemes: '' }` would satisfy every
 * protocol test in the suite and play as silence.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DictionaryBytes } from '~/lib/models/phonemize-dict';
import { DictionaryLoadError } from '~/lib/models/phonemize-dict';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';
import { PhonemizeService } from '~/lib/models/phonemize-service';
import { FakeCaches, fakeFetch } from './fakes';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');

/**
 * wasm-pack's generated JS resolves `phonemize_bg.wasm` with a URL relative to
 * itself and `fetch`es it. The unit environment has no server to answer that,
 * so the binary is read off disk and handed over directly.
 */
const WASM = new Uint8Array(
  readFileSync(resolve(ROOT, 'lib/models/phonemize-wasm/phonemize_bg.wasm'))
);

/** The Japanese dictionary the wasm asks for, and where it looks for it. */
const IPADIC = 'lindera-ipadic-ja';
const IPADIC_URL = `/dictionaries/${IPADIC}.bin.zst`;

/** The Chinese word list. */
const JIEBA = 'jieba-zh-dict';
const JIEBA_URL = `/dictionaries/${JIEBA}.bin.zst`;

/**
 * Every text-normalization grammar the registry can ask for (phases 9B, 9E).
 *
 * English's *pronunciation* dictionary is still compiled into the wasm — the CMU
 * dictionary — but all three languages read their numerals through the
 * vendored WeText engine, and those grammars are OpenFST binaries. They arrive
 * the same way IPADic and jieba's word list do.
 */
const WETEXT_EN = [
  'wetext-en-tn-tagger',
  'wetext-en-tn-verbalizer',
  'wetext-tn-full-to-half',
] as const;
const WETEXT_ZH = [
  'wetext-zh-tn-tagger',
  'wetext-zh-tn-verbalizer',
  'wetext-zh-tn-traditional-to-simple',
] as const;
const WETEXT_JA = [
  'wetext-ja-tn-tagger',
  'wetext-ja-tn-verbalizer',
  'wetext-tn-full-to-half',
] as const;

/**
 * The English ones *and* the language's own, for a `prepare` that asks for all
 * of them.
 *
 * `prepare('kokoro-v1', 'zh-CN')` fetches jieba's word list and the two Chinese
 * grammars, so a route table that only serves the word list fails inside
 * `finish_loading` — which is what happened when the second half of that list
 * was added and this file still spelled it out by hand.
 */
function wetextRoutes(names: readonly string[]): Record<string, DictionaryBytes> {
  return Object.fromEntries(
    names.map((name) => [`/dictionaries/${name}.bin.zst`, asset(name) ?? new Uint8Array()])
  );
}

/**
 * A shipped dictionary, or null when skipping was asked for.
 *
 * Missing is a failure, not a skip: these are the only tests that run the
 * three languages through the worker's own seam, and a test that passes because
 * its input was absent is a false green. `PHONEMIZE_SKIP_DICT_TESTS=1` is how
 * skipping is asked for by name.
 */
function asset(name: string): DictionaryBytes | null {
  const path = resolve(ROOT, `public/dictionaries/${name}.bin.zst`);
  try {
    return new Uint8Array(readFileSync(path));
  } catch (error) {
    if (process.env.PHONEMIZE_SKIP_DICT_TESTS === '1') {
      console.warn(`SKIPPING the dictionary-backed tests: no ${path}`);
      return null;
    }
    throw new Error(
      `no dictionary at ${path} (${String(error)}).\n` +
        'Run ./scripts/setup/setup-lindera-dict.sh and ./scripts/setup/setup-jieba-dict.sh, or set ' +
        'PHONEMIZE_SKIP_DICT_TESTS=1 to skip them.'
    );
  }
}

const REAL_IPADIC = asset(IPADIC);
const REAL_JIEBA = asset(JIEBA);

/** The English grammars, or null when skipping was asked for. */
const REAL_WETEXT_EN = Object.fromEntries(
  WETEXT_EN.map((name) => [name, asset(name)] as const)
) as Record<(typeof WETEXT_EN)[number], DictionaryBytes | null>;

/** Whether every English grammar is there, for the tests that need them. */
const hasWetextEn = WETEXT_EN.every((name) => REAL_WETEXT_EN[name] !== null);

/** The routes that serve the English grammars, for a test that needs them. */
function wetextEnRoutes(): Record<string, DictionaryBytes> {
  return wetextRoutes(WETEXT_EN);
}

/** A service whose phonemizer reads its dictionaries from the given routes. */
function serviceWith(routes: Record<string, DictionaryBytes>): PhonemizeService {
  const fetch = fakeFetch(
    Object.fromEntries(Object.entries(routes).map(([url, bytes]) => [url, { bytes }]))
  );
  return new PhonemizeService({
    create: () => new RustPhonemizer({ wasm: WASM, fetch, cacheStorage: new FakeCaches() }),
  });
}

describe('PhonemizeService', () => {
  it('instantiates the wasm once, however many times it is asked', async () => {
    // `init` is the one message the coordinator may repeat, because neither
    // side memoizes a *failed* handshake. Repeating a successful one must not
    // pay for a second instantiation of 5 MB of wasm.
    let built = 0;
    const service = new PhonemizeService({
      create: () => {
        built += 1;
        return new RustPhonemizer({ wasm: WASM });
      },
    });

    await service.init();
    await service.init();
    await service.init();

    expect(built).toBe(1);
  });

  it('refuses to phonemize before init', () => {
    // The coordinator cannot reach this — it awaits the handshake first — but
    // the failure has to be an error rather than an empty string, because an
    // empty string is a sentence that plays as silence.
    const service = new PhonemizeService();

    expect(() => service.phonemize('hello', 'kokoro-v1', 'en-US')).toThrow('not initialised');
  });

  it('refuses to phonemize after dispose', async () => {
    const service = new PhonemizeService({ create: () => new RustPhonemizer({ wasm: WASM }) });
    await service.init();
    service.dispose();

    expect(() => service.phonemize('hello', 'kokoro-v1', 'en-US')).toThrow('not initialised');
  });

  it.skipIf(!hasWetextEn)('reads English through its text-normalization grammars', async () => {
    // A `prepare` for English does fetch something, so this is no longer a test
    // that it fetches *nothing* (there is one of those further down, for the
    // vocabulary table). What it pins is the seam: the two grammars
    // are loaded, the pipeline uses them, and the sentence still comes out.
    const service = serviceWith(wetextEnRoutes());
    await service.init();

    await service.prepare('kokoro-v1', 'en-US');

    expect(service.phonemize('hello world', 'kokoro-v1', 'en-US').phonemes).toBe('həlˈoʊ wˈɜːld');
    // "fifty percent" — the word the deleted hand-written reader dropped, and
    // the reason the grammars are fetched at all.
    expect(service.phonemize('50%', 'kokoro-v1', 'en-US').phonemes).toBe('fˈɪftiː pɚsˈɛnt');
  });

  it.skipIf(REAL_IPADIC === null)('speaks Japanese once its dictionary is loaded', async () => {
    const service = serviceWith({
      [IPADIC_URL]: REAL_IPADIC ?? new Uint8Array(),
      ...wetextRoutes(WETEXT_JA),
    });
    await service.init();

    await service.prepare('kokoro-v1', 'ja-JP');

    // The same string `ja_pipeline.rs` pins on the Rust side: what this proves
    // is that it survives the worker's seam.
    expect(service.phonemize('経営', 'kokoro-v1', 'ja-JP').phonemes).toBe('keiei');

    // And the numeral step the grammars are fetched for: `1/2` is 二分の一, which
    // the deleted hand-written reader read as the two cardinals いちに.
    expect(service.phonemize('1/2', 'kokoro-v1', 'ja-JP').phonemes).toBe('nibuɴnoiʨi');
  });

  it.skipIf(REAL_JIEBA === null)('speaks Chinese once its word list is loaded', async () => {
    const service = serviceWith({
      [JIEBA_URL]: REAL_JIEBA ?? new Uint8Array(),
      ...wetextRoutes(WETEXT_ZH),
    });
    await service.init();

    await service.prepare('kokoro-v1', 'zh-CN');

    // `ni↗xau↓` and not `ni↓xau↓`: tone sandhi raises the first of
    // two third tones, so this is the shipped reading of 你好. The Rust side pins
    // both readings — the shipped one in `tests/tone_sandhi.rs` and the one the
    // JavaScript frontend produced in `tests/zh_pipeline.rs`.
    expect(service.phonemize('你好', 'kokoro-v1', 'zh-CN').phonemes).toBe('ni↗xau↓');

    // And the numeral step: a year read as a year. `2024年` is 二零二四年 —
    // èr líng èr sì nián — where the deleted hand-written reader read 2024 as a
    // quantity and said 二千零二十四年. Pinned on the Rust side in `tests/wetext_zh.rs` and
    // `tests/zh_pipeline.rs`; this says it survives the seam.
    expect(service.phonemize('2024年', 'kokoro-v1', 'zh-CN').phonemes).toBe('ɚ↘li↗ŋɚ↘ sɹ̩↘njɛ↗n');
  });

  it.skipIf(REAL_JIEBA === null)('refuses a language the vocabulary cannot speak', async () => {
    // v1.1-zh has no Japanese pipeline. The reason is what the worker turns
    // into a provider code, so it has to survive the wasm boundary intact.
    const service = serviceWith({});
    await service.init();

    const error = await service
      .prepare('kokoro-v11-zh', 'ja-JP')
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(DictionaryLoadError);
    expect((error as DictionaryLoadError).reason).toBe('unsupported-language');
  });

  it.skipIf(REAL_IPADIC === null)('refuses to phonemize a language it never prepared', async () => {
    // Not an empty string: a segmenter that is not there would otherwise be a
    // sentence read without word boundaries, which is audible.
    const service = serviceWith({});
    await service.init();

    expect(() => service.phonemize('経営', 'kokoro-v1', 'ja-JP')).toThrow(/dictionary-not-loaded/);
  });
});
