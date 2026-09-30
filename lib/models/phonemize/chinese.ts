/**
 * The Chinese half of the phonemizer (spec §3.11).
 *
 * `kokoro-js` cannot do this. Its `generate()` validates the voice against a
 * 28-voice English-only list and then calls espeak-ng with an English language
 * — and the `phonemizer` package's wasm build ships English voices only, so
 * even asking it for `cmn` throws (verification doc §1.1.1). Chinese therefore
 * takes a different route entirely:
 *
 *   text
 *     -> numerals to Chinese words        (`numbers.ts`)
 *     -> full-width punctuation to ASCII  (misaki's `map_punctuation`)
 *     -> split into Han / Latin / other runs
 *          Han   -> pinyin-pro -> syllable table -> tone marks -> arrows
 *          Latin -> espeak, spelled letter by letter
 *          other -> the punctuation Kokoro's tokenizer actually has
 *     -> one concatenated IPA string
 *
 * Two details are load-bearing and easy to get wrong:
 *
 * - **Tones are arrows, not digits.** Kokoro's tokenizer has `↓→↗↘` in its
 *   vocabulary and no digits at all. That is why the syllable table stores the
 *   IPA with a `0` placeholder and the tone is substituted in as a tone letter
 *   before `retone` folds it into an arrow.
 * - **`pinyin-pro` numbers the neutral tone `0`, and the table uses `5`.** Map
 *   it, or every neutral-tone syllable silently loses its tone.
 *
 * The IPA is not a phonetic transcription of a word in context — it is one
 * syllable at a time out of a table, which is exactly what misaki, the G2P
 * Kokoro was trained against, does.
 */
import { pinyin } from 'pinyin-pro';
import { numbersToHan } from './numbers';
import table from './pinyin-table.json';

/**
 * The tone letters the table's `0` placeholder is replaced with.
 *
 * `5` is the neutral tone, which contributes nothing — it is in the table so
 * that "no tone" is a value rather than a missing key.
 */
export const TONE_MAPPING: Readonly<Record<number, string>> = {
  1: '˥',
  2: '˧˥',
  3: '˧˩˧',
  4: '˥˩',
  5: '',
};

/**
 * Fold a tone letter into the arrow Kokoro's tokenizer knows.
 *
 * The order is forced: `˥` is a prefix of `˥˩`, so replacing it before `˥˩`
 * would turn every fourth tone into a first tone.
 */
export function retone(ipa: string): string {
  return ipa
    .replaceAll('˧˩˧', '↓')
    .replaceAll('˧˥', '↗')
    .replaceAll('˥˩', '↘')
    .replaceAll('˥', '→');
}

/**
 * misaki's `map_punctuation`, verbatim in effect.
 *
 * Kokoro's tokenizer has no full-width Chinese punctuation — `，。！？、：；（）`
 * are all absent from its vocabulary, while `“ ”` are present — so punctuation
 * that is not translated is dropped, and with it every pause. A long sentence
 * then reads as one rushed breath (spec §3.11.7).
 */
export function mapPunctuation(text: string): string {
  return text
    .replaceAll('、', ', ')
    .replaceAll('，', ', ')
    .replaceAll('。', '. ')
    .replaceAll('．', '. ')
    .replaceAll('！', '! ')
    .replaceAll('：', ': ')
    .replaceAll('；', '; ')
    .replaceAll('？', '? ')
    .replaceAll('«', ' “')
    .replaceAll('»', '” ')
    .replaceAll('《', ' “')
    .replaceAll('》', '” ')
    .replaceAll('「', ' “')
    .replaceAll('」', '” ')
    .replaceAll('【', ' “')
    .replaceAll('】', '” ')
    .replaceAll('（', ' (')
    .replaceAll('）', ') ')
    .trim();
}

/**
 * The punctuation Kokoro's tokenizer actually has.
 *
 * Measured against `tokenizer.json`'s vocabulary during verification: of every
 * ASCII mark that could survive `mapPunctuation`, exactly these are in it.
 * Everything else — including `-`, `/`, `%` and `'` — is not, and is dropped
 * rather than turned into a token the tokenizer would discard anyway.
 */
const KEPT_PUNCTUATION = new Set('$;:,.!?—…"()“”'.split(''));

/**
 * Characters that make up a Han run.
 *
 * Includes the CJK extensions and the compatibility ideographs, plus `〇`,
 * which pinyin-pro reads as `ling2`. Astral-plane extensions are deliberately
 * not listed: a regex range for them needs the `u` flag, and pinyin-pro does
 * not know those characters either — they would be dropped silently either
 * way, and a run boundary is the wrong place to discover it.
 */
const HAN = '\\u3007\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff';

/**
 * Han run, Latin run, or everything else.
 *
 * Built fresh on every call rather than shared: the pattern is used with
 * `exec` inside a loop that awaits, and a module-level `g` regex carries a
 * `lastIndex` that a second concurrent sentence would clobber.
 */
