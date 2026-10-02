/**
 * Japanese phonemizer for Kokoro.
 *
 * Pipeline:
 * 1. Normalize punctuation (full-width → ASCII, comma → period for pausing)
 * 2. Segment into Kana/Latin/Other runs
 * 3. Process each run:
 *    - Kana → Kanji conversion (kuroshiro) → IPA mapping
 *    - Latin → espeak spelled
 *    - Other → keep recognized punctuation
 * 4. Concatenate results
 *
 * Matches misaki's Japanese G2P for Kana→IPA mapping.
 * Reference: https://github.com/hexgrad/misaki/blob/main/misaki/ja.py
 */
import Kuroshiro from 'kuroshiro';
import KuromojiAnalyzer from '~/lib/vendor/kuroshiro-analyzer-kuromoji/index.js';
import {
  keepPunctuation,
  normalizePunctuation,
  phonemizeSpelled,
  segmentText,
} from './common';
import { numbersToKanji } from './japanese-numbers';
import type { Phonemizer } from './types';

/**
 * Katakana to IPA mapping table.
 * Extracted from hexgrad/misaki ja.py M2P dictionary.
 *
 * Key differences from kana2ipa:
 * - 'は' → 'ha' (not 'ɰa')
 * - 'を' → 'o'
 * - Palatalized consonants: 'キャ' → 'kja' (not 'kʲa')
 */
const KATAKANA_TO_IPA: Record<string, string> = {
  // Vowels
  ァ: 'a',
  ア: 'a',
  ィ: 'i',
  イ: 'i',
  ゥ: 'u',
  ウ: 'u',
  ェ: 'e',
  エ: 'e',
  ォ: 'o',
  オ: 'o',

  // K-series
  カ: 'ka',
  ガ: 'ga',
  キ: 'ki',
  ギ: 'gi',
  ク: 'ku',
  グ: 'gu',
  ケ: 'ke',
  ゲ: 'ge',
  コ: 'ko',
  ゴ: 'go',

  // S-series
  サ: 'sa',
  ザ: 'za',
  シ: 'ɕi',
  ジ: 'ʥi',
  ス: 'su',
  ズ: 'zu',
  セ: 'se',
  ゼ: 'ze',
  ソ: 'so',
  ゾ: 'zo',

  // T-series
  タ: 'ta',
  ダ: 'da',
  チ: 'ʨi',
  ヂ: 'ʥi',
  ツ: 'ʦu',
  ヅ: 'zu',
  テ: 'te',
  デ: 'de',
  ト: 'to',
  ド: 'do',

  // N-series
  ナ: 'na',
  ニ: 'ni',
  ヌ: 'nu',
  ネ: 'ne',
  ノ: 'no',
  ン: 'ɴ',

  // H-series
  ハ: 'ha',
  バ: 'ba',
  パ: 'pa',
  ヒ: 'hi',
  ビ: 'bi',
  ピ: 'pi',
  フ: 'fu',
  ブ: 'bu',
  プ: 'pu',
  ヘ: 'he',
  ベ: 'be',
  ペ: 'pe',
  ホ: 'ho',
  ボ: 'bo',
  ポ: 'po',

  // M-series
  マ: 'ma',
  ミ: 'mi',
  ム: 'mu',
  メ: 'me',
  モ: 'mo',

  // Y-series
  ャ: 'ja',
  ヤ: 'ja',
  ュ: 'ju',
  ユ: 'ju',
  ョ: 'jo',
  ヨ: 'jo',

  // R-series
  ラ: 'ra',
  リ: 'ri',
  ル: 'ru',
  レ: 're',
  ロ: 'ro',

  // W-series
  ヮ: 'wa',
  ワ: 'wa',
  ヰ: 'i',
  ヱ: 'e',
  ヲ: 'o',

  // V-series
  ヴ: 'vu',
  ヵ: 'ka',
  ヶ: 'ke',
  ヷ: 'va',
  ヸ: 'vi',
  ヹ: 've',
  ヺ: 'vo',
};

/**
 * Hiragana to Katakana conversion map.
 * Used for normalizing input before IPA conversion.
 */
