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

import init, { type InitInput, Phonemizer as WasmPhonemizer } from './phonemize-wasm/phonemize';

/** The phoneme inventory to produce. Follows the chosen voice, not the text. */
export type FrontendId = 'kokoro-v1' | 'kokoro-v11-zh';

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
}

export class RustPhonemizer {
  private instance: WasmPhonemizer | null = null;
  /** Resolves once wasm is instantiated and the instance is usable. */
  public readonly ready: Promise<void>;

  /**
   * @param wasm Where to find the wasm binary. Defaults to wasm-pack's own
   *   resolution — a URL relative to the generated JS, which is what the
   *   extension build serves. Tests pass the bytes instead: there is no HTTP
   *   server behind the unit environment, so the URL path cannot resolve there.
   */
  constructor(wasm?: InitInput | Promise<InitInput>) {
    this.ready = this.initialize(wasm);
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
   * Preload the dictionaries the given frontends need.
   *
   * Asynchronous because it is fetch plus decompression. Kept out of
   * `phonemize` on purpose: the caller already knows which languages are
   * involved — it comes from the selected voice — so it decides when to pay for
   * loading, and `phonemize` can stay synchronous.
   */
  async prepare(_frontends: readonly FrontendId[]): Promise<void> {
    if (!this.instance) throw new Error('Phonemizer not ready');
    // TODO(task 2.x): fetch the names `required_dictionaries` returns, then feed
    // each one to the wasm compressed.
  }

  /**
   * Text to phonemes. Synchronous once `ready` has resolved.
   *
   * Throws if a dictionary is missing rather than degrading quietly, and throws
   * `UnsupportedLanguageError` when the frontend cannot speak `lang`.
   */
  phonemize(_text: string, _options: PhonemizeOptions): PhonemizeResult {
    if (!this.instance) throw new Error('Phonemizer not ready');
    // TODO(task 3.x): call the wasm pipeline.
    return { phonemes: '' };
  }
}
