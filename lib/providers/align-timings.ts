/**
 * Timestamp alignment (spec §2.2).
 *
 * Every provider reports word timing in its own vocabulary. This module
 * normalizes all of them to `WordTiming[]` in sentence-relative character
 * offsets, and — crucially — never estimates. A word is highlighted only where
 * its own text was found in the sentence; providers that normalize what they
 * speak (reading "5" as "five") simply lose those words, and a sentence whose
 * words cannot be placed at all returns `undefined` so the caller falls back to
 * sentence-level highlight.
 */
import type { WordTiming } from './types';

/** Raw timing shapes a provider can report. */
export type TimingFormat =
  /** A time for the character at `charIndex`. Azure `WordBoundary`, `chrome.tts`. */
  | { kind: 'offset'; marks: Array<{ charIndex: number; timeMs: number }> }
  /** Word text plus its audio span, in reading order. CosyVoice, Kokoro. */
  | { kind: 'sequential-words'; words: Array<{ text: string; startMs: number; endMs: number }> }
  /** One entry per character of the provider's (possibly normalized) text. */
  | { kind: 'chars'; chars: Array<{ char: string; startMs: number; endMs: number }> };

/** A candidate word span before validation. */
interface Span {
  charStart: number;
  charEnd: number;
  startMs: number;
  /** `undefined` on the final offset mark: its end is the audio duration. */
  endMs: number | undefined;
}

/**
 * Align a provider's timings to `sentenceText`.
 *
 * @param sentenceText the exact text handed to `synthesize()`.
 * @param format the provider's raw timings.
 * @param durationMs the audio's duration, used to close the final word's span
 *   and to clamp provider clocks that overshoot. Must be a positive number:
 *   a caller that does not know the duration yet should not ask for alignment.
 * @returns word spans in reading order, or `undefined` when alignment failed
 *   and the caller must fall back to sentence-level highlight.
 */
export function alignTimings(
  sentenceText: string,
  format: TimingFormat,
  durationMs: number
): WordTiming[] | undefined {
  if (sentenceText.length === 0) return undefined;
  if (!Number.isFinite(durationMs) || durationMs <= 0) return undefined;

  let spans: Span[] | undefined;
  switch (format.kind) {
    case 'offset':
      spans = alignOffsets(sentenceText, format.marks);
      break;
    case 'sequential-words':
      spans = alignSequentialWords(sentenceText, format.words);
      break;
    case 'chars':
      spans = alignChars(sentenceText, format.chars);
      break;
  }

  if (!spans) return undefined;
  return finalize(spans, sentenceText, durationMs);
}

/**
 * `offset`: each mark is the start of a word, so a word runs from its own
 * `charIndex` to the next mark's. The last mark is closed with `durationMs`.
 */
function alignOffsets(
  text: string,
  marks: Array<{ charIndex: number; timeMs: number }>
): Span[] | undefined {
  if (marks.length === 0) return undefined;

  const spans: Span[] = [];
  for (let index = 0; index < marks.length; index++) {
    const mark = marks[index];
    const next = marks[index + 1];
    if (!mark) return undefined;

    // A mark at `text.length` is a legitimate end-of-utterance marker: it
    // produces a zero-length span that `finalize` drops.
    if (!Number.isInteger(mark.charIndex) || mark.charIndex < 0 || mark.charIndex > text.length) {
      return undefined;
    }
    if (next && next.charIndex < mark.charIndex) return undefined;

    spans.push({
      charStart: mark.charIndex,
      charEnd: next ? next.charIndex : text.length,
      startMs: mark.timeMs,
      endMs: next ? next.timeMs : undefined,
    });
  }

  return spans;
}

/**
 * `sequential-words`: locate each word's text in the sentence, in order.
 *
 * The cursor only moves forward, so a repeated word cannot match an earlier
 * occurrence.
 *
 * Providers commonly normalize the text they speak, so a word that is not a
 * verbatim substring of the sentence is expected rather than exceptional —
 * Volcengine and CosyVoice read "1.27" as "一 点 二 七", Kokoro and ElevenLabs
 * read "5" as "five", and a URL is spoken as two pieces. Spec §2.1 / V9 are
 * explicit about what to do: skip the words that do not line up and keep the
 * rest. Rejecting the whole sentence instead would cost word-level highlight on
 * every sentence containing a number, a unit or a link — which is most of them.
 *
 * Skipping can only ever omit a highlight, never place one wrongly: a word is
 * still only ever highlighted where its own text was found, and the search
 * never moves backwards. When nothing matches, `finalize` finds no spans and
 * the caller falls back to sentence-level highlight, which is the same
 * no-estimation rule that governs the rest of this module.
 */
function alignSequentialWords(
  text: string,
  words: Array<{ text: string; startMs: number; endMs: number }>
): Span[] | undefined {
  if (words.length === 0) return undefined;

  const spans: Span[] = [];
  let cursor = 0;
  for (const word of words) {
    if (word.text.length === 0) return undefined;
    // A word that ends before it starts means the provider's clock is not
    // usable; clamping it would fabricate a highlight.
    if (!Number.isFinite(word.startMs) || !Number.isFinite(word.endMs)) return undefined;
    if (word.startMs < 0 || word.endMs < word.startMs) return undefined;

    const charStart = text.indexOf(word.text, cursor);
    // Not found: the provider spoke something else here. Drop this word's
    // timing and leave the cursor alone, so the next word still searches from
    // the same place.
    if (charStart < 0) continue;

    const charEnd = charStart + word.text.length;
    spans.push({ charStart, charEnd, startMs: word.startMs, endMs: word.endMs });
    cursor = charEnd;
  }

  return spans;
}

