/**
 * Digits to their Chinese reading (spec §3.11.7 step 1).
 *
 * This has to happen *before* phonemization, and it has to happen here rather
 * than in the provider adapter: `pinyin-pro` reads Han characters, so a digit
 * that is still a digit is not phonemized at all — it simply vanishes from the
 * IPA. That failure is silent (the number is not heard, nothing is thrown),
 * which is why the verification round found it by listening rather than by
 * testing.
 *
 * Language-specific on purpose: this is the *Chinese* reading of a numeral.
 * English numbers stay digits and are read by espeak, so a shared text-layer
 * normaliser would break English to fix Chinese.
 *
 * Known gaps, all deliberate:
 * - `1,234` is read as 一,二百三十四 — a thousands separator is punctuation, and
 *   the comma is also a sentence pause, so it cannot be removed globally.
 * - `-5` reads as 五; the minus sign is not in Kokoro's punctuation set.
 * - `2024` reads as 二千零二十四, not the more natural 二零二四 for a year.
 *   Choosing between them needs context this layer does not have (spec §3.11.7).
 */

import { toHalfWidth } from './common';

const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'] as const;

/** Unit for each four-digit group, from the lowest. */
const GROUP_UNITS = ['', '万', '亿', '万亿'] as const;

/** Unit for each position inside a four-digit group: thousands, hundreds, tens, ones. */
const PLACE_UNITS = ['千', '百', '十', ''] as const;

/** Where the tens place sits in a four-digit group. */
const TENS = 2;

/** The digit with this value, or nothing if it is not a digit at all. */
function hanDigit(digit: number): string {
  return DIGITS[digit] ?? '';
}

/**
 * The reading of one four-digit group, e.g. `2024` -> 二千零二十四.
 *
 * `isLeading` says this is the highest group of the number, which is the only
 * place the 一 of 一十 is dropped: 15 is 十五 and 100000 is 十万, but 100015 is
 * 十万零一十五 — the 一 survives once something precedes it.
 */
function groupToHan(value: number, isLeading: boolean): string {
  const digits = String(value).padStart(4, '0');
  let out = '';
  let pendingZero = false;

  for (let i = 0; i < 4; i += 1) {
    const digit = Number(digits.charAt(i));
    if (digit === 0) {
      // A zero only matters between two non-zero digits; leading and trailing
      // ones are dropped, and a run of them collapses to one 零.
      if (out !== '') pendingZero = true;
      continue;
    }
    if (pendingZero) {
      out += DIGITS[0];
      pendingZero = false;
    }
    if (isLeading && out === '' && i === TENS && digit === 1) {
      out += PLACE_UNITS[i];
      continue;
    }
    out += hanDigit(digit) + (PLACE_UNITS[i] ?? '');
  }

  return out;
}

function groupedToHan(value: number): string {
  if (value === 0) return DIGITS[0];

  const groups: number[] = [];
  for (let rest = value; rest > 0; rest = Math.floor(rest / 10000)) {
    groups.push(rest % 10000);
  }

  let out = '';
  for (let i = groups.length - 1; i >= 0; i -= 1) {
    const group = groups[i] ?? 0;
    if (group === 0) {
      if (out !== '' && !out.endsWith(DIGITS[0])) out += DIGITS[0];
      continue;
    }
    // A group that does not fill its thousands place leaves a gap the reader
    // has to hear: 一万零一. One that does, does not: 一万二千.
    if (out !== '' && group < 1000 && !out.endsWith(DIGITS[0])) out += DIGITS[0];
    out += groupToHan(group, out === '') + (GROUP_UNITS[i] ?? '');
  }

  return out.replace(/零+$/, '');
}

/**
 * The Chinese reading of a run of digits.
 *
 * Takes the digits as text rather than as a number so a value too large for a
 * double is read digit by digit instead of being rounded into a different
 * number.
 */
export function intToHan(raw: string): string {
  const digits = raw.replace(/^0+(?=\d)/, '');
  if (digits === '') return DIGITS[0];

  // Past 2^53 the group arithmetic would silently lose digits, so fall back to
  // reading them one at a time. Not the natural reading of a huge numeral, but
  // it is the number that was written.
  if (digits.length > 15) return [...digits].map((digit) => hanDigit(Number(digit))).join('');

  return groupedToHan(Number(digits));
}

/** A fractional part is always read digit by digit: 15.6 is 十五点六. */
function decimalToHan(digits: string): string {
  return [...digits].map((digit) => hanDigit(Number(digit))).join('');
}

/**
 * Replace every numeral in `text` with the Chinese words for it.
 *
 * Order matters and is longest-pattern-first: a percentage with a decimal has
 * to be consumed before the plain decimal rule, or `15.6%` would be read as
 * 十五点六% and the percent sign would then be dropped as punctuation.
 */
export function numbersToHan(text: string): string {
  return toHalfWidth(text)
    .replace(/(\d+)\.(\d+)%/g, (_, whole: string, fraction: string) => {
      return `百分之${intToHan(whole)}点${decimalToHan(fraction)}`;
    })
    .replace(/(\d+)%/g, (_, whole: string) => `百分之${intToHan(whole)}`)
    .replace(/(\d+)\.(\d+)/g, (_, whole: string, fraction: string) => {
      return `${intToHan(whole)}点${decimalToHan(fraction)}`;
    })
    .replace(/(\d+)/g, (_, whole: string) => intToHan(whole));
}
