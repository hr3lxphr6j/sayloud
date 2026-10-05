//! Japanese numeral normalization.
//!
//! Mirrors `lib/models/phonemize/japanese-numbers.ts`, and has to happen before
//! segmentation for the same two reasons it does there:
//!
//! 1. **A digit that is still a digit is not spoken at all.** `segment_text`
//!    classifies it `other`, and the `other` branch keeps only punctuation, so
//!    the number vanishes from the IPA with nothing thrown.
//! 2. **Where the digits sit changes how their neighbours read.** Splitting
//!    `2022` into its own run leaves 「年」 alone in front of the dictionary,
//!    which reads it とし; inside 「二十二年」 it reads ネン. So digits become
//!    *kanji*, which keeps them in the same Han run as the kanji around them.
//!
//! Reading them as kanji rather than kana also means the reading comes from the
//! dictionary rather than from this module — except for the five sound changes
//! in [`crate::g2p::ja::ipa::fix_numeral_sound_changes`], which the
//! dictionary does not make.
//!
//! The known gaps are the ones the JavaScript documents and this keeps: `1,234`
//! reads as 一,二百三十四 (the separator is also a sentence pause, so it cannot
//! be removed globally), `-5` reads as 五, a year reads as a quantity (2024 is
//! 二千二十四, not にーぜろにーよん), and 1000万 reads センマン where the
//! language prefers イッセンマン.

use crate::text::to_half_width;

const DIGITS: [char; 10] = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/// The unit for each four-digit group, from the lowest.
const GROUP_UNITS: [char; 5] = ['\0', '万', '億', '兆', '京'];

/// The unit for each position inside a four-digit group: thousands, hundreds,
/// tens, ones.
const PLACE_UNITS: [char; 4] = ['千', '百', '十', '\0'];

/// The digit with this value, or nothing if it is not a digit at all.
fn kanji_digit(digit: u32) -> char {
    DIGITS.get(digit as usize).copied().unwrap_or('\0')
}

/// The reading of one four-digit group, e.g. `2022` → 二千二十二.
///
/// No placeholder is written for a zero: 101 is 百一. That is how Japanese
/// numerals are written, and it is also what keeps the reading intact — the
/// dictionary does not know 〇 (it returns it unchanged, to be dropped as
/// punctuation later), so a filler character would take the number with it.
fn group_to_kanji(value: u32) -> String {
    let digits: Vec<u32> = (0..4)
        .map(|shift| (value / 10u32.pow(3 - shift)) % 10)
        .collect();

    let mut out = String::new();
    for (position, digit) in digits.iter().copied().enumerate() {
        if digit == 0 {
            continue;
        }

        // 十/百/千 drop a leading 一 — 1000 is 千, not 一千 — while 万/億/兆 keep
        // theirs, so 10000 is 一万 and not 万.
        let is_place_unit = position < PLACE_UNITS.len() - 1;
        if digit == 1 && is_place_unit {
            out.push(PLACE_UNITS[position]);
        } else {
            out.push(kanji_digit(digit));
            // The ones position has no unit, which is the empty string in the
            // JavaScript table and `\0` here — pushing the sentinel would put a
            // NUL in the middle of the phoneme string.
            if is_place_unit {
                out.push(PLACE_UNITS[position]);
            }
        }
    }

    out
}

/// A whole number of up to fifteen digits, in groups of four.
fn grouped_to_kanji(value: u64) -> String {
    if value == 0 {
        return DIGITS[0].to_string();
    }

    let mut groups = Vec::new();
    let mut rest = value;
    while rest > 0 {
        groups.push((rest % 10_000) as u32);
        rest /= 10_000;
    }

    let mut out = String::new();
    for index in (0..groups.len()).rev() {
        let group = groups[index];
        // An empty group is skipped rather than written out: 一万一, not 一万零一.
        if group == 0 {
            continue;
        }
        out.push_str(&group_to_kanji(group));
        if let Some(unit) = GROUP_UNITS.get(index) {
            if *unit != '\0' {
                out.push(*unit);
            }
        }
    }

    out
}

/// The Japanese reading of a run of digits.
///
/// Takes the digits as text rather than as a number so a value too large for a
/// double is read digit by digit instead of being rounded into a different
/// number.
pub fn int_to_kanji(raw: &str) -> String {
    let trimmed = raw.trim_start_matches('0');
    // `^0+(?=\d)` keeps one digit, so "000" is 零 rather than nothing.
    let digits = if trimmed.is_empty() { "0" } else { trimmed };

    // Past fifteen digits the group arithmetic would need more than 64 bits, and
    // the JavaScript gives up at the same point for the same reason (2^53).
    // Reading them one at a time is not the natural reading of a huge numeral,
    // but it is the number that was written.
    if digits.len() > 15 {
        return digits
            .chars()
            .map(|ch| kanji_digit(ch as u32 - '0' as u32))
            .collect();
    }

    grouped_to_kanji(digits.parse::<u64>().unwrap_or(0))
}

/// A fractional part is always read digit by digit: 15.6 is 十五点六.
fn decimal_to_kanji(digits: &str) -> String {
    digits
        .chars()
        .map(|ch| kanji_digit(ch as u32 - '0' as u32))
        .collect()
}

/// Replace every numeral in `text` with the Japanese words for it.
///
/// The JavaScript applies four regex passes in longest-match-first order. This
/// is one left-to-right scan instead, which is the same function: every
/// replacement contains no ASCII digits, so no later rule can match inside an
/// earlier rule's output, and checking the fraction and the percent sign
/// greedily at each digit run is exactly what "longest pattern first" buys.
pub fn numbers_to_kanji(text: &str) -> String {
    let chars: Vec<char> = to_half_width(text).chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;

    while index < chars.len() {
        if !chars[index].is_ascii_digit() {
            out.push(chars[index]);
            index += 1;
            continue;
        }

        let start = index;
        while index < chars.len() && chars[index].is_ascii_digit() {
            index += 1;
        }
        let whole: String = chars[start..index].iter().collect();

        // A fraction needs at least one digit after the point; `15.` keeps its
        // point and the 15 is read on its own.
        let mut fraction = String::new();
        if index + 1 < chars.len() && chars[index] == '.' && chars[index + 1].is_ascii_digit() {
            index += 1;
            let fraction_start = index;
            while index < chars.len() && chars[index].is_ascii_digit() {
                index += 1;
            }
            fraction = chars[fraction_start..index].iter().collect();
        }

        out.push_str(&int_to_kanji(&whole));
        if !fraction.is_empty() {
            out.push('点');
            out.push_str(&decimal_to_kanji(&fraction));
        }

        // The percent sign only counts when it follows immediately, which is
        // what `(\d+)\.(\d+)%` and `(\d+)%` require.
        if index < chars.len() && chars[index] == '%' {
            out.push_str("パーセント");
            index += 1;
        }
    }

    out
}
