/**
 * The phonemization seam, and the one place that picks a side (spec §3.8.1).
 *
 * Only the light modules are re-exported eagerly. The real front ends are
 * loaded through `phonemizerFor`, because importing all three would put espeak-ng's
 * 1.3 MB of inlined wasm into the graph of anything that merely needs the
 * `Phonemizer` type or the fake — including every unit test.
 */
import { isChinese, isJapanese, type Phonemizer } from './types';

export type { WordBoundaries } from './chinese';
export {
  ChinesePhonemizer,
  ensureJieba,
  hanToIpa,
  jiebaBoundaries,
  joinByWords,
  mapPunctuation,
  retone,
  singleSyllableWords,
  splitRuns,
  TONE_MAPPING,
  UnknownSyllableError,
} from './chinese';
export { FakePhonemizer, type FakePhonemizerOptions, type PhonemizeCall } from './fake';
export { JapanesePhonemizer, kanaToIPA, phonemizeJapanese, textToKatakana } from './japanese';
export { intToHan, numbersToHan } from './numbers';
export type { Phonemizer } from './types';
export { isChinese, isJapanese } from './types';

/**
 * The phonemizer for a language.
 *
 * Chinese, Japanese, and English take completely different paths and only one
 * is ever needed for a given sentence, so each is imported on demand rather than
 * all being bundled into every caller.
 */
export async function phonemizerFor(lang: string): Promise<Phonemizer> {
  if (isChinese(lang)) {
    const { ChinesePhonemizer } = await import('./chinese');
    return new ChinesePhonemizer();
  }
  if (isJapanese(lang)) {
    const { JapanesePhonemizer } = await import('./japanese');
    return new JapanesePhonemizer();
  }
  const { EnglishPhonemizer } = await import('./english');
  return new EnglishPhonemizer();
}
