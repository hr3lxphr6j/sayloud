/**
 * The English half of the phonemizer (spec §3.11.1).
 *
 * English is the easy case: `kokoro-js`'s own `generate()` already runs this
 * exact front end internally, so a pure-English sentence never comes through
 * here. This module exists for the *mixed* case — a Latin run inside Chinese
 * text, which the Chinese pipeline has to phonemize itself before it hands one
 * combined IPA string to `generate_from_ids()`.
 *
 * The `phonemizer` package is espeak-ng compiled to wasm, and the build it
 * ships carries English voices only (verification doc §1.1.1). That is not a
 * limitation to work around: P4's only non-English language is Chinese, and
 * Chinese does not go through espeak at all.
 */
import { phonemize } from 'phonemizer';
import type { Phonemizer } from './types';

/**
 * The espeak-ng identifier for a BCP-47 tag.
 *
 * Only the English voices P4 ships map to anything; anything else falls back to
 * `en-us` rather than being passed through, because espeak rejects an unknown
 * identifier by throwing, and a thrown phonemizer error costs the user the
 * whole sentence.
 */
export function espeakLanguage(lang: string): string {
  return lang.toLowerCase().startsWith('en-gb') ? 'en-gb' : 'en-us';
}

/** One espeak pass over `text`, as a single IPA string. */
async function phonemizeWith(text: string, language: string): Promise<string> {
  // `phonemize` splits its input into sentences and returns one string per
  // sentence. Callers here always hand it one sentence's worth of text, so
  // joining with a space restores the single string the seam promises.
  const parts = await phonemize(text, language);
  return parts.join(' ').replace(/\s+/g, ' ').trim();
}

export class EnglishPhonemizer implements Phonemizer {
  async phonemize(text: string, lang: string): Promise<string> {
    return phonemizeWith(text, espeakLanguage(lang));
  }
}

/**
 * Phonemize a Latin run inside non-Latin text, one letter at a time.
 *
 * `API` must come out as `ɐ pˈiː ˈaɪ` — the letters A-P-I, not the word "api"
 * (spec §3.11.7). Spacing the letters is what makes espeak read them
 * individually; it is a property of the input, not a phonemizer option.
 */
export async function phonemizeSpelled(text: string): Promise<string> {
  return phonemizeWith([...text].join(' '), 'en-us');
}
