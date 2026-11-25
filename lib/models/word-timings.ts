/**
 * Word timings from the model's `durations` output.
 *
 * Pure arithmetic, on purpose: the engine hands this the IPA it tokenized, the
 * durations the model answered with and the spans the phonemizer traced, and
 * gets back sentence-relative `WordTiming[]` — or an empty array when the
 * numbers do not describe the sentence, which the caller treats as "no
 * timings" rather than as an error. Nothing here touches the session, which is
 * what lets it be tested without one.
 */

import type { WordTiming } from '../providers/types';
import { KOKORO_SAMPLE_RATE } from './audio';
import type { PhonemeSpan } from './phonemize-rust';

/**
 * The combining marks the tokenizer's normaliser strips.
 *
 * The Rust vocabulary gate allows them *by name*, because the model never sees
 * them and the audio is right — `STRIPPED_BY_THE_NORMALIZER` in
 * `crates/phonemize/src/vocab.rs` is the same list, and the two must not
 * disagree. The consequence for timings is arithmetic, not judgment: the
 * `durations` output is per *token*, one per surviving character plus the BOS
 * and EOS, so a span's phoneme offsets have to skip these. The syllable
 * table's `ɻ̩` — zhi, chi, shi, ri, and every erhua coda — is in most Mandarin
 * sentences, and counting the mark as a token was what dropped word timings
 * for all of them.
 */
const STRIPPED_BY_THE_NORMALIZER = ['\u{032F}', '\u{0329}'];

/**
 * Word timings for one piece, from the model's `durations` output.
 *
 * The Rust phonemizer's vocabulary gate refuses any phoneme string holding a
 * character outside the model's vocabulary — except the two combining marks
 * above, which the tokenizer then strips. So a phoneme's token index is *not*
 * its character index: it is its index among the characters the normalizer
 * keeps, offset by the BOS the tokenizer adds. The length check is what
 * catches that accounting drifting from the tokenizer, instead of letting a
 * misaligned highlight ship.
 *
 * @param ipa the piece's phonemes, exactly what the engine tokenized.
 * @param durations the model's `durations` output: one frame count per token.
 * @param spans the phonemizer's spans, sentence-relative in characters and
 *   phoneme-offset in characters of `ipa`.
 * @param pieceSamples the piece's audio length in samples — the clock the
 *   frames are scaled to.
 * @param timeOffsetMs where this piece's audio starts in the sentence's, for
 *   a caller that renders pieces one after another into one buffer.
 */
export function wordTimings(
  ipa: string,
  durations: ArrayLike<number>,
  spans: readonly PhonemeSpan[],
  pieceSamples: number,
  timeOffsetMs: number
): WordTiming[] {
  const characters = [...ipa];
  // surviving[i] = how many characters before index `i` the normalizer keeps —
  // the character's index in the token sequence, which is what durations
  // indexes (plus one, for the BOS).
  const surviving: number[] = [0];
  let kept = 0;
  for (let i = 0; i < characters.length; i++) {
    surviving[i] = kept;
    if (!STRIPPED_BY_THE_NORMALIZER.includes(characters[i] ?? '')) kept += 1;
  }
  surviving[characters.length] = kept;

  const frames = Array.from(durations, Number);
  if (frames.length !== kept + 2) return [];
  if (!(pieceSamples > 0)) return [];

  let total = 0;
  for (const frame of frames) total += frame;
  if (!(total > 0)) return [];

  // Token `t`'s audio ends where the frames before it do: prefix[t] frames of
  // the piece's Σdurations, scaled to the audio's own length. Scaling to the
  // audio rather than to a fixed samples-per-frame absorbs the speed, the
  // frame rounding and the tail the model predicted but the audio does not
  // contain — measured, the fixed frame drifts 200 ms over a three-second
  // sentence at speed 1.25 and this does not drift at all.
  const prefix: number[] = [0];
  let cumulative = 0;
  for (const frame of frames) {
    cumulative += frame;
    prefix.push(cumulative);
  }
  const secondsPerFrame = pieceSamples / KOKORO_SAMPLE_RATE / total;

  const timings: WordTiming[] = [];
  for (const span of spans) {
    // Token `0` is the BOS, so surviving character `k` is token `k + 1`, and
    // its audio runs from where the tokens before it end to where it does.
    const startToken = surviving[span.phonemeStart];
    const endToken = surviving[span.phonemeEnd];
    if (startToken === undefined || endToken === undefined) continue;
    const startFrame = prefix[startToken + 1];
    const endFrame = prefix[endToken + 1];
    if (startFrame === undefined || endFrame === undefined) continue;
    const startMs = startFrame * secondsPerFrame * 1000;
    const endMs = endFrame * secondsPerFrame * 1000;
    if (!(endMs > startMs)) continue;
    timings.push({
      charStart: span.charStart,
      charEnd: span.charEnd,
      startMs: startMs + timeOffsetMs,
      endMs: endMs + timeOffsetMs,
    });
  }
  return timings;
}