const HIRAGANA_TO_KATAKANA: Record<string, string> = {
  ぁ: 'ァ',
  あ: 'ア',
  ぃ: 'ィ',
  い: 'イ',
  ぅ: 'ゥ',
  う: 'ウ',
  ぇ: 'ェ',
  え: 'エ',
  ぉ: 'ォ',
  お: 'オ',

  か: 'カ',
  が: 'ガ',
  き: 'キ',
  ぎ: 'ギ',
  く: 'ク',
  ぐ: 'グ',
  け: 'ケ',
  げ: 'ゲ',
  こ: 'コ',
  ご: 'ゴ',

  さ: 'サ',
  ざ: 'ザ',
  し: 'シ',
  じ: 'ジ',
  す: 'ス',
  ず: 'ズ',
  せ: 'セ',
  ぜ: 'ゼ',
  そ: 'ソ',
  ぞ: 'ゾ',

  た: 'タ',
  だ: 'ダ',
  ち: 'チ',
  ぢ: 'ヂ',
  っ: 'ッ',
  つ: 'ツ',
  づ: 'ヅ',
  て: 'テ',
  で: 'デ',
  と: 'ト',
  ど: 'ド',

  な: 'ナ',
  に: 'ニ',
  ぬ: 'ヌ',
  ね: 'ネ',
  の: 'ノ',
  ん: 'ン',

  は: 'ハ',
  ば: 'バ',
  ぱ: 'パ',
  ひ: 'ヒ',
  び: 'ビ',
  ぴ: 'ピ',
  ふ: 'フ',
  ぶ: 'ブ',
  ぷ: 'プ',
  へ: 'ヘ',
  べ: 'ベ',
  ぺ: 'ペ',
  ほ: 'ホ',
  ぼ: 'ボ',
  ぽ: 'ポ',

  ま: 'マ',
  み: 'ミ',
  む: 'ム',
  め: 'メ',
  も: 'モ',

  ゃ: 'ャ',
  や: 'ヤ',
  ゅ: 'ュ',
  ゆ: 'ユ',
  ょ: 'ョ',
  よ: 'ヨ',

  ら: 'ラ',
  り: 'リ',
  る: 'ル',
  れ: 'レ',
  ろ: 'ロ',

  ゎ: 'ヮ',
  わ: 'ワ',
  ゐ: 'ヰ',
  ゑ: 'ヱ',
  を: 'ヲ',

  ゔ: 'ヴ',
  ゕ: 'ヵ',
  ゖ: 'ヶ',
};

/**
 * Convert Hiragana to Katakana.
 */
function hiraganaToKatakana(text: string): string {
  return Array.from(text)
    .map((char) => HIRAGANA_TO_KATAKANA[char] || char)
    .join('');
}

/**
 * Convert Kana (Hiragana or Katakana) to IPA using misaki's M2P mapping.
 *
 * This matches the phoneme format Kokoro was trained on.
 *
 * @param kana - Kana text (can be mixed Hiragana/Katakana)
 * @returns IPA phoneme string
 */
export function kanaToIPA(kana: string): string {
  // Normalize: convert all Hiragana to Katakana
  const katakana = hiraganaToKatakana(kana);

  let ipa = '';
  let i = 0;

  while (i < katakana.length) {
    const char = katakana[i];

    // Try two-character combinations first (e.g., 'キャ' → 'kja')
    if (i + 1 < katakana.length) {
      const nextChar = katakana[i + 1];
      if (nextChar) {
        const twoChar = char + nextChar;
        if (KATAKANA_TO_IPA[twoChar]) {
          ipa += KATAKANA_TO_IPA[twoChar];
          i += 2;
          continue;
        }
      }
    }

    // Single character
    if (char && KATAKANA_TO_IPA[char]) {
      ipa += KATAKANA_TO_IPA[char];
    } else if (char === 'ッ') {
      // Geminate consonant (sokuon) - handled by doubling next consonant
      // For now, just skip it (proper handling needs context)
      // TODO: implement gemination
    } else if (char === 'ー') {
      // Long vowel marker - handled by context
      // For now, just skip it
      // TODO: implement vowel lengthening
    } else if (char) {
      // Unknown character - keep as-is
      ipa += char;
    }

    i++;
  }

  return ipa;
}


/**
 * Where the compiled kuromoji dictionary lives.
 *
 * A path inside the extension rather than a URL: the loader turns it into one,
 * and which way it does that depends on where this code is running (see
 * `lib/vendor/kuromoji/loader/BrowserDictionaryLoader.js`). The files come from
 * `public/kuromoji-dict/`, populated by `scripts/setup-kuromoji-dict.mjs`.
 */
const KUROMOJI_DICT_PATH = '/kuromoji-dict/';

let kuroshiroInstance: Kuroshiro | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Initialize kuroshiro (lazy, called on first use).
 * Works in both worker and main thread contexts.
 */
