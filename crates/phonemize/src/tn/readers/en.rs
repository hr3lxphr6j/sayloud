//! English numeral normalization.
//!
//! The English counterpart of [`crate::tn::readers::ja`], and it runs in the
//! same place for the same reason: **a digit that is still a digit is not spoken
//! at all.** `segment_text` classifies it `other`, the `other` branch keeps only
//! punctuation, and the number leaves the IPA with nothing thrown — measured
//! before this module existed, `I have 3 cats` → `aɪ hæv kˈæts`, the 3 gone.
//!
//! The JavaScript side never needed this. It hands English text to espeak-ng,
//! which reads a numeral out itself; this side hands Latin runs to the CMU
//! Pronouncing Dictionary, which is a dictionary and not a rule engine, so a
//! digit has no pronunciation to find. Reading the numeral here is what lets a
//! whole English sentence produce the same phonemes as the JavaScript one — and
//! it is why phase 4 could wire the Latin runs of a Japanese sentence but not a
//! whole English one (see the comment on the `_` arm in `lib.rs`).
//!
//! Reading them as *words* rather than as digits also keeps a numeral in the
//! same Latin run as the text around it, so it is read as part of the sentence
//! instead of as a run of its own.
//!
//! # Why a crate for this
//!
//! [`num2words`] rather than a hand-written table, because the awkward part is
//! not 0–19 — it is everything else: 1001 gaining an "and", 999 losing it, a
//! minus sign, a decimal point, and the magnitude names past a billion. The
//! crate is MIT OR Apache-2.0, has no C and no filesystem, and costs ~152 KB in
//! the release wasm. The alternative that also covers Chinese, `num2words2-core`, was measured at
//! 2.7 MB and rejected for that reason — the Chinese reading already exists in
//! `numbers.rs`.
//!
//! # Known gaps
//!
//! The ones [`crate::tn::readers::ja`] documents, plus two of its own:
//!
//! - `1,000` reads as `one,zero`: the separator is punctuation, and the comma is
//!   also a sentence pause, so it cannot be removed globally. The Japanese side
//!   has the same gap with a different wrong answer (一,二百三十四).
//! - A percent sign is dropped rather than read (15.6% is 十五点六パーセント in
//!   Japanese, `fifteen point six%` here). Nothing needs it yet.
//!
//! A year reads as a quantity — 2024 is "two thousand and twenty-four", not
//! "twenty twenty-four" — which is the same choice `numbers.rs` makes and for
//! the same reason: telling a year from a count needs context this layer does
//! not have.
//!
//! Note one difference from the Japanese module rather than a gap: a negative
//! number is read out here (`-42` → "minus forty-two"), because the minus sign
//! is ASCII and is handled with the digits instead of being left behind.

use num2words::{Lang, Num2Words};

/// The English word for one digit, for the fractional part.
///
/// A fraction is always read digit by digit — 3.14 is "three point one four",
/// not "three point fourteen" — and it is the point that decides that, not the
/// length of the fraction.
fn digit_to_english(digit: char) -> String {
    Num2Words::new(digit.to_digit(10).unwrap_or(0) as i64)
        .lang(Lang::English)
        .to_words()
        // Unreachable: every digit 0–9 has a word. Written out rather than
        // `expect`ed because a panic inside the wasm takes the whole worker with
        // it, and a digit read as itself is a smaller failure than that.
        .unwrap_or_else(|_| digit.to_string())
}

/// The English reading of a run of ASCII digits, and of its sign.
///
/// Takes the digits as text rather than as a number so a value too large for an
/// `i64` is left as it was instead of being read as a different number — the
/// same trade `int_to_kanji` makes past fifteen digits, decided the other way
/// round: a huge numeral is rare enough that leaving the digits in place is
/// better than inventing a reading for it.
fn int_to_english(digits: &str, negative: bool) -> String {
    match digits.parse::<i64>() {
        Ok(value) => {
            // `digits` has no sign of its own, so this cannot overflow: the
            // largest value that parses is `i64::MAX`, whose negation fits.
            let value = if negative { -value } else { value };
            Num2Words::new(value)
                .lang(Lang::English)
                .to_words()
                .unwrap_or_else(|_| digits.to_string())
        }
        Err(_) => {
            if negative {
                format!("-{digits}")
            } else {
                digits.to_string()
            }
        }
    }
}

/// Replace every numeral in `text` with the English words for it.
///
/// Handles integers (0 up to `i64::MAX`), negative integers, and decimal
/// fractions. Only ASCII digits are matched, so full-width digits have to be
/// normalized earlier, the way `to_half_width` does for the Japanese side.
///
/// A `-` belongs to the number only when a digit follows it, which is what tells
/// `-5` from the hyphen in `well-known`.
pub fn numbers_to_english(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len() * 2);
    let mut index = 0;

    while index < chars.len() {
        let negative =
            chars[index] == '-' && index + 1 < chars.len() && chars[index + 1].is_ascii_digit();
        if negative {
            index += 1;
        }

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
        // point and the 15 is read on its own, which is the rule the Japanese
        // module follows as well.
        let mut fraction = String::new();
        if index + 1 < chars.len() && chars[index] == '.' && chars[index + 1].is_ascii_digit() {
            index += 1;
            let fraction_start = index;
            while index < chars.len() && chars[index].is_ascii_digit() {
                index += 1;
            }
            fraction = chars[fraction_start..index].iter().collect();
        }

        out.push_str(&int_to_english(&whole, negative));

        if !fraction.is_empty() {
            out.push_str(" point");
            for digit in fraction.chars() {
                out.push(' ');
                out.push_str(&digit_to_english(digit));
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_zero() {
        assert_eq!(numbers_to_english("0"), "zero");
    }

    #[test]
    fn converts_three() {
        assert_eq!(numbers_to_english("3"), "three");
    }

    #[test]
    fn converts_in_sentence() {
        assert_eq!(numbers_to_english("I have 3 cats"), "I have three cats");
    }

    #[test]
    fn converts_decimal() {
        assert_eq!(numbers_to_english("3.14"), "three point one four");
    }

    #[test]
    fn converts_negative() {
        assert_eq!(numbers_to_english("-42"), "minus forty-two");
    }

    #[test]
    fn converts_large() {
        assert_eq!(numbers_to_english("1000"), "one thousand");
    }

    #[test]
    fn leaves_non_digit_alone() {
        assert_eq!(numbers_to_english("hello"), "hello");
    }

    #[test]
    fn multiple_numbers() {
        assert_eq!(
            numbers_to_english("2 cats and 3 dogs"),
            "two cats and three dogs"
        );
    }

    #[test]
    fn year() {
        assert_eq!(numbers_to_english("2024"), "two thousand and twenty-four");
    }

    #[test]
    fn keeps_a_hyphen_that_is_not_a_sign() {
        // The rule the function documents: `-` belongs to the number only when a
        // digit follows it. `well-known` is one word, not "minus known".
        assert_eq!(numbers_to_english("well-known"), "well-known");
        assert_eq!(numbers_to_english("-"), "-");
    }

    #[test]
    fn leaves_a_numeral_too_large_for_an_i64_as_digits() {
        // Past `i64::MAX` there is no reading to give it, and reading it as a
        // *different* number — which parsing to `0` on failure would do — is
        // worse than leaving the digits where they are. Not reachable from real
        // text; the branch exists so that a 20-digit run cannot come out as
        // "zero".
        assert_eq!(
            numbers_to_english("99999999999999999999"),
            "99999999999999999999"
        );
        assert_eq!(
            numbers_to_english("-99999999999999999999"),
            "-99999999999999999999"
        );
    }
}
