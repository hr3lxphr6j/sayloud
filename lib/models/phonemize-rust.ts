/**
 * The Rust phonemizer (P6).
 *
 * Replaces the JavaScript chain — kuromoji + kuroshiro + jieba + espeak +
 * pinyin-pro — with a single wasm module. See
 * `docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md`.
 *
 * `ready` is the whole async story. Once it resolves, `phonemize` is
 * synchronous: the pipeline runs entirely inside the wasm, with no I/O, which is
 * the point of the migration (spec §3.1). Dictionaries are the one exception and
 * are loaded explicitly through `prepare`, before the first call.
 *
 * `./phonemize-wasm/` is wasm-pack output — a build artifact, not source. Run
 * `pnpm build:wasm` before type-checking or testing this file; `pnpm build` does
 * it through its `prebuild` hook.
 */

import type { FrontendId } from './frontend';
import {
  type DictionaryCacheStorage,
  DictionaryLoadError,
  dictionaryFailure,
  type FetchLike,
  fetchDictionary,
} from './phonemize-dict';
import init, { type InitInput, Phonemizer as WasmPhonemizer } from './phonemize-wasm/phonemize';

/**
 * The phoneme inventory to produce. Follows the chosen voice, not the text.
 *
 * Declared in `./frontend` so the model registry can name one without reaching
 * this module's wasm; re-exported because this is where a caller of the
 * phonemizer expects to find it.
 */
export type { FrontendId };

export interface PhonemizeOptions {
  readonly frontend: FrontendId;
  /** BCP-47 tag of the text. */
  readonly lang: string;
}

/**
 * Where a run of phonemes came from, for word-level highlighting.
 *
 * Offsets are into the *input* text. Deliberately unpopulated in v1: the engine
 * highlights per sentence today, and this exists so adding word-level later does
 * not change the signature.
 */
export interface PhonemeSpan {
  readonly charStart: number;
  readonly charEnd: number;
  readonly phonemeStart: number;
  readonly phonemeEnd: number;
}

export interface PhonemizeResult {
  /**
   * Exactly what goes into the tokenizer. Guaranteed to contain only characters
   * the target model's vocabulary keeps.
   */
  readonly phonemes: string;
  readonly spans?: readonly PhonemeSpan[];
  /**
   * Runs of text that produced no phonemes, one message each.
   *
   * Absent when there are none, which is the common case — the Rust side omits
   * the field rather than sending an empty array. Today only one thing lands
   * here: a Latin run the English dictionary has no entry for, which is dropped
   * (`crates/phonemize/src/pipeline.rs`). It travels with the result rather than
   * being an error because the sentence still plays; it is not silent because a
   * dropped word is audible as a missing word.
   */
  readonly warnings?: readonly string[];
}

export interface RustPhonemizerDeps {
  /**
   * Where to find the wasm binary. Defaults to wasm-pack's own resolution — a
   * URL relative to the generated JS, which is what the extension build serves.
   * Tests pass the bytes instead: there is no HTTP server behind the unit
   * environment, so the URL path cannot resolve there.
   */
  readonly wasm?: InitInput | Promise<InitInput>;
  /** Injected for tests; defaults to the page's `fetch`. */
  readonly fetch?: FetchLike;
  /** Injected for tests; defaults to the page's Cache Storage. */
  readonly cacheStorage?: DictionaryCacheStorage | null;
  /** Injected for tests; defaults to `/dictionaries/{name}.bin.zst`. */
  readonly dictionaryUrl?: (name: string) => string;
}

export class RustPhonemizer {
  private instance: WasmPhonemizer | null = null;
  /** Resolves once wasm is instantiated and the instance is usable. */
  public readonly ready: Promise<void>;

  constructor(private readonly deps: RustPhonemizerDeps = {}) {
    this.ready = this.initialize(deps.wasm);
  }

  private async initialize(wasm?: InitInput | Promise<InitInput>): Promise<void> {
    if (wasm === undefined) {
      await init();
    } else {
      await init({ module_or_path: wasm });
    }
    this.instance = new WasmPhonemizer();
  }

  /**
   * Preload the dictionaries `(frontend, lang)` needs.
   *
   * Asynchronous because it is fetch plus decompression. Kept out of
   * `phonemize` on purpose: the caller already knows which language is involved
   * — it comes from the selected voice (spec §1.5) — so it decides when to pay
   * for loading, and `phonemize` can stay synchronous. Calling it as soon as the
   * voice is picked is what keeps the cost off the first sentence.
   *
   * Throws a {@link DictionaryLoadError}, including for a voice the frontend
   * cannot speak. Safe to call again for a language already loaded: the wasm
   * keeps the first copy.
   */
  async prepare(frontend: FrontendId, lang: string): Promise<void> {
    const instance = this.requireInstance();

    // The wasm decides which dictionaries exist and what they are called; this
    // side only moves the bytes (spec §3.2).
    const names = this.callWasm(() => instance.required_dictionaries(frontend, lang));

    // All at once, then fed one by one: the fetches are independent, and the
    // wasm is single-threaded anyway.
    const fetched = await Promise.all(
      names.map(async (name) => [name, await this.dictionary(name)] as const)
    );

    for (const [name, bytes] of fetched) {
      this.callWasm(() => instance.load_dictionary(name, bytes));
    }
    this.callWasm(() => instance.finish_loading());
  }

  /**
   * Text to phonemes. Synchronous once `ready` has resolved.
   *
   * Throws if a dictionary is missing rather than degrading quietly, and throws
   * when the frontend cannot speak `lang`.
   *
   * The wasm's error is passed through rather than put through
   * {@link dictionaryFailure}: these failures are not dictionary *loads* — a
   * segmenter that could not be built, or a `prepare` that never ran — and
   * classifying them as load failures would report the wrong reason. The wasm
   * already throws an `Error` carrying a stable `code` (spec §8.1).
   */
  phonemize(text: string, options: PhonemizeOptions): PhonemizeResult {
    const instance = this.requireInstance();
    // `JsValue` on the wasm side, so the generated signature is `any`; the shape
    // is `PhonemizeResult` on both sides of the boundary (`src/types.rs`).
    return instance.phonemize(text, options) as PhonemizeResult;
  }

  private requireInstance(): WasmPhonemizer {
    if (!this.instance) throw new Error('Phonemizer not ready');
    return this.instance;
  }

  /** One dictionary's compressed bytes, from the cache or from the install. */
  private dictionary(name: string): Promise<Uint8Array> {
    return fetchDictionary(name, {
      fetch: this.deps.fetch,
      cacheStorage: this.deps.cacheStorage,
      url: this.deps.dictionaryUrl,
    });
  }

  /**
   * Run a wasm call, classifying what it throws.
   *
   * The Rust side throws an `Error` carrying a `code`; this is where that becomes
   * a `DictionaryLoadError` the caller can switch on. Wrapping here rather than
   * at each call site keeps the reason vocabulary in one place.
   */
  private callWasm<T>(call: () => T): T {
    try {
      return call();
    } catch (error) {
      throw dictionaryFailure(error);
    }
  }
}
