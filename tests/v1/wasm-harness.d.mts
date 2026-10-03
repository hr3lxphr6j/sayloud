/**
 * Types for `wasm-harness.mjs`.
 *
 * The harness is deliberately `.mjs`: `performance-benchmark.mjs` is a plain
 * Node script (`node tests/v1/performance-benchmark.mjs`), so it cannot import
 * a TypeScript module. That leaves `comparison.test.ts` importing an untyped
 * `.mjs`, which `tsc --noEmit` rejects with TS7016 unless the shape is declared
 * somewhere -- hence this file rather than a `// @ts-expect-error` or an
 * `allowJs` change to the project's tsconfig.
 *
 * Only the surface the test uses is declared.
 */

/** Absolute path of the sandbox holding the installed package. */
export declare const SANDBOX: string;
/** Where `setup.sh` writes the TONE3 dictionaries. */
export declare const DERIVED: string;
/** Where `setup.sh` fetches the upstream assets. */
export declare const UPSTREAM_ASSETS: string;
/** The 57 MB wasm binary as the package ships it. */
export declare const WASM_PATH: string;

export declare const MARKERS: { BOS: string; EOS: string; PAD: string };

/** PUA char -> multi-character token and back. */
export declare function loadPuaMap(): Promise<{
  forward: Record<string, string>;
  reverse: Record<string, string>;
}>;

/** One phonemization result, with the encoder's framing already stripped. */
export interface PhonemizeOutcome {
  /** Phoneme tokens, PUA code points expanded back to multi-char names. */
  tokens: string[];
  /** The PUA code points that were expanded, in order. */
  puaTokens: string[];
  /** `tokens` joined. Readable, but ambiguous for multi-char tokens. */
  output: string;
  /** The raw phoneme string, PUA left as-is: what a model config would key on. */
  puaOutput: string;
  /** Length of the ID stream including BOS/EOS/PAD, not the phoneme count. */
  phonemeCount: number;
  /** `prosodyFeatures.length / 3`. */
  prosodyFeatureCount: number;
}

/** Cold-start measurements taken while building the harness. */
export interface HarnessTimings {
  wasmBytes: number;
  instantiateMs: number;
  constructMs: number;
}

export declare class PiperWasmHarness {
  readonly timings: HarnessTimings;
  chineseDictionaryLoaded: boolean;
  loadChineseDictionary(variant?: 'converted' | 'upstream'): void;
  phonemize(text: string, language?: string): PhonemizeOutcome;
  detectLanguage(text: string): string;
  supportedLanguages(): string[];
  isZhEnDispatchEnabled(): boolean;
}

export declare function createHarness(options?: { quiet?: boolean }): Promise<PiperWasmHarness>;

/** Result of running one string through a vocabulary-as-`phoneme_id_map`. */
export interface VocabAnalysis {
  totalPhonemes: number;
  covered: number;
  dropped: number;
  droppedRatio: number;
  coveredTokens: string[];
}

export declare function createVocabHarness(
  vocabChars: string[],
  options?: { chineseDictionary?: 'converted' | 'upstream' | null }
): Promise<{
  mapSize: number;
  constructMs: number;
  chineseDictionaryLoaded: boolean;
  analyze(text: string, language: string): VocabAnalysis;
}>;
