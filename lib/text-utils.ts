export function normalizeText(text: string): string {
  return text.replace(/\s+/g, ' ').trim().normalize('NFC');
}

/** True when `Intl.Segmenter` accepts the tag, so callers can fall back safely. */
export function isSupportedLang(lang: string): boolean {
  if (!lang) return false;
  try {
    new Intl.Segmenter(lang, { granularity: 'sentence' });
    return true;
  } catch {
    return false;
  }
}

export interface Segment {
  text: string;
  start: number;
  end: number;
}

/**
 * A rewritten string plus, per character, the source range it stands for.
 *
 * `Intl.Segmenter` has to see text the user never typed verbatim: a PDF line
 * wrap disappears between two CJK characters, and `3.14` is masked so no
 * splitter can break it at the dot. Both rewrite the string, yet consumers
 * slice the *source* with `[start, end)`, so each prepared character keeps the
 * source range it came from.
 */
interface PreparedText {
  text: string;
  /** `start[i]` is the first source index prepared character `i` covers. */
  start: number[];
  /** `end[i]` is one past the last source index prepared character `i` covers. */
  end: number[];
}

const WHITESPACE = /\s/;

/**
 * Han, kana, hangul and CJK punctuation.
 *
 * Only these scripts drop a line break outright: they are written without word
 * spaces, so a wrap is not a word boundary. Anything else (Latin, digits) needs
 * a space where the newline was, otherwise `Hello\nworld` would read as one
 * word.
 */
const CJK_CHAR =
  /[\u1100-\u11FF\u2E80-\u303F\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u{20000}-\u{2FA1F}]/u;

function isCjkChar(char: string): boolean {
  return char.length > 0 && CJK_CHAR.test(char);
}

function isDigit(char: string): boolean {
  return char >= '0' && char <= '9';
}

function lastNonSpace(chars: readonly string[]): string {
  for (let index = chars.length - 1; index >= 0; index--) {
    const char = chars[index];
    if (char !== undefined && char !== ' ') return char;
  }
  return '';
}

/**
 * Join the layout lines of a paragraph.
 *
 * PDF text arrives one string per rendered line, joined with a single `\n`
 * (`lib/pdf/embed/blocks.ts`), and a paragraph break is already a separate
 * block. So a single newline is a *soft wrap*: dropping it is what keeps
 * `第一行\n第二行` as one sentence instead of two. A run of two or more
 * newlines is a real paragraph break and survives, so `Intl.Segmenter` still
 * ends the sentence there.
 *
 * Latin text keeps a space at the wrap, because `Hello\nworld` are two words.
 * The rewrite is length-changing, so callers that need source offsets use
 * {@link prepareLineBreaks} instead of this string-only view.
 */
export function mergeLineBreaks(text: string): string {
  return prepareLineBreaks(text).text;
}

function prepareLineBreaks(source: string): PreparedText {
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  const push = (char: string, start: number, end: number): void => {
    chars.push(char);
    starts.push(start);
    ends.push(end);
  };

  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char !== '\n' && char !== '\r') {
      push(char, index, index + 1);
      index += 1;
      continue;
    }

    // Consume the whole run, counting `\r\n` as one break.
    let runEnd = index;
    let breaks = 0;
    while (runEnd < source.length) {
      const current = source.charAt(runEnd);
      if (current !== '\n' && current !== '\r') break;
      runEnd += current === '\r' && source.charAt(runEnd + 1) === '\n' ? 2 : 1;
      breaks += 1;
    }

    if (breaks > 1) {
      // Paragraph break: keep two newlines, which is what ends a sentence.
      push('\n', index, index + 1);
      push('\n', Math.min(index + 1, runEnd - 1), runEnd);
      index = runEnd;
      continue;
    }

    // A soft wrap. Skip the indentation the next line starts with.
    let next = runEnd;
    while (next < source.length && WHITESPACE.test(source.charAt(next))) next += 1;

    const before = lastNonSpace(chars);
    const after = source.charAt(next);
    if (!(isCjkChar(before) && isCjkChar(after)) && chars[chars.length - 1] !== ' ') {
      push(' ', index, runEnd);
    }
    index = next;
  }

  return { text: chars.join(''), start: starts, end: ends };
}

