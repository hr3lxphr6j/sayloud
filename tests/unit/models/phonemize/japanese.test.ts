/**
 * Tests for Japanese phonemizer (misaki-compatible).
 */
import { describe, it, expect } from 'vitest';
import { kanaToIPA, phonemizeJapanese, textToKatakana } from '@/lib/models/phonemize/japanese';

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
      expect(kanaToIPA('がぎぐげご')).toBe('gagigugego');
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
      expect(kanaToIPA('ありがとう')).toBe('arigatou');
      
      // さようなら (sayounara)
      expect(kanaToIPA('さようなら')).toBe('sajounara');
    });

    it('handles mixed Hiragana and Katakana', () => {
      expect(kanaToIPA('ひらがなとカタカナ')).toBe('hiraganatokatakana');
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
      // Expected: ニホンゴ → nihoɴgo
      expect(result).toBe('nihoɴgo');
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

    // 四千二百億 — ヨンセンニヒャクオク. Asserted on the half that has no
    // palatalized mora: `KATAKANA_TO_IPA` has no two-character entries yet, so
    // ヒャ is two morae today, and pinning the whole string here would make that
    // fix look like a regression in this test.
    expect(ipa).toContain('joɴseɴ');
    // 億 follows the digits instead of being read on its own.
    expect(ipa).toContain('oku');
  });

  it('reads a lone digit exactly', async () => {
    // A single digit carries no palatalized mora, so this one can be asserted
    // whole — and it pins the reading rather than merely its presence.
    expect(await phonemizeJapanese('7')).toBe('nana');
    expect(await phonemizeJapanese('７')).toBe('nana');
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
