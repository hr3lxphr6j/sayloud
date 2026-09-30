/**
 * The phonemization seam (P4 spec §3.8.1).
 *
 * Kokoro consumes IPA, not text, and the two languages P4 ships need
 * completely different front ends: English goes through espeak-ng, Chinese
 * through a pinyin lookup table plus tone marks (spec §3.11.1). The engine
 * should not have to know which — it asks for IPA and gets IPA.
 *
 * Injectable on purpose. The real Chinese phonemizer is pure JavaScript and
 * cheap to test, but the English one loads a 1.3 MB inlined espeak wasm, and
 * the engine behind this interface loads a 92–325 MB model. Tests and the e2e
 * build substitute `FakePhonemizer` so neither ever runs there.
 *
 * Asynchronous because both real implementations are: espeak-ng's wasm
 * entry point returns a promise, and the Chinese path awaits it for the Latin
 * runs inside mixed text. The spec sketches this as a synchronous `string`,
 * which would force the English path to block on a promise it cannot resolve
 * (see the T3 notes in the plan).
 */
export interface Phonemizer {
  /** Text to IPA, with tone markers. One string; may mix Chinese and English. */
  phonemize(text: string, lang: string): Promise<string>;
}

/**
 * True for a language whose text goes down the Chinese pipeline.
 *
 * Only the primary subtag matters: `zh`, `zh-CN`, `zh-Hans` and `zh-TW` all
 * take the same path — P4's table is Mandarin, and the traditional/simplified
 * split is a writing system rather than a pronunciation.
 */
export function isChinese(lang: string): boolean {
  return lang.toLowerCase().startsWith('zh');
}
