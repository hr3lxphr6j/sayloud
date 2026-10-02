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
 *                -> jieba words -> one IPA string per word
 *          Latin -> espeak, spelled letter by letter
 *          other -> the punctuation Kokoro's tokenizer actually has
 *     -> the runs concatenated, with no separator inserted between them
 *
 * Three details are load-bearing and easy to get wrong:
 *
 * - **Tones are arrows, not digits.** Kokoro's tokenizer has `↓→↗↘` in its
 *   vocabulary and no digits at all. That is why the syllable table stores the
 *   IPA with a `0` placeholder and the tone is substituted in as a tone letter
 *   before `retone` folds it into an arrow.
 * - **`pinyin-pro` numbers the neutral tone `0`, and the table uses `5`.** Map
 *   it, or every neutral-tone syllable silently loses its tone.
 * - **Word boundaries come from jieba, with `hmm` on.** misaki writes one space
 *   between words; this file used to write one between every syllable, so the
 *   model saw three to five times the word-boundary density it was trained on
 *   and paused inside words (人设, 曾经). That is what the jieba dependency is
 *   for — see the P5 spec §3.2.
 *
 * The IPA is not a phonetic transcription of a word in context — it is one
 * syllable at a time out of a table, which is exactly what misaki, the G2P
 * Kokoro was trained against, does.
 */
import { pinyin } from 'pinyin-pro';
import { numbersToHan } from './numbers';
import table from './pinyin-table.json';

/**
 * The length in characters of each word in a Han run.
 *
 * A function rather than a list so the caller decides where the words are —
 * jieba in production, a stub in tests. Kept separate from the syllable
 * lookup because the two answers come from different places: the readings are
 * pinyin-pro's, the boundaries are jieba's.
 */
export type WordBoundaries = (text: string) => number[];

/** One word per syllable — the spacing this file used to produce. For tests. */
export const singleSyllableWords: WordBoundaries = (text) => [...text].map(() => 1);

/**
 * jieba's wasm module, once `ensureJieba` has resolved.
 *
 * Held separately from the promise because `jiebaBoundaries` is synchronous:
 * `hanToIpa` is a pure function today and making it async would spread through
 * every caller and test. The async initialisation is confined to one place —
 * `ChinesePhonemizer.phonemize`, which is already async.
 */
let jieba: { cut: (text: string, hmm?: boolean | null) => string[] } | null = null;
let jiebaInit: Promise<void> | null = null;

/**
 * Load and initialise jieba. Idempotent; safe to await on every call.
 *
 * Getting this wrong is silent in Node and fatal in the browser, which is worth
 * stating: the Node build initialises itself, so a Node-only test passes while
 * the extension throws. The harness hit exactly that (P5 spec §5 V23).
 */
export function ensureJieba(): Promise<void> {
  jiebaInit ??= (async () => {
    const module = await import('jieba-wasm');

    // The two builds of `jieba-wasm` differ in their init API, and which one you
    // get depends on the bundler's resolve conditions: the browser build exports
    // an async `init` that must be awaited before `cut` works (its `cut` closes
    // over a module-level `wasm` binding), while the Node build self-initialises
    // and has no default export at all. Both have to work — the extension runs
    // the browser one, the unit tests the Node one — so the call is conditional
    // rather than assumed.
    if (typeof module.default === 'function') await module.default();

    jieba = module;
  })();
  return jiebaInit;
}

/**
 * Word lengths from jieba — the segmenter misaki uses, so the boundaries match
 * the training target instead of approximating it.
 *
 * `hmm: true` is load-bearing. jieba-wasm ships jieba-rs's dictionary, which is
 * not Python jieba's `dict.txt`, and the difference hides behind that flag:
 * with it off, 还书 comes out as 还|书. Python's `jieba.lcut`, which the
 * training pipeline calls, has HMM on by default. Measured on 24 sentences,
 * `cut(text, true)` and `jieba.lcut(text)` agree on all 24; with `hmm: false`
 * they diverge on the first one.
 */
export const jiebaBoundaries: WordBoundaries = (text) => {
  if (jieba === null) {
    throw new Error('jieba is not initialised — await ensureJieba() before phonemizing');
  }

  const lengths = jieba.cut(text, true).map((word) => [...word].length);
  const total = lengths.reduce((sum, length) => sum + length, 0);

  // A mismatch means the segmenter dropped or invented characters, which would
  // shift every subsequent syllable onto the wrong word. Loud, like the
  // syllable-count check below.
  if (total !== [...text].length) {
    throw new Error(
      `jieba covered ${total}/${[...text].length} characters of ${JSON.stringify(text)}`
    );
  }

  return lengths;
};

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
  return (
    text
      .replaceAll('、', ', ')
      // A comma becomes a **period**, not a comma.
      //
      // Chosen by listening, not by analysis. Measured with the low-energy-gap
      // metric the two are nearly the same (the comma gives 290 ms of total
      // silence in a test sentence, the period 270 ms, and the period's longest
      // single gap is longer at 180 ms against 170 ms), so the metric could not
      // have decided it — and it has already failed once to match what the user
      // hears. The user listened to a page of seven punctuation treatments and
      // picked this one.
      //
      // 顿号 is left as a comma: it is a shorter mark than 逗号, the page never
      // tested it, and turning every separator into a full stop is a larger
      // change than the one that was chosen.
      .replaceAll('，', '. ')
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
      .trim()
  );
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

  // misaki deletes U+032F in Python (`replace(chr(815), '')`), and the tokenizer
  // would drop it anyway — its normalizer keeps neither combining mark. Doing it
  // here keeps the IPA identical to the training target's rather than merely
  // equivalent after tokenisation.
  return retone(template.replaceAll('0', TONE_MAPPING[tone])).replaceAll('\u032F', '');
}

