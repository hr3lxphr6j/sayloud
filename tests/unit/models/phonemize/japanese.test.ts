/**
 * Tests for Japanese phonemizer (misaki-compatible).
 */
import { describe, expect, it } from 'vitest';
import {
  KATAKANA_TO_IPA,
  kanaToIPA,
  phonemizeJapanese,
  textToKatakana,
} from '@/lib/models/phonemize/japanese';

/**
 * Every character Kokoro's tokenizer accepts, copied from the model's own
 * `tokenizer.json` (115 tokens) so the check below needs no download.
 *
 * It matters because that tokenizer's normalizer is a `Replace` with an empty
 * string: a character outside this set is **deleted**, not approximated. A
 * table entry using one therefore loses part of a mora and reports nothing.
 */
const KOKORO_VOCABULARY = new Set([
  ...'$;:,.!?—…"()“” ̃ʣʥʦʨᵝꭧAIOQSTWYᵊabcdefghijklmnopqrstuvwxyzɑɐɒæβɔɕçɖðʤəɚɛɜɟɡɥɨɪʝɯɰŋɳɲɴøɸθœɹɾɻʁɽʂʃʈʧʊʋʌɣɤχʎʒʔˈˌːʰʲ↓→↗↘ᵻ',
]);

describe('the katakana table', () => {
  it('only spells with characters Kokoro has', () => {
    const offenders = Object.entries(KATAKANA_TO_IPA).flatMap(([kana, ipa]) =>
      [...ipa]
        .filter((char) => !KOKORO_VOCABULARY.has(char))
        .map(
          (char) =>
            `${kana} → ${ipa} (U+${char.codePointAt(0)?.toString(16)} is not in the vocabulary)`
        )
    );

    expect(offenders).toEqual([]);
  });
});

describe('Japanese phonemizer', () => {
  describe('kanaToIPA', () => {
    it('converts basic Hiragana', () => {
      expect(kanaToIPA('あいうえお')).toBe('aiueo');
    });

    it('converts basic Katakana', () => {
      expect(kanaToIPA('アイウエオ')).toBe('aiueo');
    });

    it('handles K-series', () => {
      expect(kanaToIPA('かきくけこ')).toBe('kakikukeko');
      expect(kanaToIPA('がぎぐげご')).toBe('ɡaɡiɡuɡeɡo');
    });

    it('writes the voiced velar with U+0261, not ASCII g', () => {
      // ɡ here is U+0261 LATIN SMALL LETTER SCRIPT G, and the distinction is
      // load-bearing rather than cosmetic: Kokoro's vocabulary contains U+0261
      // and *not* U+0067, and its normalizer deletes characters it does not
      // have. With an ASCII g, every ガ-row mora lost its consonant — が was
      // read as あ — and nothing failed, because a deleted character is not an
      // error. Asserted by code point, since the two glyphs are near-identical
      // in most fonts and a later "typo fix" would silently undo this.
      expect([...(kanaToIPA('が')[0] ?? '')][0]?.codePointAt(0)).toBe(0x261);
    });

    it('handles S-series with correct IPA', () => {
      expect(kanaToIPA('さしすせそ')).toBe('saɕisuseso');
      expect(kanaToIPA('ざじずぜぞ')).toBe('zaʥizuzezo');
    });

    it('handles T-series', () => {
      expect(kanaToIPA('たちつてと')).toBe('taʨiʦuteto');
      expect(kanaToIPA('だぢづでど')).toBe('daʥizudedo');
    });

    it('handles N-series', () => {
      expect(kanaToIPA('なにぬねの')).toBe('naninuneno');
      expect(kanaToIPA('ん')).toBe('ɴ');
    });

    it('handles H-series', () => {
      expect(kanaToIPA('はひふへほ')).toBe('hahifuheho');
      expect(kanaToIPA('ばびぶべぼ')).toBe('babibubebo');
      expect(kanaToIPA('ぱぴぷぺぽ')).toBe('papipupepo');
    });

    it('handles M-series', () => {
      expect(kanaToIPA('まみむめも')).toBe('mamimumemo');
    });

    it('handles Y-series', () => {
      expect(kanaToIPA('やゆよ')).toBe('jajujo');
    });

    it('handles R-series', () => {
      expect(kanaToIPA('らりるれろ')).toBe('rarirurero');
    });

    it('handles W-series', () => {
      expect(kanaToIPA('わをん')).toBe('waoɴ');
    });

    it('converts common words correctly', () => {
      // こんにちは (konnichiwa)
      expect(kanaToIPA('こんにちは')).toBe('koɴniʨiha');

      // ありがとう (arigatou)
      expect(kanaToIPA('ありがとう')).toBe('ariɡatou');

      // さようなら (sayounara)
      expect(kanaToIPA('さようなら')).toBe('sajounara');
    });

    it('handles mixed Hiragana and Katakana', () => {
      expect(kanaToIPA('ひらがなとカタカナ')).toBe('hiraɡanatokatakana');
    });

    it('preserves punctuation and spaces', () => {
      expect(kanaToIPA('こんにちは、せかい')).toBe('koɴniʨiha、sekai');
      expect(kanaToIPA('あ い う')).toBe('a i u');
    });

    it('handles particle は as "ha" not "wa"', () => {
      // Note: grammatical particle detection requires context
      // For now, は is always converted to "ha"
      expect(kanaToIPA('わたしは')).toBe('wataɕiha');
    });
  });

  describe('phonemizeJapanese', () => {
    it('phonemizes Kana text', async () => {
      const result = await phonemizeJapanese('こんにちは');
      expect(result).toBe('koɴniʨiha');
    });

    it('phonemizes Kanji text', async () => {
      // 日本語 (nihongo - Japanese language)
      const result = await phonemizeJapanese('日本語');
      // Expected: ニホンゴ → nihoɴɡo (U+0261, see the code-point test above)
      expect(result).toBe('nihoɴɡo');
    });

    it('phonemizes mixed Kanji and Kana', async () => {
      // こんにちは、世界 (konnichiwa, sekai - Hello, world)
      const result = await phonemizeJapanese('こんにちは、世界');
      // Expected: コンニチハ、セカイ → koɴniʨiha, sekai (punctuation normalized)
      expect(result).toBe('koɴniʨiha, sekai');
    });

    it('handles sentences with Kanji', async () => {
      // 今日は良い天気ですね (kyou wa ii tenki desu ne - Nice weather today)
      const result = await phonemizeJapanese('今日は良い天気ですね');
      // The exact output depends on kuroshiro's conversion
      expect(result).toMatch(/^[a-zɕʨʦʥɴ]+$/);
      expect(result.length).toBeGreaterThan(10);
    });
  });
});