/**
 * `chars`: merge character timings into words.
 *
 * When the provider's character array is the sentence verbatim the offsets map
 * 1:1 and the merge is exact. Providers commonly align against *normalized*
 * text instead (ElevenLabs expands "5" to "five"), so in that case the
 * segmented words are located in the sentence by text, exactly as
 * `sequential-words` does — and rejected when they do not appear.
 *
 * Word boundaries come from `Intl.Segmenter`, which handles CJK dictionary
 * segmentation; without it there is no faithful way to merge, so alignment
 * fails and the sentence-level highlight takes over.
 */
function alignChars(
  text: string,
  chars: Array<{ char: string; startMs: number; endMs: number }>
): Span[] | undefined {
  if (chars.length === 0) return undefined;

  // Validate the character clock up front: in the 1:1 case the word spans are
  // derived straight from these entries, so a backwards clock there would
  // otherwise be clamped into a plausible-looking but wrong highlight.
  let previousStartMs = Number.NEGATIVE_INFINITY;
  for (const entry of chars) {
    if (!Number.isFinite(entry.startMs) || !Number.isFinite(entry.endMs)) return undefined;
    if (entry.startMs < 0 || entry.endMs < entry.startMs) return undefined;
    if (entry.startMs < previousStartMs) return undefined;
    previousStartMs = entry.startMs;
  }

  let raw = '';
  for (const entry of chars) raw += entry.char;
  if (raw.length === 0) return undefined;

  const segments = segmentWords(raw);
  if (!segments) return undefined;

  const words: Array<{ text: string; startMs: number; endMs: number; start: number; end: number }> =
    [];
  for (const segment of segments) {
    const first = chars[segment.start];
    const last = chars[segment.end - 1];
    if (!first || !last) return undefined;
    words.push({
      text: segment.text,
      startMs: first.startMs,
      endMs: last.endMs,
      start: segment.start,
      end: segment.end,
    });
  }

  if (raw === text) {
    // Exact 1:1 mapping: character offsets are already sentence offsets.
    return words.map((word) => ({
      charStart: word.start,
      charEnd: word.end,
      startMs: word.startMs,
      endMs: word.endMs,
    }));
  }

  return alignSequentialWords(
    text,
    words.map(({ text: wordText, startMs, endMs }) => ({ text: wordText, startMs, endMs }))
  );
}

interface WordSegment {
  text: string;
  start: number;
  end: number;
}

/** Word-like segments of `text`, or `undefined` when segmentation is unavailable. */
function segmentWords(text: string): WordSegment[] | undefined {
  if (typeof Intl.Segmenter !== 'function') return undefined;

  const segmenter = new Intl.Segmenter(undefined, { granularity: 'word' });
  const segments: WordSegment[] = [];
  for (const part of segmenter.segment(text)) {
    // Whitespace and punctuation carry timings but are not words to highlight.
    if (!part.isWordLike) continue;
    segments.push({
      text: part.segment,
      start: part.index,
      end: part.index + part.segment.length,
    });
  }

  return segments.length > 0 ? segments : undefined;
}

/**
 * Validate candidate spans and clamp them to the audio's duration.
 *
 * Structural problems (bad offsets, unusable times, a clock that runs
 * backwards) mean the timings do not describe this sentence, so the whole set
 * is rejected. Numeric overshoot is merely clamped — a provider whose last
 * word ends a few milliseconds past the reported duration is still usable.
 */
function finalize(spans: Span[], text: string, durationMs: number): WordTiming[] | undefined {
  const textLength = text.length;
  const timings: WordTiming[] = [];
  let previousStartMs = 0;

  for (const span of spans) {
    if (!Number.isInteger(span.charStart) || !Number.isInteger(span.charEnd)) return undefined;
    if (span.charStart < 0 || span.charEnd > textLength) return undefined;
    if (!Number.isFinite(span.startMs) || span.startMs < 0) return undefined;
    if (span.endMs !== undefined && (!Number.isFinite(span.endMs) || span.endMs < 0)) {
      return undefined;
    }

    // A zero-length span carries no highlight; an end-of-utterance marker is
    // expected to produce one, so it is dropped rather than treated as an error.
    if (span.charEnd <= span.charStart) continue;

    const startMs = Math.min(span.startMs, durationMs);
    if (startMs < previousStartMs) return undefined;
    previousStartMs = startMs;

    const rawEndMs = span.endMs ?? durationMs;
    const endMs = Math.min(Math.max(rawEndMs, startMs), durationMs);

    const charEnd = trimTrailingSpace(text, span.charStart, span.charEnd);
    if (charEnd <= span.charStart) continue;

    timings.push({ charStart: span.charStart, charEnd, startMs, endMs });
  }

  return timings.length > 0 ? timings : undefined;
}

/**
 * Pull `charEnd` back over the whitespace that separates this word from the
 * next, so the highlight covers the word and not the gap after it.
 */
function trimTrailingSpace(text: string, charStart: number, charEnd: number): number {
  let end = charEnd;
  while (end > charStart && isWhitespace(text.charAt(end - 1))) end--;
  return end;
}

function isWhitespace(char: string): boolean {
  return char.length > 0 && char.trim().length === 0;
}