/** Tokens masking punctuation that must not be a sentence boundary. */
const DOT_TOKEN = '_DOT_';
const TIME_TOKEN = '_TIME_';

/**
 * Mask the dots and colons that splitters mistake for sentence ends.
 *
 * `v1.2.3`, `3.14` and `12:45` are one token each; a dot between two digits is
 * the decimal/version separator and a colon between two digits is a clock, so
 * neither may end a sentence. `_DOT_`/`_TIME_` are word-joining, which keeps
 * the number in one piece for rule-based splitters; {@link
 * restoreSpecialNumbers} puts the punctuation back.
 */
export function protectSpecialNumbers(text: string): string {
  return prepareSpecialNumbers({
    text,
    start: Array.from({ length: text.length }, (_, index) => index),
    end: Array.from({ length: text.length }, (_, index) => index + 1),
  }).text;
}

function prepareSpecialNumbers(prepared: PreparedText): PreparedText {
  const { text } = prepared;
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  const push = (char: string, start: number, end: number): void => {
    chars.push(char);
    starts.push(start);
    ends.push(end);
  };

  for (let index = 0; index < text.length; index++) {
    const char = text.charAt(index);
    const token =
      char === '.' && isDigit(text.charAt(index - 1)) && isDigit(text.charAt(index + 1))
        ? DOT_TOKEN
        : char === ':' && isDigit(text.charAt(index - 1)) && isDigit(text.charAt(index + 1))
          ? TIME_TOKEN
          : null;

    if (token === null) {
      push(char, prepared.start[index] ?? index, prepared.end[index] ?? index + 1);
      continue;
    }

    // Every masked character stands for the one punctuation mark it replaced,
    // so a boundary before or after the token still maps to the source.
    const start = prepared.start[index] ?? index;
    const end = prepared.end[index] ?? index + 1;
    for (const masked of token) push(masked, start, end);
  }

  return { text: chars.join(''), start: starts, end: ends };
}

/** Undo {@link protectSpecialNumbers}: `_DOT_` → `.`, `_TIME_` → `:`. */
export function restoreSpecialNumbers(text: string): string {
  return text.split(DOT_TOKEN).join('.').split(TIME_TOKEN).join(':');
}

/**
 * Split text into sentences, keeping offsets into the original string.
 *
 * The pipeline is: join soft line breaks, mask numbers, let
 * `Intl.Segmenter` decide the boundaries, then map those boundaries back to
 * the source. `start[i]`/`end[i]` above are why all three steps can rewrite
 * the text without losing the exact `[start, end)` span: callers highlight
 * with `text.slice(start, end)`, which stays character-for-character the
 * input text (including a `\n` inside a sentence that spanned a line wrap —
 * speech engines collapse whitespace anyway).
 */
export function segmentSentences(text: string, lang: string): Segment[] {
  const prepared = prepareSpecialNumbers(prepareLineBreaks(text));
  const seg = new Intl.Segmenter(lang, { granularity: 'sentence' });
  const segments: Segment[] = [];

  for (const part of seg.segment(prepared.text)) {
    // `Intl.Segmenter` keeps trailing whitespace inside a sentence, so trim it
    // here; the offsets are then taken from the source spans, never guessed.
    let first = part.index;
    let last = part.index + part.segment.length;
    while (first < last && WHITESPACE.test(prepared.text.charAt(first))) first += 1;
    while (last > first && WHITESPACE.test(prepared.text.charAt(last - 1))) last -= 1;
    if (first >= last) continue;

    const start = prepared.start[first] ?? 0;
    const end = prepared.end[last - 1] ?? start;
    const sentence = text.slice(start, end);
    if (sentence.trim().length === 0) continue;
    segments.push({ text: sentence, start, end });
  }

  return segments;
}

export function segmentWords(text: string, lang: string): Segment[] {
  const seg = new Intl.Segmenter(lang, { granularity: 'word' });
  return Array.from(seg.segment(text))
    .filter((s) => s.isWordLike)
    .map((s) => ({ text: s.segment, start: s.index, end: s.index + s.segment.length }));
}
