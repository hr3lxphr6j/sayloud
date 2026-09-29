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
});
