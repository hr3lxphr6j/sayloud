import { describe, expect, it } from 'vitest';
import {
  mergeLineBreaks,
  normalizeText,
  protectSpecialNumbers,
  restoreSpecialNumbers,
  segmentSentences,
  segmentWords,
} from '~/lib/text-utils';

describe('text-utils', () => {
  it('normalizes whitespace', () => {
    expect(normalizeText('Hello   \n  world')).toBe('Hello world');
  });

  it('segments English sentences', () => {
    const sents = segmentSentences('Hello world. Goodbye!', 'en');
    expect(sents).toHaveLength(2);
    expect(sents[0]?.text).toBe('Hello world.');
    expect(sents[1]?.text).toBe('Goodbye!');
  });

  it('segments Chinese sentences', () => {
    const sents = segmentSentences('你好。再见。', 'zh');
    expect(sents).toHaveLength(2);
  });

  it('segments words', () => {
    const words = segmentWords('Hello world.', 'en');
    expect(words.map((w) => w.text)).toEqual(['Hello', 'world']);
  });

  describe('mergeLineBreaks', () => {
    it('joins a CJK soft wrap without adding a space', () => {
      expect(mergeLineBreaks('第一行\n第二行')).toBe('第一行第二行');
    });

    it('keeps a paragraph break', () => {
      expect(mergeLineBreaks('第一段。\n\n第二段。')).toBe('第一段。\n\n第二段。');
    });

    it('collapses runs of three or more newlines to a paragraph break', () => {
      expect(mergeLineBreaks('第一段。\n\n\n\n第二段。')).toBe('第一段。\n\n第二段。');
    });

    it('turns a Latin soft wrap into a single space', () => {
      expect(mergeLineBreaks('Hello\nworld')).toBe('Hello world');
      // An indented wrap must not leave two spaces behind.
      expect(mergeLineBreaks('Hello\n   world')).toBe('Hello world');
    });

    it('joins a mixed CJK/Latin wrap with a space', () => {
      expect(mergeLineBreaks('第一行\nEnglish')).toBe('第一行 English');
    });

    it('handles CRLF', () => {
      expect(mergeLineBreaks('第一行\r\n第二行')).toBe('第一行第二行');
      expect(mergeLineBreaks('第一段。\r\n\r\n第二段。')).toBe('第一段。\n\n第二段。');
    });

    it('leaves text without newlines untouched', () => {
      expect(mergeLineBreaks('你好。再见。')).toBe('你好。再见。');
    });
  });

  describe('special numbers', () => {
    it('masks version numbers', () => {
      expect(protectSpecialNumbers('v1.2.3 发布')).toBe('v1_DOT_2_DOT_3 发布');
    });

    it('masks decimals', () => {
      expect(protectSpecialNumbers('价格 3.14 元')).toBe('价格 3_DOT_14 元');
    });

    it('masks times', () => {
      expect(protectSpecialNumbers('12:45 开始')).toBe('12_TIME_45 开始');
    });

    it('leaves a sentence-final dot alone', () => {
      expect(protectSpecialNumbers('It costs 3.14. Done.')).toBe('It costs 3_DOT_14. Done.');
    });

    it('round-trips through restore', () => {
      const source = 'v1.2.3 发布于 3.14 的 12:45';
      expect(restoreSpecialNumbers(protectSpecialNumbers(source))).toBe(source);
    });
  });

  describe('soft wraps in segmentation', () => {
    it('keeps a CJK line wrap inside one sentence', () => {
      const sents = segmentSentences('第一行\n第二行。', 'zh');
      expect(sents.map((s) => s.text)).toEqual(['第一行\n第二行。']);
    });

    it('keeps a Latin line wrap inside one sentence', () => {
      const sents = segmentSentences('Hello\nworld. Goodbye.', 'en');
      expect(sents.map((s) => s.text)).toEqual(['Hello\nworld.', 'Goodbye.']);
    });

    it('still splits at a paragraph break', () => {
      const sents = segmentSentences('第一段。\n\n第二段。', 'zh');
      expect(sents.map((s) => s.text)).toEqual(['第一段。', '第二段。']);
    });

    it('does not split numbers across sentences', () => {
      const sents = segmentSentences('版本 v1.2.3 的价格是 3.14 元，时间 12:45。', 'zh');
      expect(sents.map((s) => s.text)).toEqual(['版本 v1.2.3 的价格是 3.14 元，时间 12:45。']);
    });

    it('keeps offsets aligned across a merged wrap', () => {
      const source = '第一行\n第二行。再见。';
      const sents = segmentSentences(source, 'zh');

      expect(sents).toHaveLength(2);
      for (const s of sents) {
        expect(s.text.length).toBe(s.end - s.start);
        expect(source.slice(s.start, s.end)).toBe(s.text);
      }
      expect(sents[0]?.text).toBe('第一行\n第二行。');
      expect(sents[1]?.text).toBe('再见。');
    });

    it('keeps offsets aligned when a number is masked', () => {
      const source = '价格是 3.14 元。再见。';
      const sents = segmentSentences(source, 'zh');

      for (const s of sents) {
        expect(s.text.length).toBe(s.end - s.start);
        expect(source.slice(s.start, s.end)).toBe(s.text);
      }
      expect(sents.map((s) => s.text)).toEqual(['价格是 3.14 元。', '再见。']);
    });
  });

  describe('offset alignment', () => {
    // Highlighters slice the block text with [start, end), so a segment's text
    // must be exactly the substring it claims to cover.
    it('keeps English sentence offsets aligned with the trimmed text', () => {
      const source = 'Hello world. Goodbye!';
      const sents = segmentSentences(source, 'en');

      expect(sents.length).toBeGreaterThan(0);
      for (const s of sents) {
        expect(s.text.length).toBe(s.end - s.start);
        expect(source.slice(s.start, s.end)).toBe(s.text);
      }
    });

    it('keeps Chinese sentence offsets aligned with the trimmed text', () => {
      const source = '你好。 再见。';
      const sents = segmentSentences(source, 'zh');

      expect(sents.length).toBeGreaterThan(0);
      for (const s of sents) {
        expect(s.text.length).toBe(s.end - s.start);
        expect(source.slice(s.start, s.end)).toBe(s.text);
      }
    });

    it('drops whitespace-only segments', () => {
      expect(segmentSentences('   ', 'en')).toEqual([]);
    });
  });
});
