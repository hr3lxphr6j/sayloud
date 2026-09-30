/**
 * The phonemization seam, and the one place that picks a side (spec §3.8.1).
 *
 * Only the light modules are re-exported eagerly. The real front ends are
 * loaded through `phonemizerFor`, because importing both would put espeak-ng's
 * 1.3 MB of inlined wasm into the graph of anything that merely needs the
 * `Phonemizer` type or the fake — including every unit test.
 */
import { isChinese, type Phonemizer } from './types';

export {
  ChinesePhonemizer,
  hanToIpa,
  mapPunctuation,
  retone,
  splitRuns,
  TONE_MAPPING,
  UnknownSyllableError,
} from './chinese';
export { FakePhonemizer, type FakePhonemizerOptions, type PhonemizeCall } from './fake';
export { intToHan, numbersToHan } from './numbers';
export type { Phonemizer } from './types';
export { isChinese } from './types';

/**
 * The phonemizer for a language.
 *
 * Chinese and English take completely different paths and only one of them is
 * ever needed for a given sentence, so each is imported on demand rather than
 * both being bundled into every caller.
 */
export async function phonemizerFor(lang: string): Promise<Phonemizer> {
  if (isChinese(lang)) {
    const { ChinesePhonemizer } = await import('./chinese');
    return new ChinesePhonemizer();
  }
  const { EnglishPhonemizer } = await import('./english');
  return new EnglishPhonemizer();
}
