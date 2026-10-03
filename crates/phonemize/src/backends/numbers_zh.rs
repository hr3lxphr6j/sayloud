//! Chinese numeral normalization.
//!
//! Mirrors `lib/models/phonemize/numbers.ts`, and has to happen before anything
//! else looks at the text for the reason that file records: `pinyin-pro` reads
//! Han characters, so a digit that is still a digit is not phonemized at all —
//! it simply vanishes from the IPA. That failure is silent (the number is not
//! heard and nothing is thrown), which is why it was found by listening rather
//! than by a test.
//!
//! Language-specific on purpose: this is the *Chinese* reading of a numeral.
//! English numbers become words through [`numbers_to_english`] and Japanese ones
//! through [`numbers_to_kanji`], so a shared text-layer normaliser would break
//! two languages to fix a third.
//!
//! # Why this is four passes and not one
//!
//! The JavaScript is four chained `replace` calls with different patterns, and
//! the order is load-bearing in a way that is easy to miss: `15.6%` has to be
//! consumed by the percentage rule before the plain decimal rule sees it, or the
//! percent sign is left over and then dropped as punctuation — the number is
//! read as 十五点六 and the *hundred* is lost.
//!
//! Reproducing the passes rather than writing one scanner is not pedantry. One
//! left-to-right pass that decides per digit run what it is looking at gets
//! `1.2.3%` wrong: it reads 一点二 and then 百分之三, where the chained patterns
//! read 一.百分之二点三 — the second rule starts scanning again from the
//! beginning, so it finds the `2.3%` that the first rule had already walked past.
//! [`replace`] is one pass per pattern, in the same order, and
//! `reproduces_the_chained_pattern_order` pins that case.
//!
//! # Known gaps, all deliberate
//!
//! They are `numbers.ts`'s, and this keeps them rather than quietly fixing them,
//! because the two sides have to agree before either can be changed:
//!
//! - `1,234` is read as 一,二百三十四 — a thousands separator is punctuation, and
//!   the comma is also a sentence pause, so it cannot be removed globally.
//! - `-5` reads as 五; the minus sign is not in Kokoro's punctuation set.
//! - `2024` reads as 二千零二十四, not the more natural 二零二四 for a year.
//!   Choosing between them needs context this layer does not have.
//! - A full-width `％` is not a percent sign to this code, because
//!   [`to_half_width`] only rewrites digits. `15％` therefore reads as 十五 and
//!   loses the 百, exactly as it does in JavaScript.

use crate::text::to_half_width;

const DIGITS: [char; 10] = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

/// The unit for each four-digit group, from the lowest.
///
/// Four entries, not five: [`int_to_han`] falls back to reading digit by digit
/// past 15 characters, so the highest group index it can reach is 3. That bound
/// is also what keeps the `f64` arithmetic out of this file — 15 digits fit in a
/// `u64` exactly, and `grouped_to_han` never has to reproduce `Number`'s rounding.
const GROUP_UNITS: [&str; 4] = ["", "万", "亿", "万亿"];

/// The unit for each position inside a four-digit group: thousands, hundreds,
/// tens, ones.
const PLACE_UNITS: [&str; 4] = ["千", "百", "十", ""];

/// Where the tens place sits in a four-digit group.
const TENS: usize = 2;

/// The digit with this value, or nothing if it is not a digit at all.
fn han_digit(digit: u32) -> char {
    DIGITS.get(digit as usize).copied().unwrap_or('\0')
}

