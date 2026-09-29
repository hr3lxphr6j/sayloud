import { describe, expect, it } from 'vitest';
import { normalizeText, segmentSentences, segmentWords } from '~/lib/text-utils';

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