async function initKuroshiro(): Promise<void> {
  if (kuroshiroInstance) return;

  if (!initPromise) {
    initPromise = (async () => {
      try {
        kuroshiroInstance = new Kuroshiro();
        await kuroshiroInstance.init(new KuromojiAnalyzer({ dictPath: KUROMOJI_DICT_PATH }));
      } catch (error) {
        // Left un-cached on purpose: the dictionary is a fetch, so a failure can
        // be a transient one (a recycled worker, a download still in flight)
        // and the next call deserves its own attempt rather than inheriting
        // this one's failure forever.
        console.error('[SayLoud] kuroshiro failed to initialize', error);
        kuroshiroInstance = null;
        initPromise = null;
        throw error;
      }
    })();
  }

  await initPromise;
}

/**
 * The numeral sound changes kuromoji does not make.
 *
 * It reads the characters one at a time, so 「三百」 comes back サンヒャク where
 * the language says サンビャク. Five cases, and each is unambiguous in practice:
 * ヒャク and セン only follow サン, ロク or ハチ inside a numeral, so there is no
 * other word these patterns could belong to.
 */
const NUMERAL_SOUND_CHANGES: readonly (readonly [RegExp, string])[] = [
  [/サンヒャク/g, 'サンビャク'],
  [/ロクヒャク/g, 'ロッピャク'],
  [/ハチヒャク/g, 'ハッピャク'],
  [/サンセン/g, 'サンゼン'],
  [/ハチセン/g, 'ハッセン'],
];

function fixNumeralSoundChanges(katakana: string): string {
  let out = katakana;
  for (const [pattern, replacement] of NUMERAL_SOUND_CHANGES) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Convert Japanese text (with Kanji) to Katakana.
 * Works in both worker and main thread contexts.
 *
 * Digits are read here as well as in `phonemizeJapanese`, and the duplication is
 * on purpose: this function's contract is "the reading of this text", so a
 * caller that passes it `2022年` should get ニセンニジュウニネン and not
 * `2022ネン`. It costs nothing on the path that already converted them — the
 * patterns no longer match.
 */
export async function textToKatakana(text: string): Promise<string> {
  await initKuroshiro();

  if (!kuroshiroInstance) {
    throw new Error('Kuroshiro failed to initialize');
  }

  const katakana = await kuroshiroInstance.convert(numbersToKanji(text), {
    to: 'katakana',
    mode: 'normal',
  });

  return fixNumeralSoundChanges(katakana);
}

/**
 * Phonemize Japanese text for Kokoro.
 *
 * Full pipeline:
 * 1. Normalize punctuation (full-width → ASCII, comma → period)
 * 2. Read the digits out as kanji, before segmentation can drop them
 * 3. Segment into Kana/Han/Latin/Other runs
 * 4. Kana and Han → katakana (kuroshiro + the numeral sound changes) → IPA
 * 5. Latin → espeak spelled
 * 6. Other → keep recognized punctuation
 *
 * @param text - Japanese text (may contain Kanji, Kana, Latin, or mixed)
 * @returns IPA phoneme string
 */
export async function phonemizeJapanese(text: string): Promise<string> {
  // Step 1: Normalize punctuation
  const normalized = normalizePunctuation(text, 'ja-JP');

  // Step 2: Turn digits into kanji *before* segmenting. A numeral belongs to no
  // script this segmenter knows, so it would land in the `other` run and be
  // filtered out as punctuation — unheard, and silently. Doing it here rather
  // than per-run also keeps the numeral in the same Han run as what it counts,
  // which is what decides how that reads (「年」 alone is とし, 「二十二年」 ネン).
  const runs = segmentText(numbersToKanji(normalized));

  // Step 3-5: Process each run
  const parts: string[] = [];

  for (const run of runs) {
    if (run.kind === 'kana' || run.kind === 'han') {
      // Convert to Katakana (handles both Hiragana and Kanji)
      const katakana = await textToKatakana(run.text);
      const ipa = kanaToIPA(katakana);
      if (ipa !== '') parts.push(ipa);
    } else if (run.kind === 'latin') {
      const ipa = await phonemizeSpelled(run.text);
      if (ipa !== '') parts.push(ipa);
    } else {
      // Other: keep only recognized punctuation
      const kept = keepPunctuation(run.text);
      if (kept !== '') parts.push(kept);
    }
  }

  // Concatenate without adding separators between runs
  return parts.join('').replace(/\s+/g, ' ').trim();
}

/**
 * Japanese phonemizer implementing the Phonemizer interface.
 */
export class JapanesePhonemizer implements Phonemizer {
  /**
   * Phonemize Japanese text to IPA.
   *
   * @param text - Japanese text (may contain Kanji, Kana, or mixed)
   * @param lang - Language code (ignored, assumed to be Japanese)
   * @returns IPA phoneme string
   */
  async phonemize(text: string, _lang: string): Promise<string> {
    return phonemizeJapanese(text);
  }
}
