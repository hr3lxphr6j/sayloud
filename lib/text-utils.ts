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

function isWordChar(char: string): boolean {
  return /[\p{L}\p{N}]/u.test(char);
}

/**
 * Whether one code point carries no readable text.
 *
 * PDF text is not clean text: when a ToUnicode table fails to map a glyph,
 * PDFium emits the raw glyph id (a C0 control character) or an arbitrary
 * ideograph, and a truncated UTF-16 pair leaves a lone surrogate behind. None
 * of them is a word, yet `Intl.Segmenter` happily treats any of them as a
 * boundary — that is how one PDF line turned into "sentences" made of
 * `\u0010` and `⭠`.
 *
 * - C0 controls, except tab, newline and carriage return (layout markers).
 * - CJK Extension A (`U+3400`–`U+4DBF`) and B–F (`U+20000`–`U+2FA1F`): where
 *   PDFium's ToUnicode fallbacks land when they fail. The trade-off is that a
 *   genuinely rare character from these planes (a personal name) is dropped
 *   with them; ordinary Han, kana and hangul are untouched.
 * - A lone surrogate: half of a UTF-16 pair, never a character.
 */
function isUnreadableCodePoint(code: number): boolean {
  // A valid surrogate pair arrives as a single code point above `0xFFFF`, so
  // any surrogate that shows up on its own is half of a broken pair.
  if (code >= 0xd800 && code <= 0xdfff) return true;
  if (code < 0x20) return code !== 0x09 && code !== 0x0a && code !== 0x0d;
  if (code >= 0x3400 && code <= 0x4dbf) return true;
  return code >= 0x20000 && code <= 0x2fa1f;
}

/**
 * Drop the characters PDF text carries but no reader can read.
 *
 * Applied by the PDF text layer before a block's text reaches the viewer, so a
 * highlight range never has to point at a glyph id, and again inside
 * {@link segmentSentences} so a stray control character cannot hide the line
 * wrap's CJK neighbour. Idempotent, so applying it twice is harmless.
 */
export function cleanPdfText(text: string): string {
  let cleaned = '';
  for (const char of text) {
    if (!isUnreadableCodePoint(char.codePointAt(0) ?? 0)) cleaned += char;
  }
  return cleaned;
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
  return prepareLineBreaks(identityPrepared(text)).text;
}

/** One-to-one source mapping, for the string-only entry points below. */
function identityPrepared(text: string): PreparedText {
  return {
    text,
    start: Array.from({ length: text.length }, (_, index) => index),
    end: Array.from({ length: text.length }, (_, index) => index + 1),
  };
}

/** {@link cleanPdfText} as a pipeline stage: a dropped character leaves a hole. */
function prepareCleanText(prepared: PreparedText): PreparedText {
  const { text } = prepared;
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  const push = (char: string, start: number, end: number): void => {
    chars.push(char);
    starts.push(start);
    ends.push(end);
  };

  let index = 0;
  while (index < text.length) {
    const code = text.codePointAt(index) ?? 0;
    const char = String.fromCodePoint(code);
    if (!isUnreadableCodePoint(code)) {
      for (let unit = 0; unit < char.length; unit++) {
        const at = index + unit;
        push(char.charAt(unit), prepared.start[at] ?? at, prepared.end[at] ?? at + 1);
      }
    }
    index += char.length;
  }

  return { text: chars.join(''), start: starts, end: ends };
}