function runPattern(): RegExp {
  return new RegExp(`([${HAN}]+)|([A-Za-z]+)|([^${HAN}A-Za-z]+)`, 'g');
}

/** The kind of text a run holds. */
export type RunKind = 'han' | 'latin' | 'other';

export interface Run {
  readonly kind: RunKind;
  readonly text: string;
}

/** Split text into the three run kinds, in order. */
export function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  for (const match of text.matchAll(runPattern())) {
    const [full, han, latin] = match;
    if (full === undefined || full === '') continue;
    const kind: RunKind = han !== undefined ? 'han' : latin !== undefined ? 'latin' : 'other';
    runs.push({ kind, text: full });
  }
  return runs;
}

/**
 * Raised when a Han character has no entry in the syllable table.
 *
 * Loud on purpose. The alternative — returning the empty string, as the
 * verification script did — drops the character from the audio without a trace,
 * which sounds like a working sentence that happens to be missing a word.
 */
export class UnknownSyllableError extends Error {
  constructor(
    readonly syllable: string,
    readonly text: string
  ) {
    super(`no IPA for the syllable ${JSON.stringify(syllable)} in ${JSON.stringify(text)}`);
    this.name = 'UnknownSyllableError';
  }
}

/**
 * The syllable's IPA, with its tone as an arrow.
 *
 * The table spells `ü` as `v` (`nv`, `lve`) because it is generated from
 * pypinyin, whose toneless form does; pinyin-pro spells it `ü`. Translating
 * `ü` -> `v` is therefore required, not cosmetic: without it every syllable
 * with an `ü` after `n` or `l` misses the table, and the characters that need
 * one — 女, 绿, 略, 虐 — are dropped from the audio without an error.
 */
function syllableToIpa(syllable: string, context: string): string {
  const reported = Number(syllable.slice(-1));
  // pinyin-pro numbers the neutral tone `0`; the table and TONE_MAPPING use
  // `5`. Without this the neutral tone falls through the check below and the
  // whole sentence is rejected — and the `0` placeholder would survive into
  // the IPA, where the tokenizer has no digits at all.
  const tone = reported === 0 ? 5 : reported;
  const key = syllable.slice(0, -1).replaceAll('ü', 'v');
  const template = (table as Record<string, string>)[key];

  if (template === undefined) throw new UnknownSyllableError(key, context);
  if (TONE_MAPPING[tone] === undefined) throw new UnknownSyllableError(syllable, context);

  return retone(template.replaceAll('0', TONE_MAPPING[tone]));
}

/** The IPA of a run of Han characters, one syllable per character. */
export function hanToIpa(han: string, context: string = han): string {
  const syllables = pinyin(han, { toneType: 'num', type: 'array', nonZh: 'removed' });

  // pinyin-pro drops a character it does not know instead of failing, so a
  // shorter result means the run lost characters rather than gained words.
  // Without this check the loss is invisible: the rest of the sentence is
  // phonemized and spoken as if nothing were missing.
  const characters = [...han];
  if (syllables.length !== characters.length) {
    throw new UnknownSyllableError(
      `characters pinyin-pro could not read (${syllables.length}/${characters.length} returned)`,
      context
    );
  }

  return syllables.map((syllable) => syllableToIpa(syllable, context)).join(' ');
}

/** The punctuation worth keeping, with runs of whitespace collapsed. */
function keepPunctuation(text: string): string {
  return [...text]
    .filter((character) => /\s/.test(character) || KEPT_PUNCTUATION.has(character))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Phonemize a Latin run. Injectable so tests never load espeak's wasm. */
export type LatinPhonemizer = (text: string) => Promise<string>;

/**
 * The default Latin front end, imported on first use.
 *
 * A static import would put 1.3 MB of inlined espeak wasm into the module graph
 * of every test that touches Chinese phonemization, including the ones that
 * never see a Latin character.
 */
async function defaultLatinPhonemizer(text: string): Promise<string> {
  const { phonemizeSpelled } = await import('./english');
  return phonemizeSpelled(text);
}

export class ChinesePhonemizer {
  constructor(private readonly latin: LatinPhonemizer = defaultLatinPhonemizer) {}

  /**
   * Text to IPA. Mixed text produces one IPA string, because Kokoro's
   * tokenizer is shared: Chinese and English phonemes are drawn from the same
   * vocabulary, so there is no need to split the sentence into two requests
   * (spec §3.11.7).
   */
  async phonemize(text: string, _lang: string): Promise<string> {
    const mapped = mapPunctuation(numbersToHan(text));
    const parts: string[] = [];

    for (const run of splitRuns(mapped)) {
      if (run.kind === 'han') {
        const ipa = hanToIpa(run.text, text);
        if (ipa !== '') parts.push(ipa);
      } else if (run.kind === 'latin') {
        const ipa = await this.latin(run.text);
        if (ipa !== '') parts.push(ipa);
      } else {
        const kept = keepPunctuation(run.text);
        if (kept !== '') parts.push(kept);
      }
    }

    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }
}
