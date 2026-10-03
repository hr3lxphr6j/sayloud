/**
 * Digits to their Japanese reading.
 *
 * This has to happen *before* phonemization, for the same two reasons it does in
 * Chinese (`numbers.ts`), and the first of them is what a user reported:
 *
 * 1. **A digit that is still a digit is not spoken at all.** `segmentText`
 *    classifies it as `other`, and the `other` branch keeps only punctuation, so
 *    the number vanishes from the IPA. Nothing is thrown — the text simply comes
 *    out shorter than it went in.
 * 2. **Where the digits sit changes how their neighbours read.** Splitting
 *    `2022` off into its own run leaves 「年」 alone in front of kuroshiro, which
 *    reads it とし; inside 「二十二年」 it reads ネン. So the digits are turned
 *    into kanji rather than kana: that keeps them in the same Han run as the
 *    kanji around them, and kuroshiro sees the whole numeral as one word.
 *
 * Kanji rather than kana also means the reading comes from the dictionary rather
 * than from this file — except for the five sound changes in `japanese.ts`, which
 * kuromoji does not make.
 *
 * Japanese writes numerals differently from Chinese in two ways worth naming,
 * because copying the Chinese implementation would get both wrong:
 * - No 零 is written for an empty place: 10001 is 一万一, not 一万零一.
 * - A leading 一 is dropped before 十/百/千 (1000 is 千) but kept before the group
 *   units (10000 is 一万).
 *
 * Known gaps, all deliberate:
 * - `1,234` is read as 一,二百三十四 — the separator is punctuation, and the
 *   comma is also a sentence pause, so it cannot be removed globally.
 * - `-5` reads as 五; the minus sign is not in Kokoro's punctuation set.
 * - A year reads as the quantity: 2024 is 二千二十四, not にーぜろにーよん.
 *   Choosing between them needs context this layer does not have.
 * - 1000万 reads センマン where the language prefers イッセンマン; the 促音 that
 *   kuromoji drops is not in the sound-change table either.
 */

import { toHalfWidth } from './common';

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

/** Unit for each four-digit group, from the lowest. */
const GROUP_UNITS = ['', '万', '億', '兆', '京'] as const;

/** Unit for each position inside a four-digit group: thousands, hundreds, tens, ones. */
const PLACE_UNITS = ['千', '百', '十', ''] as const;

/** The digit with this value, or nothing if it is not a digit at all. */
function kanjiDigit(digit: number): string {
  return DIGITS[digit] ?? '';
}

/**
 * The reading of one four-digit group, e.g. `2022` -> 二千二十二.
 *
 * No placeholder is written for a zero: 101 is 百一. That is how Japanese
 * numerals are written, and it is also what keeps the reading intact — kuromoji
 * does not know 〇 (it returns it unchanged, to be dropped as punctuation later),
 * so a filler character would take the number with it.
 */
function groupToKanji(value: number): string {
  const digits = String(value).padStart(4, '0');
  let out = '';

  for (let i = 0; i < 4; i += 1) {
    const digit = Number(digits.charAt(i));
    if (digit === 0) continue;

    // 十/百/千 drop a leading 一 — 1000 is 千, not 一千 — while 万/億/兆 keep
    // theirs, so 10000 is 一万 and not 万.
    const isPlaceUnit = i < PLACE_UNITS.length - 1;
    if (digit === 1 && isPlaceUnit) out += PLACE_UNITS[i];
    else out += kanjiDigit(digit) + PLACE_UNITS[i];
  }

  return out;
}

function groupedToKanji(value: number): string {
  if (value === 0) return DIGITS[0];

  const groups: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 10000)) {
    groups.push(rest % 10000);
  }

  let out = '';
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i] ?? 0;
    // An empty group is skipped rather than written out: 一万一, not 一万零一.
    if (group === 0) continue;
    out += groupToKanji(group) + (GROUP_UNITS[i] ?? '');
  }

  return out;
}

/**
 * The Japanese reading of a run of digits.
 *
 * Takes the digits as text rather than as a number so a value too large for a
 * double is read digit by digit instead of being rounded into a different
 * number.
 */
export function intToKanji(raw: string): string {
  const digits = raw.replace(/^0+(?=\d)/, '');
  if (digits === '') return DIGITS[0];

  // Past 2^53 the group arithmetic would silently lose digits, so fall back to
  // reading them one at a time. Not the natural reading of a huge numeral, but
  // it is the number that was written.
  if (digits.length > 15) return [...digits].map((digit) => kanjiDigit(Number(digit))).join('');

  return groupedToKanji(Number(digits));
}

/** A fractional part is always read digit by digit: 15.6 is 十五点六. */
function decimalToKanji(digits: string): string {
  return [...digits].map((digit) => kanjiDigit(Number(digit))).join('');
}

/**
 * Replace every numeral in `text` with the Japanese words for it.
 *
 * Order matters and is longest-pattern-first, the same as the Chinese version: a
 * percentage with a decimal has to be consumed before the plain decimal rule, or
 * `15.6%` would keep its percent sign and lose it to the punctuation filter.
 */
export function numbersToKanji(text: string): string {
  return toHalfWidth(text)
    .replace(
      /(\d+)\.(\d+)%/g,
      (_, whole: string, fraction: string) =>
        `${intToKanji(whole)}点${decimalToKanji(fraction)}パーセント`
    )
    .replace(/(\d+)%/g, (_, whole: string) => `${intToKanji(whole)}パーセント`)
    .replace(
      /(\d+)\.(\d+)/g,
      (_, whole: string, fraction: string) => `${intToKanji(whole)}点${decimalToKanji(fraction)}`
    )
    .replace(/(\d+)/g, (_, whole: string) => intToKanji(whole));
}