/// The reading of one four-digit group, e.g. `2024` → 二千零二十四.
///
/// `is_leading` says this is the highest group of the number, which is the only
/// place the 一 of 一十 is dropped: 15 is 十五 and 100000 is 十万, but 100015 is
/// 十万零一十五 — the 一 survives once something precedes it.
fn group_to_han(value: u32, is_leading: bool) -> String {
    let digits: Vec<u32> = (0..4)
        .map(|shift| (value / 10u32.pow(3 - shift)) % 10)
        .collect();

    let mut out = String::new();
    let mut pending_zero = false;

    for (position, digit) in digits.iter().copied().enumerate() {
        if digit == 0 {
            // A zero only matters between two non-zero digits; leading and
            // trailing ones are dropped, and a run of them collapses to one 零.
            if !out.is_empty() {
                pending_zero = true;
            }
            continue;
        }
        if pending_zero {
            out.push(DIGITS[0]);
            pending_zero = false;
        }
        if is_leading && out.is_empty() && position == TENS && digit == 1 {
            out.push_str(PLACE_UNITS[position]);
            continue;
        }
        out.push(han_digit(digit));
        out.push_str(PLACE_UNITS[position]);
    }

    out
}

/// A whole number's reading, in groups of four digits.
fn grouped_to_han(value: u64) -> String {
    if value == 0 {
        return DIGITS[0].to_string();
    }

    let mut groups: Vec<u32> = Vec::new();
    let mut rest = value;
    while rest > 0 {
        groups.push((rest % 10_000) as u32);
        rest /= 10_000;
    }

    let mut out = String::new();
    for index in (0..groups.len()).rev() {
        let group = groups[index];
        if group == 0 {
            // A whole empty group is one 零, and only if something came before
            // it — 一亿零一 needs it, 一亿 does not.
            if !out.is_empty() && !out.ends_with(DIGITS[0]) {
                out.push(DIGITS[0]);
            }
            continue;
        }
        // A group that does not fill its thousands place leaves a gap the reader
        // has to hear: 一万零一. One that does, does not: 一万二千.
        if !out.is_empty() && group < 1000 && !out.ends_with(DIGITS[0]) {
            out.push(DIGITS[0]);
        }
        out.push_str(&group_to_han(group, out.is_empty()));
        out.push_str(GROUP_UNITS[index]);
    }

    while out.ends_with(DIGITS[0]) {
        out.pop();
    }

    out
}

/// The Chinese reading of a run of digits.
///
/// Takes the digits as text rather than as a number so a value too large for the
/// arithmetic is read digit by digit instead of being rounded into a different
/// number. `numbers.ts` makes the same call at 15 characters, which is where a
/// `double` stops being exact; a `u64` is exact further than that, but the bound
/// is kept identical so the two read the same number the same way.
pub fn int_to_han(raw: &str) -> String {
    // `raw.replace(/^0+(?=\d)/, '')`: leading zeros go, but the last digit never
    // does, so `0`, `00` and `000` all read 零 rather than nothing.
    let digits = raw.trim_start_matches('0');
    if digits.is_empty() {
        return DIGITS[0].to_string();
    }

    if digits.chars().count() > 15 {
        return digits
            .chars()
            .map(|digit| han_digit(digit as u32 - '0' as u32))
            .collect();
    }

    match digits.parse::<u64>() {
        Ok(value) => grouped_to_han(value),
        // Unreachable: 15 ASCII digits always fit in a `u64`. Read digit by digit
        // rather than panicking, because a panic inside the wasm takes the whole
        // worker with it and there is a correct answer available.
        Err(_) => digits
            .chars()
            .map(|digit| han_digit(digit as u32 - '0' as u32))
            .collect(),
    }
}

/// A fractional part is always read digit by digit: 15.6 is 十五点六.
fn decimal_to_han(digits: &str) -> String {
    digits
        .chars()
        .map(|digit| han_digit(digit as u32 - '0' as u32))
        .collect()
}

/// Which pattern a pass is looking for.
///
/// The four patterns of `numbersToHan`, in the order they are applied there.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Shape {
    /// `(\d+)\.(\d+)%`
    PercentDecimal,
    /// `(\d+)%`
    Percent,
    /// `(\d+)\.(\d+)`
    Decimal,
    /// `(\d+)`
    Integer,
}