describe('punctuation normalization', () => {
  it('converts full-width comma to period (for pausing)', async () => {
    const result = await phonemizeJapanese('こんにちは，世界');
    // 全角逗号 ， → . (period for stronger pause)
    expect(result).toContain('. ');
  });

  it('converts full-width period to ASCII period', async () => {
    const result = await phonemizeJapanese('こんにちは。');
    expect(result).toContain('.');
  });

  it('converts enumeration comma to ASCII comma', async () => {
    const result = await phonemizeJapanese('りんご、バナナ、オレンジ');
    // 顿号 、 → ,
    expect(result).toContain(', ');
  });
});

describe('Latin text handling', () => {
  it('spells out all-uppercase acronyms', async () => {
    const result = await phonemizeJapanese('APIを使う');
    // API should be spelled: A-P-I (each letter separately)
    // Result contains individual letters + Japanese part
    expect(result).toContain('p'); // P is in there
    expect(result).toContain('oɕiu'); // を使う part
  });

  it('treats mixed-case as words', async () => {
    const result = await phonemizeJapanese('Chatを使う');
    // "Chat" should be phonemized as a word, not spelled
    expect(result).toMatch(/tʃ/); // Contains 'ch' sound
  });
});

describe('textToKatakana', () => {
  it('converts Hiragana to Katakana', async () => {
    const result = await textToKatakana('ひらがな');
    expect(result).toBe('ヒラガナ');
  });

  it('converts Kanji to Katakana', async () => {
    const result = await textToKatakana('日本');
    // 日本 has two valid readings: ニホン (nihon) or ニッポン (nippon)
    expect(['ニホン', 'ニッポン']).toContain(result);
  });

  it('preserves punctuation', async () => {
    const result = await textToKatakana('こんにちは、世界');
    expect(result).toContain('、');
  });
});