/**
 * Group IPA syllables into words: nothing inside a word, one space between.
 *
 * This is misaki's spacing. The model was trained on it, and feeding it one
 * space per syllable instead made it pause inside words.
 */
export function joinByWords(
  ipa: readonly string[],
  lengths: readonly number[],
  context: string
): string {
  const words: string[] = [];
  let at = 0;
  for (const length of lengths) {
    words.push(ipa.slice(at, at + length).join(''));
    at += length;
  }

  // The boundaries and the syllables come from different sources — jieba and
  // pinyin-pro — so they can disagree. Slicing on a wrong boundary would move a
  // syllable into the neighbouring word, which is audible and silent.
  if (at !== ipa.length) {
    throw new Error(
      `word boundaries cover ${at} of ${ipa.length} syllables in ${JSON.stringify(context)}`
    );
  }

  return words.join(' ');
}

/**
 * The IPA of a run of Han characters, one syllable per character.
 *
 * Syllables are grouped into words and joined without a separator inside a
 * word, one space between words (see `joinByWords`).
 */
export function hanToIpa(
  han: string,
  context: string = han,
  boundaries: WordBoundaries = jiebaBoundaries
): string {
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

  return joinByWords(
    syllables.map((syllable) => syllableToIpa(syllable, context)),
    boundaries(han),
    context
  );
}

/**
 * The punctuation worth keeping, with runs of whitespace collapsed.
 *
 * Deliberately **not** trimmed. The runs are concatenated with no separator
 * inserted between them (see `phonemize`), so a space that `mapPunctuation` put
 * after a comma is the only thing separating it from the next word — trimming
 * it would glue the two together. The final collapse in `phonemize` handles the
 * ends of the sentence.
 */
function keepPunctuation(text: string): string {
  return [...text]
    .filter((character) => /\s/.test(character) || KEPT_PUNCTUATION.has(character))
    .join('')
    .replace(/\s+/g, ' ');
}

/** Phonemize a Latin run. Injectable so tests never load espeak's wasm. */
export type LatinPhonemizer = (text: string) => Promise<string>;

/**
 * The default Latin front end, imported on first use.
 *
 * Two things are decided here, and both are about which of espeak's behaviours
 * the run wants. An initialism is spelled letter by letter (`LLM` → the letters
 * L-L-M); anything else is handed over as a word (`Agent` → `ˈeɪdʒənt`). The
 * split is `isInitialism`'s, and its comment records the measurement.
 *
 * A static import would put 1.3 MB of inlined espeak wasm into the module graph
 * of every test that touches Chinese phonemization, including the ones that
 * never see a Latin character.
 */
async function defaultLatinPhonemizer(text: string): Promise<string> {
  const { isInitialism, phonemizeEnglish, phonemizeSpelled } = await import('./english');
  return isInitialism(text) ? phonemizeSpelled(text) : phonemizeEnglish(text);
}

export class ChinesePhonemizer {
  private readonly latin: LatinPhonemizer;
  private readonly boundaries: WordBoundaries;
  /** Only the default boundaries need the wasm module loaded. */
  private readonly needsJieba: boolean;

  constructor(latin: LatinPhonemizer = defaultLatinPhonemizer, boundaries?: WordBoundaries) {
    this.latin = latin;
    this.boundaries = boundaries ?? jiebaBoundaries;
    this.needsJieba = boundaries === undefined;
  }

  /**
   * Text to IPA. Mixed text produces one IPA string, because Kokoro's
   * tokenizer is shared: Chinese and English phonemes are drawn from the same
   * vocabulary, so there is no need to split the sentence into two requests
   * (spec §3.11.7).
   */
  async phonemize(text: string, _lang: string): Promise<string> {
    const mapped = mapPunctuation(numbersToHan(text));
    const runs = splitRuns(mapped);

    // Only pay for the 3.8 MB wasm when there is actually Han text, and only
    // once — `ensureJieba` memoises.
    if (this.needsJieba && runs.some((run) => run.kind === 'han')) await ensureJieba();

    const parts: string[] = [];

    for (const run of runs) {
      if (run.kind === 'han') {
        const ipa = hanToIpa(run.text, text, this.boundaries);
        if (ipa !== '') parts.push(ipa);
      } else if (run.kind === 'latin') {
        const ipa = await this.latin(run.text);
        if (ipa !== '') parts.push(ipa);
      } else {
        const kept = keepPunctuation(run.text);
        if (kept !== '') parts.push(kept);
      }
    }

    // Concatenated, not joined with a separator. misaki appends each non-Han
    // segment verbatim, so its punctuation sits flush against the phoneme
    // before it and the space comes *after* the mark (`mapPunctuation` emits
    // `", "`, not `" ,"`). `parts.join(' ')` put a space in front of every
    // mark, which is the deviation the P5 spec calls B.
    return parts.join('').replace(/\s+/g, ' ').trim();
  }
}