/// One pass, replacing every match of one pattern.
///
/// A maximal digit run is either a match — extended by a fraction and a percent
/// sign as the shape requires — or it goes through untouched and the scan resumes
/// **just after the digits**. That resume point is what makes one pass equivalent
/// to a regular expression's "advance one position and try again": every pattern
/// here needs a character that is not a digit immediately after the digits it
/// matched, so no shorter prefix of the same run can match either. Resuming after
/// the whole run therefore skips only positions that could not have matched.
fn replace(text: &str, shape: Shape, reading: impl Fn(&str, Option<&str>) -> String) -> String {
    let characters: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut at = 0;

    while at < characters.len() {
        if !characters[at].is_ascii_digit() {
            out.push(characters[at]);
            at += 1;
            continue;
        }

        let whole_start = at;
        while at < characters.len() && characters[at].is_ascii_digit() {
            at += 1;
        }
        let after_whole = at;
        let whole: String = characters[whole_start..after_whole].iter().collect();

        let wants_fraction = matches!(shape, Shape::PercentDecimal | Shape::Decimal);
        let mut fraction: Option<String> = None;
        let mut after_fraction = after_whole;
        if wants_fraction && at < characters.len() && characters[at] == '.' {
            let first = at + 1;
            let mut end = first;
            while end < characters.len() && characters[end].is_ascii_digit() {
                end += 1;
            }
            // `\d+`, so one digit is enough and none is no match.
            if end > first {
                fraction = Some(characters[first..end].iter().collect());
                after_fraction = end;
            }
        }

        let wants_percent = matches!(shape, Shape::PercentDecimal | Shape::Percent);
        let percent = wants_percent && characters.get(after_fraction) == Some(&'%');

        let matched = match shape {
            Shape::Integer => true,
            Shape::Decimal => fraction.is_some(),
            Shape::Percent => percent,
            Shape::PercentDecimal => fraction.is_some() && percent,
        };

        if matched {
            out.push_str(&reading(&whole, fraction.as_deref()));
            at = if percent {
                after_fraction + 1
            } else {
                after_fraction
            };
        } else {
            // No match. The digits are emitted as they were, and the scan resumes
            // after them — *not* after the fraction, which was only a lookahead
            // and belongs to whatever pattern comes next.
            out.push_str(&whole);
            at = after_whole;
        }
    }

    out
}