describe('numerals', () => {
  /**
   * Reported against a real article: `２０２２年` came back as "とし".
   *
   * Two failures in one line. The digits were classified as `other` by the
   * segmenter and then filtered out as punctuation, so nothing was ever spoken
   * for them — and nothing was thrown either. And because the digits were split
   * off into that other run, 「年」 reached kuroshiro on its own, where it reads
   * とし; it only reads ねん with the number still in front of it. A test that
   * only checked the number would have passed a fix that left this behind.
   */
  it('reads full-width digits and keeps them beside what they count', async () => {
    const ipa = await phonemizeJapanese('２０２２年');

    expect(ipa).toContain('niseɴni'); // 二千二十二 → ニセンニ…
    expect(ipa).toContain('neɴ'); // 年 as ネン, which needs the digits in front
    expect(ipa).not.toContain('toɕi'); // …not the とし a lone 年 gives
  });

  it('reads half-width digits the same as full-width ones', async () => {
    // Both spellings reach the same reading; a page may use either.
    expect(await phonemizeJapanese('2022年')).toBe(await phonemizeJapanese('２０２２年'));
  });

  it('reads the numbers out of the sentence that was reported', async () => {
    const ipa = await phonemizeJapanese('資産３２億ドル、約４２００億円');

    // 三十二億 — サン-ジュ-ウ-ニ-オク. ジュ is one mora now, so the digits, the
    // counter and the palatalization are all visible in this one string.
    expect(ipa).toContain('saɴʥuunioku');
    // 四千二百億 — ヨン-セン-ニ-ヒャ-ク-オク.
    expect(ipa).toContain('joɴseɴniçakuoku');
  });

  it('reads a lone digit exactly', async () => {
    // A single digit carries no palatalized mora, so this one can be asserted
    // whole — and it pins the reading rather than merely its presence.
    expect(await phonemizeJapanese('7')).toBe('nana');
    expect(await phonemizeJapanese('７')).toBe('nana');
  });
});

describe('palatalized and foreign morae', () => {
  /**
   * The table had no two-character entries at all. `kanaToIPA` looks for them —
   * the loop tries `char + next` before falling back — but the lookup could
   * never match, so every pair was read as two morae: キャ was ki + ja.
   */
  it('reads a palatalized pair as one mora', () => {
    expect(kanaToIPA('キャ')).toBe('kja');
    expect(kanaToIPA('キュ')).toBe('kju');
    expect(kanaToIPA('キョ')).toBe('kjo');
    expect(kanaToIPA('リャ')).toBe('rja');
  });

  it('keeps the sibilants palatal rather than adding a glide', () => {
    // ɕ ʥ ʨ are palatal already, so there is no j after them — the shape misaki
    // uses, and the reason キャ and シャ do not look alike in IPA.
    expect(kanaToIPA('シャ')).toBe('ɕa');
    expect(kanaToIPA('ジュ')).toBe('ʥu');
    expect(kanaToIPA('チョ')).toBe('ʨo');
  });

  it('reads the voiced palatals with ɡ, not g', () => {
    expect(kanaToIPA('ギャ')).toBe('ɡja');
    expect(kanaToIPA('ギュ')).toBe('ɡju');
  });

  it('reads a sokuon as the glottal stop the vocabulary holds', () => {
    // Not a doubled consonant: misaki maps ッ to ʔ, and ʔ is what Kokoro has.
    expect(kanaToIPA('ロッピャク')).toBe('roʔpjaku');
  });

  it('lengthens the vowel at a prolonged sound mark', () => {
    expect(kanaToIPA('コーヒー')).toBe('koːhiː');
  });

  it('reads the foreign-word pairs', () => {
    expect(kanaToIPA('クァ')).toBe('kwa');
    // ASCII f, not ɸ, and taken from misaki rather than chosen: フ has always
    // been `fu` here, and both characters are in the vocabulary.
    expect(kanaToIPA('ファ')).toBe('fa');
    expect(kanaToIPA('ティ')).toBe('ti');
  });
});

describe('numeral sound changes', () => {
  /**
   * kuromoji reads the kanji but not the changes that make the reading Japanese:
   * 「三百」 is さん**び**ゃく, and it returns さんひゃく. Five cases, spelled out
   * separately so a rule that quietly stops matching is visible as itself.
   */
  it('voices 百 after 三', async () => {
    expect(await textToKatakana('三百')).toBe('サンビャク');
  });

  it('doubles 百 after 六 and 八', async () => {
    expect(await textToKatakana('六百')).toBe('ロッピャク');
    expect(await textToKatakana('八百')).toBe('ハッピャク');
  });

  it('voices 千 after 三', async () => {
    expect(await textToKatakana('三千')).toBe('サンゼン');
  });

  it('doubles 千 after 八', async () => {
    expect(await textToKatakana('八千')).toBe('ハッセン');
  });

  it('leaves the regular readings alone', async () => {
    // The other seven hundreds and thousands do not change, and a fix that
    // rewrote them all would be wrong in a way that still sounds like counting.
    expect(await textToKatakana('百')).toBe('ヒャク');
    expect(await textToKatakana('四百')).toBe('ヨンヒャク');
    expect(await textToKatakana('五百')).toBe('ゴヒャク');
    expect(await textToKatakana('千')).toBe('セン');
    expect(await textToKatakana('四千')).toBe('ヨンセン');
    expect(await textToKatakana('九千')).toBe('キュウセン');
  });
});
