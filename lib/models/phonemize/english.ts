/**
 * The English half of the phonemizer (spec §3.11.1).
 *
 * English is the easy case: `kokoro-js`'s own `generate()` already runs this
 * exact front end internally, so a pure-English sentence never comes through
 * here. This module exists for the *mixed* case — a Latin run inside Chinese
 * text, which the Chinese pipeline has to phonemize itself before it hands one
 * combined IPA string to `generate_from_ids()`.
 *
 * Mixed text needs one decision the pure-English path does not: **is this run an
 * initialism or a word?** `LLM` is spelled and `Agent` is not, and choosing
 * wrong is audible either way. `isInitialism` below makes that call, and its
 * comment records the measurement behind it.
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
 * Phonemize a Latin run as words.
 *
 * This is what the mixed-text path uses for anything that is not an initialism.
 * It replaces the old behaviour of spelling every Latin run letter by letter,
 * which turned `Agent` into the letters A-G-E-N-T.
 */
export async function phonemizeEnglish(text: string, lang = 'en-us'): Promise<string> {
  return phonemizeWith(text, espeakLanguage(lang));
}

/**
 * Whether a Latin run is an initialism, and so should be spelled out.
 *
 * The rule is capitals-versus-not, and it is measured rather than guessed.
 * Handing the whole run to espeak fixes the words — `Agent` → `ˈeɪdʒənt`,
 * `Kokoro` → `kəkˈoːɹoʊ`, `ChatGPT` → `tʃˈæt dʒˌiːpˌiːtˈiː`, `OpenAI` →
 * `ˈoʊpən ˌeɪˈaɪ`, `WiFi` → `wˈaɪ fˌaɪ`, `GitHub` → `ɡˈɪt hˈʌb` — and it also
 * reads `RAG` as the English word "rag" (`ɹˈæɡ`), which is a term in the user's
 * own text. That single counterexample is why this rule exists instead of
 * "hand everything to espeak".
 *
 * `LLM`, `QPS`, `API`, `GPT`, `GPU`, `USB` and `PDF` come out spelled under the
 * whole-word path too, but that is espeak guessing rather than a rule — RAG is
 * the proof — so capitals take the explicit letter-by-letter path.
 *
 * Known miss: `OK` is an initialism by this rule and comes out `ˈoʊ kˈeɪ`
 * instead of `ˌoʊkˈeɪ`. Fixing it needs a list of capitalised words that English
 * pronounces anyway, and one wrong word costs less than maintaining that list.
 */
export function isInitialism(text: string): boolean {
  return /^[A-Z]+$/.test(text);
}

/**
 * Phonemize a Latin run one letter at a time.
 *
 * `API` must come out as `ɐ pˈiː ˈaɪ` — the letters A-P-I, not the word "api"
 * (spec §3.11.7). Spacing the letters is what makes espeak read them
 * individually; it is a property of the input, not a phonemizer option.
 */
export async function phonemizeSpelled(text: string): Promise<string> {
  return phonemizeWith([...text].join(' '), 'en-us');
}
