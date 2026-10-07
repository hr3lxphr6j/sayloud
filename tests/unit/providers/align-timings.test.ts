import { describe, expect, it } from 'vitest';
import { alignTimings, type TimingFormat } from '~/lib/providers/align-timings';

/** One `chars` entry per code point, 100ms apart. */
function perChar(
  text: string,
  msPerChar = 100
): Array<{ char: string; startMs: number; endMs: number }> {
  return [...text].map((char, index) => ({
    char,
    startMs: index * msPerChar,
    endMs: (index + 1) * msPerChar,
  }));
}

describe('alignTimings', () => {
  describe('guards', () => {
    it('rejects an empty sentence', () => {
      expect(alignTimings('', { kind: 'offset', marks: [{ charIndex: 0, timeMs: 0 }] }, 100)).toBe(
        undefined
      );
    });

    it('rejects a non-positive duration', () => {
      const marks: TimingFormat = { kind: 'offset', marks: [{ charIndex: 0, timeMs: 0 }] };
      expect(alignTimings('hi', marks, 0)).toBe(undefined);
      expect(alignTimings('hi', marks, -1)).toBe(undefined);
      expect(alignTimings('hi', marks, Number.NaN)).toBe(undefined);
      expect(alignTimings('hi', marks, Number.POSITIVE_INFINITY)).toBe(undefined);
    });
  });

  describe('offset', () => {
    it('maps each mark to the span up to the next mark', () => {
      const timings = alignTimings(
        'Hello world.',
        {
          kind: 'offset',
          marks: [
            { charIndex: 0, timeMs: 0 },
            { charIndex: 6, timeMs: 500 },
          ],
        },
        1200
      );

      expect(timings).toEqual([
        { charStart: 0, charEnd: 5, startMs: 0, endMs: 500 },
        { charStart: 6, charEnd: 12, startMs: 500, endMs: 1200 },
      ]);
    });

    it('closes the last word with the audio duration', () => {
      const timings = alignTimings(
        'Hi',
        { kind: 'offset', marks: [{ charIndex: 0, timeMs: 20 }] },
        300
      );

      expect(timings).toEqual([{ charStart: 0, charEnd: 2, startMs: 20, endMs: 300 }]);
    });

    it('trims the whitespace a span inherits from the next mark', () => {
      const timings = alignTimings(
        'a b',
        {
          kind: 'offset',
          marks: [
            { charIndex: 0, timeMs: 0 },
            { charIndex: 2, timeMs: 100 },
          ],
        },
        200
      );

      expect(timings?.[0]).toEqual({ charStart: 0, charEnd: 1, startMs: 0, endMs: 100 });
    });

    it('drops an end-of-utterance mark and closes the previous word with the duration', () => {
      const timings = alignTimings(
        'Hello',
        {
          kind: 'offset',
          marks: [
            { charIndex: 0, timeMs: 0 },
            { charIndex: 5, timeMs: 600 },
          ],
        },
        600
      );

      expect(timings).toEqual([{ charStart: 0, charEnd: 5, startMs: 0, endMs: 600 }]);
    });

    it('handles CJK offsets', () => {
      const timings = alignTimings(
        '你好世界',
        {
          kind: 'offset',
          marks: [
            { charIndex: 0, timeMs: 0 },
            { charIndex: 2, timeMs: 300 },
          ],
        },
        800
      );

      expect(timings).toEqual([
        { charStart: 0, charEnd: 2, startMs: 0, endMs: 300 },
        { charStart: 2, charEnd: 4, startMs: 300, endMs: 800 },
      ]);
    });

    it('clamps a provider clock that overshoots the audio', () => {
      const timings = alignTimings(
        'Hello world.',
        {
          kind: 'offset',
          marks: [
            { charIndex: 0, timeMs: 0 },
            { charIndex: 6, timeMs: 2000 },
          ],
        },
        1200
      );

      expect(timings?.[0]?.endMs).toBe(1200);
      expect(timings?.[1]).toEqual({ charStart: 6, charEnd: 12, startMs: 1200, endMs: 1200 });
    });

    it('rejects no marks', () => {
      expect(alignTimings('hi', { kind: 'offset', marks: [] }, 100)).toBe(undefined);
    });

    it('rejects marks that only sit at the end of the text', () => {
      expect(
        alignTimings('hi', { kind: 'offset', marks: [{ charIndex: 2, timeMs: 50 }] }, 100)
      ).toBe(undefined);
    });

    it('rejects a charIndex past the end of the sentence', () => {
      expect(
        alignTimings('hi', { kind: 'offset', marks: [{ charIndex: 3, timeMs: 0 }] }, 100)
      ).toBe(undefined);
    });

    it('rejects a negative or fractional charIndex', () => {
      expect(
        alignTimings('hi', { kind: 'offset', marks: [{ charIndex: -1, timeMs: 0 }] }, 100)
      ).toBe(undefined);
      expect(
        alignTimings('hi', { kind: 'offset', marks: [{ charIndex: 0.5, timeMs: 0 }] }, 100)
      ).toBe(undefined);
    });

    it('rejects marks whose charIndex runs backwards', () => {
      expect(
        alignTimings(
          'Hello world.',
          {
            kind: 'offset',
            marks: [
              { charIndex: 0, timeMs: 0 },
              { charIndex: 6, timeMs: 100 },
              { charIndex: 3, timeMs: 200 },
            ],
          },
          400
        )
      ).toBe(undefined);
    });

    it('rejects a clock that runs backwards', () => {
      expect(
        alignTimings(
          'Hello world.',
          {
            kind: 'offset',
            marks: [
              { charIndex: 0, timeMs: 500 },
              { charIndex: 6, timeMs: 100 },
            ],
          },
          1200
        )
      ).toBe(undefined);
    });

    it('rejects a negative or non-finite time', () => {
      expect(
        alignTimings('hi', { kind: 'offset', marks: [{ charIndex: 0, timeMs: -5 }] }, 100)
      ).toBe(undefined);
      expect(
        alignTimings('hi', { kind: 'offset', marks: [{ charIndex: 0, timeMs: Number.NaN }] }, 100)
      ).toBe(undefined);
    });

    it('rejects a mark whose end time is negative', () => {
      expect(
        alignTimings(
          'Hello world.',
          {
            kind: 'offset',
            marks: [
              { charIndex: 0, timeMs: 0 },
              { charIndex: 6, timeMs: -100 },
            ],
          },
          1200
        )
      ).toBe(undefined);
    });
  });

  describe('sequential-words', () => {
    it('locates each word in order, skipping punctuation and spaces', () => {
      const timings = alignTimings(
        'Hello, brave world.',
        {
          kind: 'sequential-words',
          words: [
            { text: 'Hello', startMs: 0, endMs: 400 },
            { text: 'brave', startMs: 500, endMs: 800 },
            { text: 'world', startMs: 900, endMs: 1400 },
          ],
        },
        1500
      );

      expect(timings).toEqual([
        { charStart: 0, charEnd: 5, startMs: 0, endMs: 400 },
        { charStart: 7, charEnd: 12, startMs: 500, endMs: 800 },
        { charStart: 13, charEnd: 18, startMs: 900, endMs: 1400 },
      ]);
    });

    it('advances a forward-only cursor so repeats match in order', () => {
      const timings = alignTimings(
        'go go go',
        {
          kind: 'sequential-words',
          words: [
            { text: 'go', startMs: 0, endMs: 100 },
            { text: 'go', startMs: 100, endMs: 200 },
            { text: 'go', startMs: 200, endMs: 300 },
          ],
        },
        300
      );

      expect(timings?.map((timing) => timing.charStart)).toEqual([0, 3, 6]);
    });

    it('handles CJK words without spaces', () => {
      const timings = alignTimings(
        '今天天气很好',
        {
          kind: 'sequential-words',
          words: [
            { text: '今天', startMs: 0, endMs: 300 },
            { text: '天气', startMs: 300, endMs: 600 },
            { text: '很好', startMs: 600, endMs: 900 },
          ],
        },
        900
      );

      expect(timings?.map(({ charStart, charEnd }) => [charStart, charEnd])).toEqual([
        [0, 2],
        [2, 4],
        [4, 6],
      ]);
    });

    it('skips a word the provider normalized instead of rejecting the sentence', () => {
      // Volcengine and CosyVoice read "5" as "five", so its offsets no longer
      // describe this sentence. Skip it, keep the rest —
      // rejecting the whole set would cost word highlight on every sentence
      // containing a number.
      const timings = alignTimings(
        'It costs 5 dollars.',
        {
          kind: 'sequential-words',
          words: [
            { text: 'It', startMs: 0, endMs: 100 },
            { text: 'costs', startMs: 100, endMs: 300 },
            { text: 'five', startMs: 300, endMs: 500 },
            { text: 'dollars.', startMs: 500, endMs: 800 },
          ],
        },
        800
      );

      // "It" [0,2), "costs" [3,8), "dollars." [11,19); "five" is dropped and
      // never guessed at, so "5" simply stays unhighlighted.
      expect(timings?.map(({ charStart, charEnd }) => [charStart, charEnd])).toEqual([
        [0, 2],
        [3, 8],
        [11, 19],
      ]);
    });

    it('still reports nothing when no word can be placed', () => {
      // Every word normalized away: there is no partial highlight to give, so
      // the caller must fall back to the sentence.
      const timings = alignTimings(
        '1.27',
        {
          kind: 'sequential-words',
          words: [
            { text: '一', startMs: 0, endMs: 100 },
            { text: '点', startMs: 100, endMs: 200 },
            { text: '二', startMs: 200, endMs: 300 },
            { text: '七', startMs: 300, endMs: 400 },
          ],
        },
        400
      );

      expect(timings).toBe(undefined);
    });

    it('rejects no words or an empty word', () => {
      expect(alignTimings('hi', { kind: 'sequential-words', words: [] }, 100)).toBe(undefined);
      expect(
        alignTimings(
          'hi',
          { kind: 'sequential-words', words: [{ text: '', startMs: 0, endMs: 50 }] },
          100
        )
      ).toBe(undefined);
    });

    it('rejects a clock that runs backwards', () => {
      expect(
        alignTimings(
          'go go',
          {
            kind: 'sequential-words',
            words: [
              { text: 'go', startMs: 300, endMs: 400 },
              { text: 'go', startMs: 100, endMs: 200 },
            ],
          },
          500
        )
      ).toBe(undefined);
    });

    it('rejects a word that ends before it starts', () => {
      expect(
        alignTimings(
          'go',
          { kind: 'sequential-words', words: [{ text: 'go', startMs: 300, endMs: 200 }] },
          500
        )
      ).toBe(undefined);
    });

    it('rejects non-finite times', () => {
      expect(
        alignTimings(
          'go',
          { kind: 'sequential-words', words: [{ text: 'go', startMs: 0, endMs: Number.NaN }] },
          500
        )
      ).toBe(undefined);
    });
  });

  describe('chars', () => {
    it('merges character timings into words when the text maps 1:1', () => {
      const text = 'Hello world';
      const timings = alignTimings(
        text,
        { kind: 'chars', chars: perChar(text) },
        text.length * 100
      );

      expect(timings).toEqual([
        { charStart: 0, charEnd: 5, startMs: 0, endMs: 500 },
        { charStart: 6, charEnd: 11, startMs: 600, endMs: 1100 },
      ]);
    });

    it('skips whitespace and punctuation segments', () => {
      const text = 'Hi, ok.';
      const timings = alignTimings(
        text,
        { kind: 'chars', chars: perChar(text) },
        text.length * 100
      );

      expect(timings?.map(({ charStart, charEnd }) => [charStart, charEnd])).toEqual([
        [0, 2],
        [4, 6],
      ]);
    });

    it('falls back to locating words when the provider text is not the sentence', () => {
      // A leading space is enough to break a 1:1 map; the words still line up.
      const text = 'Hello world.';
      const timings = alignTimings(text, { kind: 'chars', chars: perChar(` ${text}`) }, 1300);

      expect(timings?.map(({ charStart, charEnd }) => [charStart, charEnd])).toEqual([
        [0, 5],
        [6, 11],
      ]);
    });

    it('skips normalized characters and keeps the words that do line up', () => {
      // ElevenLabs aligns against normalized text: "5" is spoken as "five",
      // so the character clock covers more characters than the sentence has.
      // The words either side of it still align.
      const timings = alignTimings(
        'It costs 5 dollars.',
        { kind: 'chars', chars: perChar('It costs five dollars.') },
        2400
      );

      // "It" [0,2), "costs" [3,8), "dollars" [11,18). The segmenter drops the
      // trailing period, so the last span ends one character earlier than in
      // the `sequential-words` case above.
      expect(timings).toBeDefined();
      expect(timings?.map(({ charStart, charEnd }) => [charStart, charEnd])).toEqual([
        [0, 2],
        [3, 8],
        [11, 18],
      ]);
    });

    it('covers a CJK sentence contiguously', () => {
      const text = '今天天气很好';
      const timings = alignTimings(
        text,
        { kind: 'chars', chars: perChar(text) },
        text.length * 100
      );

      // Dictionary segmentation decides where the word breaks fall; what must
      // hold is that every word is inside the sentence and the spans tile it.
      expect(timings).toBeDefined();
      let cursor = 0;
      for (const timing of timings ?? []) {
        expect(timing.charStart).toBe(cursor);
        expect(timing.charEnd).toBeGreaterThan(timing.charStart);
        cursor = timing.charEnd;
      }
      expect(cursor).toBe(text.length);
    });

    it('rejects no chars or only non-word chars', () => {
      expect(alignTimings('hi', { kind: 'chars', chars: [] }, 100)).toBe(undefined);
      expect(alignTimings('  ', { kind: 'chars', chars: perChar('  ') }, 100)).toBe(undefined);
    });

    it('rejects a clock that runs backwards', () => {
      const chars = [
        { char: 'g', startMs: 300, endMs: 400 },
        { char: 'o', startMs: 100, endMs: 200 },
      ];
      expect(alignTimings('go', { kind: 'chars', chars }, 500)).toBe(undefined);
    });
  });
});
