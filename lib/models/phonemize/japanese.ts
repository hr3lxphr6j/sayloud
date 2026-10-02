/**
 * Japanese phonemizer for Kokoro (spec: TBD).
 *
 * Matches misaki's Japanese G2P implementation:
 * - Kanji → Kana: kuroshiro (via kuromoji) - runs in main thread
 * - Kana → IPA: M2P mapping table (extracted from hexgrad/misaki)
 *
 * Reference: https://github.com/hexgrad/misaki/blob/main/misaki/ja.py
 */
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
 * Convert Kanji/mixed text to Katakana using kuroshiro.
 *
 * @param text - Japanese text (may contain Kanji)
 * @returns Katakana text
 */
import Kuroshiro from 'kuroshiro';
import KuromojiAnalyzer from '~/lib/vendor/kuroshiro-analyzer-kuromoji/index.js';

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

        await kuroshiroInstance.init(
          new KuromojiAnalyzer({
            dictPath: '/kuromoji-dict/',
          })
        );
      } catch (error) {
        console.error('[JapanesePhonemizer] Failed to initialize kuroshiro:', error);
        kuroshiroInstance = null;
        throw error;
      }
    })();
  }

  await initPromise;
}

/**
 * Convert Japanese text (with Kanji) to Katakana.
 * Works in both worker and main thread contexts.
 */
export async function textToKatakana(text: string): Promise<string> {
  await initKuroshiro();

  if (!kuroshiroInstance) {
    throw new Error('Kuroshiro failed to initialize');
  }

  return await kuroshiroInstance.convert(text, {
    to: 'katakana',
    mode: 'normal',
  });
}

/**
 * Phonemize Japanese text for Kokoro.
 *
 * Full pipeline:
 * 1. Kanji → Katakana (kuroshiro)
 * 2. Katakana → IPA (kana-to-IPA mapping)
 *
 * @param text - Japanese text (may contain Kanji, Kana, or mixed)
 * @returns IPA phoneme string
 */
export async function phonemizeJapanese(text: string): Promise<string> {
  const katakana = await textToKatakana(text);
  return kanaToIPA(katakana);
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
