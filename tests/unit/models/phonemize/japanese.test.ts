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
