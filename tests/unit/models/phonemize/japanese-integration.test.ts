/**
 * Integration tests for Japanese phonemizer.
 */
import { describe, it, expect } from 'vitest';
import { phonemizerFor, isJapanese } from '@/lib/models/phonemize';

describe('Japanese phonemizer integration', () => {
  describe('isJapanese', () => {
    it('detects Japanese language codes', () => {
      expect(isJapanese('ja')).toBe(true);
      expect(isJapanese('ja-JP')).toBe(true);
      expect(isJapanese('JA')).toBe(true);
    });

    it('rejects non-Japanese codes', () => {
      expect(isJapanese('zh')).toBe(false);
      expect(isJapanese('zh-CN')).toBe(false);
      expect(isJapanese('en')).toBe(false);
      expect(isJapanese('en-US')).toBe(false);
    });
  });

  describe('phonemizerFor', () => {
    it('returns JapanesePhonemizer for Japanese', async () => {
      const phonemizer = await phonemizerFor('ja');
      expect(phonemizer).toBeDefined();
      expect(phonemizer.phonemize).toBeDefined();
    });

    it('phonemizes Japanese Kana text', async () => {
      const phonemizer = await phonemizerFor('ja');
      const result = await phonemizer.phonemize('こんにちは', 'ja');
      
      // Expected: コンニチハ → koɴniʨiha
      expect(result).toBe('koɴniʨiha');
    });

    it('handles different Japanese language codes', async () => {
      const phonemizer1 = await phonemizerFor('ja');
      const phonemizer2 = await phonemizerFor('ja-JP');
      
      const text = 'ありがとう';
      const result1 = await phonemizer1.phonemize(text, 'ja');
      const result2 = await phonemizer2.phonemize(text, 'ja-JP');
      
      expect(result1).toBe(result2);
      // ɡ is U+0261, the one Kokoro's vocabulary holds; see the code-point test
      // in `japanese.test.ts` for why the ASCII g is not an option.
      expect(result1).toBe('ariɡatou');
    });
  });
});
