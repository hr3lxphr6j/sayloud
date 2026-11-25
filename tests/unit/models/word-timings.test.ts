/**
 * The word-timing arithmetic, on its own.
 *
 * These were once engine tests, which meant standing in a session whose mock
 * answered with the right durations; the arithmetic does not need one, and
 * testing it directly is what let the module-level duration hack go.
 */
import { describe, expect, it } from 'vitest';

import { wordTimings } from '~/lib/models/word-timings';

/** 2400 samples: 100 ms, so every expectation is readable arithmetic. */
const PIECE_SAMPLES = 2_400;

const SPANS = [
  { charStart: 10, charEnd: 13, phonemeStart: 0, phonemeEnd: 3 },
  { charStart: 14, charEnd: 17, phonemeStart: 4, phonemeEnd: 6 },
];

describe('wordTimings', () => {
  it('scales the model frames to the audio it actually produced', () => {
    // 'həlˈoʊ' is six characters → eight durations summing to 7. The first
    // word sits at frames 0.5..3.5 of Σ7, and 2400 samples are 100 ms. Nothing
    // is estimated: the scale is the audio's own length, not a fixed
    // samples-per-frame — the fixed frame drifts 200 ms over a three-second
    // sentence at speed 1.25, and this does not drift at all.
    const timings = wordTimings(
      'həlˈoʊ',
      [0.5, 1, 1, 1, 1, 1, 1, 0.5],
      SPANS,
      PIECE_SAMPLES,
      0
    );

    expect(timings[0]?.startMs).toBeCloseTo(100 * (0.5 / 7), 6);
    expect(timings[0]?.endMs).toBeCloseTo(100 * (3.5 / 7), 6);
    expect(timings[1]?.startMs).toBeCloseTo(100 * (4.5 / 7), 6);
    expect(timings[1]?.endMs).toBeCloseTo(100 * (6.5 / 7), 6);
  });

  it('shifts the times by the audio that came before the piece', () => {
    // Two pieces of 100 ms each: the second piece's first word starts there
    // plus its own share of its own audio.
    // Seven characters → nine tokens; Σ8 frames.
    const timings = wordTimings(
      ' wˈɜːld',
      [0.5, 1, 1, 1, 1, 1, 1, 1, 0.5],
      [{ charStart: 20, charEnd: 25, phonemeStart: 0, phonemeEnd: 2 }],
      PIECE_SAMPLES,
      100
    );

    expect(timings[0]?.startMs).toBeCloseTo(100 + 100 * (0.5 / 8), 6);
    expect(timings[0]?.endMs).toBeCloseTo(100 + 100 * (2.5 / 8), 6);
  });

  it('skips the combining marks the tokenizer strips, without dropping the sentence', () => {
    // `ʂɻ̩` is what the syllable table produces for shi, and the mark is in
    // most Mandarin sentences. The tokenizer strips it — the durations stop
    // lining up with the character count — and counting the mark as a token
    // was what dropped word timings for all of those sentences.
    const ipa = 'ʂɻ\u0329 i.';
    // Six characters, five of which survive the normalizer → seven tokens.
    const timings = wordTimings(ipa, [0.5, 1, 1, 1, 1, 1, 0.5], [
      // The first word's phonemes end *after* the stripped mark: the mark
      // belongs to the word it syllabifies, and contributes no token of its
      // own.
      { charStart: 0, charEnd: 2, phonemeStart: 0, phonemeEnd: 3 },
      { charStart: 4, charEnd: 5, phonemeStart: 4, phonemeEnd: 5 },
    ], PIECE_SAMPLES, 0);

    // Σ6 frames: word 1 owns frames 0.5..2.5, word 2 owns 3.5..4.5 — the mark
    // contributed none, and the space between the words got the frames that
    // separate them.
    expect(timings[0]?.startMs).toBeCloseTo(100 * (0.5 / 6), 6);
    expect(timings[0]?.endMs).toBeCloseTo(100 * (2.5 / 6), 6);
    expect(timings[1]?.startMs).toBeCloseTo(100 * (3.5 / 6), 6);
    expect(timings[1]?.endMs).toBeCloseTo(100 * (4.5 / 6), 6);
  });

  it('answers nothing when the token count does not describe the phonemes', () => {
    // A strip the vocabulary does not predict would show up exactly here: the
    // durations would stop lining up with the phoneme characters, and a
    // highlight built from them would point at the wrong words.
    expect(wordTimings('həlˈoʊ', [1, 1, 1, 1], SPANS, PIECE_SAMPLES, 0)).toEqual([]);
  });

  it('answers nothing when there is no audio to scale to', () => {
    expect(
      wordTimings('həlˈoʊ', [0.5, 1, 1, 1, 1, 1, 1, 0.5], SPANS, 0, 0)
    ).toEqual([]);
  });

  it('answers nothing when the durations are all zero', () => {
    expect(wordTimings('həlˈoʊ', [0, 0, 0, 0, 0, 0, 0, 0], SPANS, PIECE_SAMPLES, 0)).toEqual(
      []
    );
  });
});