function prepareLineBreaks(prepared: PreparedText): PreparedText {
  const source = prepared.text;
  const chars: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];

  const push = (char: string, start: number, end: number): void => {
    chars.push(char);
    starts.push(start);
    ends.push(end);
  };

  /** Source span covering `[from, to)` of the prepared text. */
  const span = (from: number, to: number): [number, number] => [
    prepared.start[from] ?? from,
    prepared.end[Math.min(to, prepared.end.length) - 1] ?? to,
  ];

  /** Push `char` standing for `[from, to)` of the prepared text. */
  const pushSpan = (char: string, from: number, to: number): void => {
    const [start, end] = span(from, to);
    push(char, start, end);
  };

  let index = 0;
  while (index < source.length) {
    const char = source.charAt(index);
    if (char !== '\n' && char !== '\r') {
      pushSpan(char, index, index + 1);
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
      pushSpan('\n', index, index + 1);
      pushSpan('\n', Math.min(index + 1, runEnd - 1), runEnd);
      index = runEnd;
      continue;
    }

    // A soft wrap. Skip the indentation the next line starts with.
    let next = runEnd;
    while (next < source.length && WHITESPACE.test(source.charAt(next))) next += 1;

    const before = lastNonSpace(chars);
    const after = source.charAt(next);
    if (!(isCjkChar(before) && isCjkChar(after)) && chars[chars.length - 1] !== ' ') {
      pushSpan(' ', index, runEnd);
    }
    index = next;
  }

  return { text: chars.join(''), start: starts, end: ends };
}

/** Tokens masking punctuation that must not be a sentence boundary. */
const DOT_TOKEN = '_DOT_';
const TIME_TOKEN = '_TIME_';
const LIST_TOKEN = '_LIST_';
const ABBR_TOKEN = '_ABBR_';

/**
 * Abbreviations whose dot belongs to the word, not to a sentence end.
 *
 * `Inc.`, `Ltd.` and `etc.` are deliberately absent: they routinely close a
 * sentence (`Apple Inc. The company…`), so masking them would glue two
 * sentences together — the opposite of what this function is for.
 */
const ABBREVIATIONS = new Set([
  // Titles, always followed by a name.
  'Mr',
  'Mrs',
  'Ms',
  'Dr',
  'Prof',
  'St',
  'Jr',
  'Sr',
  'Mt',
  'Ft',
  // References, usually followed by a number or a name.
  'Fig',
  'fig',
  'Eq',
  'eq',
  'No',
  'Vol',
  'vol',
  'Ch',
  'ch',
  'Sec',
  'sec',
  // Latin short forms.
  'p',
  'pp',
  'vs',
  'al',
  'e.g',
  'i.e',
]);

/**
 * Mask the punctuation splitters mistake for sentence ends.
 *
 * - `v1.2.3`, `3.14` and `12:45`: a dot between two digits is the
 *   decimal/version separator and a colon between two digits is a clock, so
 *   neither may end a sentence (`_DOT_`, `_TIME_`).
 * - `1. item` at the start of a line: a list number, not a sentence
 *   (`_LIST_`). Only the dot is masked, so restore stays exact and the token
 *   still stands for a single source character.
 * - `Dr.`, `Fig. 3`, `U.S.`, `O. Anqiao`: the dot belongs to the word
 *   (`_ABBR_`).
 *
 * Every token is word-joining, which keeps it in one piece for rule-based
 * splitters; {@link restoreSpecialNumbers} puts the punctuation back.
 */
export function protectSpecialNumbers(text: string): string {
  return prepareSpecialNumbers(identityPrepared(text)).text;
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
      char === '.'
        ? dotToken(text, index)
        : char === ':' && isDigit(text.charAt(index - 1)) && isDigit(text.charAt(index + 1))
          ? TIME_TOKEN
          : null;

    // Every mask replaces a single punctuation mark, so all of its characters
    // map to that mark's source span; a boundary before or after the token
    // still maps back to the source.
    const start = prepared.start[index] ?? index;
    const end = prepared.end[index] ?? index + 1;

    if (token === null) {
      push(char, start, end);
      continue;
    }

    for (const masked of token) push(masked, start, end);
  }

  return { text: chars.join(''), start: starts, end: ends };
}

function dotToken(text: string, index: number): string | null {
  if (isDigit(text.charAt(index - 1)) && isDigit(text.charAt(index + 1))) return DOT_TOKEN;
  if (isListMarkerDot(text, index)) return LIST_TOKEN;
  if (isAbbreviationDot(text, index)) return ABBR_TOKEN;
  return null;
}