/// Replace every numeral in `text` with the Chinese words for it.
///
/// The four passes run in `numbers.ts`'s order, longest pattern first: a
/// percentage with a decimal has to be consumed before the plain decimal rule, or
/// `15.6%` would be read as 十五点六% and the percent sign would then be dropped
/// as punctuation.
pub fn numbers_to_han(text: &str) -> String {
    let text = to_half_width(text);

    let text = replace(&text, Shape::PercentDecimal, |whole, fraction| {
        format!(
            "百分之{}点{}",
            int_to_han(whole),
            decimal_to_han(fraction.unwrap_or_default())
        )
    });
    let text = replace(&text, Shape::Percent, |whole, _| {
        format!("百分之{}", int_to_han(whole))
    });
    let text = replace(&text, Shape::Decimal, |whole, fraction| {
        format!(
            "{}点{}",
            int_to_han(whole),
            decimal_to_han(fraction.unwrap_or_default())
        )
    });
    replace(&text, Shape::Integer, |whole, _| int_to_han(whole))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Every expectation here is `numbers.ts`'s, either from its docstring or
    /// from running it — the two sides are compared wholesale by
    /// `tests/zh_pipeline.rs` as well, but a divergence is much easier to read
    /// when the failing case has a name.
    #[test]
    fn reads_small_numbers() {
        assert_eq!(numbers_to_han("0"), "零");
        assert_eq!(numbers_to_han("3"), "三");
        assert_eq!(numbers_to_han("10"), "十");
        assert_eq!(numbers_to_han("11"), "十一");
        assert_eq!(numbers_to_han("15"), "十五");
        assert_eq!(numbers_to_han("20"), "二十");
        assert_eq!(numbers_to_han("101"), "一百零一");
        assert_eq!(numbers_to_han("110"), "一百一十");
        assert_eq!(numbers_to_han("123"), "一百二十三");
    }

    #[test]
    fn drops_a_leading_one_only_at_the_top() {
        // The 一 of 一十 goes only when nothing precedes it: 15 is 十五, 100015
        // is 十万零一十五.
        assert_eq!(int_to_han("100000"), "十万");
        assert_eq!(int_to_han("100015"), "十万零一十五");
        assert_eq!(int_to_han("15"), "十五");
    }

    #[test]
    fn reads_grouped_numbers() {
        assert_eq!(int_to_han("2024"), "二千零二十四");
        assert_eq!(int_to_han("10001"), "一万零一");
        assert_eq!(int_to_han("12000"), "一万二千");
        assert_eq!(
            int_to_han("1234567890"),
            "十二亿三千四百五十六万七千八百九十"
        );
    }

    #[test]
    fn reads_a_value_past_the_exact_arithmetic_digit_by_digit() {
        // 16 digits, one past the bound `numbers.ts` sets at 15. Reading it as a
        // number would round it into a different number; reading it digit by
        // digit at least says what was written.
        assert_eq!(
            int_to_han("1234567890123456"),
            "一二三四五六七八九零一二三四五六"
        );
    }

    #[test]
    fn keeps_the_last_digit_of_a_run_of_zeros() {
        // `^0+(?=\d)` needs a digit to be left behind, so `00` is 零 and not
        // nothing — a number that is not spoken is the failure this whole module
        // exists to prevent.
        assert_eq!(int_to_han("0"), "零");
        assert_eq!(int_to_han("00"), "零");
        assert_eq!(int_to_han(""), "零");
        assert_eq!(int_to_han("0012"), "十二");
    }

    #[test]
    fn reads_decimals_digit_by_digit() {
        assert_eq!(numbers_to_han("3.14"), "三点一四");
        assert_eq!(numbers_to_han("15.6"), "十五点六");
        // A trailing point is not a decimal: `\d+` needs a digit after it.
        assert_eq!(numbers_to_han("15."), "十五.");
    }

    #[test]
    fn reads_percentages_as_hundredths() {
        assert_eq!(numbers_to_han("50%"), "百分之五十");
        assert_eq!(numbers_to_han("15.6%"), "百分之十五点六");
        // A percent sign with no digits in front of it is left for the
        // punctuation filter, which drops it.
        assert_eq!(numbers_to_han("abc%"), "abc%");
    }

    #[test]
    fn reproduces_the_chained_pattern_order() {
        // The case a single left-to-right scanner gets wrong. The percentage rule
        // starts scanning again from the beginning after the decimal rule has
        // already walked past `2.3%`, so it finds it — one pass would have read
        // 一点二 and then 百分之三.
        assert_eq!(numbers_to_han("1.2.3%"), "一.百分之二点三");
        // And the same shape without the percent sign stays a decimal plus a
        // leftover digit, which the integer pass then reads.
        assert_eq!(numbers_to_han("1.2.3"), "一点二.三");
    }

    #[test]
    fn reads_numbers_inside_text() {
        assert_eq!(numbers_to_han("你好123世界"), "你好一百二十三世界");
        assert_eq!(numbers_to_han("价格是123.45元"), "价格是一百二十三点四五元");
    }

    #[test]
    fn rewrites_full_width_digits_first() {
        // Without `to_half_width` a full-width digit is not a digit to any of the
        // patterns, and the number is dropped by the punctuation filter — silent,
        // which is the failure mode this module exists for.
        assert_eq!(numbers_to_han("２０２２年"), "二千零二十二年");
        assert_eq!(numbers_to_han("１２３"), "一百二十三");
    }

    #[test]
    fn leaves_a_full_width_percent_sign_alone() {
        // `to_half_width` rewrites digits only, so `％` is not a percent sign
        // here. `numbers.ts` has the same gap, and the two have to agree before
        // either can be fixed — this test is the record of that agreement.
        assert_eq!(numbers_to_han("15％"), "十五％");
    }

    #[test]
    fn reads_a_thousands_separator_as_punctuation() {
        // A documented gap: the comma is also a sentence pause, so it cannot be
        // removed globally, and `1,234` reads as 一,二百三十四.
        assert_eq!(numbers_to_han("1,234"), "一,二百三十四");
    }
}