/**
 * `1. item` on a line of its own is a list number, not a sentence end.
 *
 * The anchor is the line, not the string, and this runs before
 * {@link mergeLineBreaks} folds soft wraps away — so a list that shares one
 * block still has every item start a line. A `1.` mid-line is left alone
 * (`The answer is 1. Next…` really is two sentences), and a dot with digits on
 * both sides (`1.5`) was already masked as a decimal.
 */
function isListMarkerDot(text: string, index: number): boolean {
  const lineStart = text.lastIndexOf('\n', index - 1) + 1;
  // Three digits and some indentation is as long as a marker gets; the cap
  // keeps a long line from being sliced once per dot.
  if (index - lineStart > 12) return false;
  if (!/^[ \t]*\d{1,3}$/.test(text.slice(lineStart, index))) return false;
  const after = text.charAt(index + 1);
  return after === '' || WHITESPACE.test(after);
}

/** The word ending right before `index`, or null when there is none. */
function wordEndingAt(text: string, index: number): string | null {
  const MAX = 8;
  let start = index;
  while (start > 0 && index - start < MAX && /[A-Za-z.]/.test(text.charAt(start - 1))) start -= 1;
  const word = text.slice(start, index);
  if (word.length === 0) return null;
  // A word cut off by the length cap is not this word.
  if (start > 0 && /[A-Za-z.]/.test(text.charAt(start - 1))) return null;
  return word;
}

/**
 * `Dr.`, `Fig. 3`, `U.S.` and `O. Anqiao` do not end a sentence at the dot.
 *
 * Two shapes are recognised: a known abbreviation, and an initial — a single
 * capital that *opens* a name, or a chain of them. A capital that closes a
 * word (`NASA.`) is a sentence end and is left to the splitter.
 */
function isAbbreviationDot(text: string, index: number): boolean {
  const word = wordEndingAt(text, index);
  if (word !== null && ABBREVIATIONS.has(word)) return true;

  const letter = text.charAt(index - 1);
  if (letter < 'A' || letter > 'Z') return false;
  if (isWordChar(text.charAt(index - 2))) return false;

  const after = text.charAt(index + 1);
  if (after === '' || WHITESPACE.test(after)) return true;
  // `U.S.` / `J.R.R.`: the next initial has to be one too, dot included.
  return after >= 'A' && after <= 'Z' && text.charAt(index + 2) === '.';
}

/** Undo {@link protectSpecialNumbers}: every token is a plain `.` or `:`. */
export function restoreSpecialNumbers(text: string): string {
  return text
    .split(DOT_TOKEN)
    .join('.')
    .split(TIME_TOKEN)
    .join(':')
    .split(LIST_TOKEN)
    .join('.')
    .split(ABBR_TOKEN)
    .join('.');
}

/**
 * Split text into sentences, keeping offsets into the original string.
 *
 * The pipeline is: drop unreadable characters, mask punctuation that is not a
 * boundary, join soft line breaks, let `Intl.Segmenter` decide the boundaries,
 * then map those boundaries back to the source. `start[i]`/`end[i]` above are
 * why every step can rewrite the text without losing the exact `[start, end)`
 * span: callers highlight with `text.slice(start, end)`, which stays
 * character-for-character the input text (including a `\n` inside a sentence
 * that spanned a line wrap — speech engines collapse whitespace anyway).
 *
 * Cleaning comes first: a glyph-id control character sitting on a line wrap
 * would make the wrap look like a Latin boundary. Masking comes before the
 * wrap is merged, otherwise a list marker loses the line start that identifies
 * it.
 */
export function segmentSentences(text: string, lang: string): Segment[] {
  const prepared = prepareLineBreaks(
    prepareSpecialNumbers(prepareCleanText(identityPrepared(text)))
  );
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
