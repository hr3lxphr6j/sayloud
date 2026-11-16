//! Money with cents, and the symbols upstream does not read.
//!
//! Upstream reads `$20.50` as "twenty point five dollars": every fractional part
//! is a decimal. `MoneyCents` runs beside it and matches only the shape money is
//! actually written in — a known minor unit and exactly two fractional digits,
//! not `00` — so `$1.5`, `$1.2320`, `$1.2 million` and `¥1200.50` keep the
//! upstream reading.
//!
//! The symbol half is smaller: `÷ ≈ ± ≠ ≤ ≥ ∞ √ ∑ ∏ ∫` were dropped by
//! `keep_punctuation`. They are single characters with one phrase each, so they
//! are a string map and not a rule with context.

mod common;

use common::{english_options, english_phonemizer};
use phonemize::PhonemizeResult;

fn english(text: &str) -> Option<PhonemizeResult> {
    let phonemizer = english_phonemizer()?;
    Some(
        phonemizer
            .phonemize_with(text, &english_options())
            .unwrap_or_else(|error| panic!("{text:?}: {error}")),
    )
}

fn assert_reads(text: &str, expected: &[&str]) {
    let Some(result) = english(text) else {
        return;
    };
    for needle in expected {
        assert!(
            result.phonemes.contains(needle),
            "{text:?} must contain {needle:?}: {:?}",
            result.phonemes
        );
    }
}

#[test]
fn cents_are_read_as_cents() {
    assert_reads(
        "$20.50",
        &["twˈɛntiː", "dˈɑlɚz", "ənd", "fˈɪftiː", "sˈɛnts"],
    );
    assert_reads("$1.50", &["wˈʌn", "dˈɑlɚ", "ənd", "fˈɪftiː", "sˈɛnts"]);
    assert_reads("$1.01", &["wˈʌn", "sˈɛnt"]);
    assert_reads("$1.10", &["tˈɛn", "sˈɛnts"]);
    assert_reads("€20.50", &["jˈuːɹoʊz", "sˈɛnts"]);
    assert_reads("£1.50", &["pˈaʊnd", "pˈɛns"]);
    assert_reads("US$20.50", &["ʌs", "dˈɑlɚz", "sˈɛnts"]);
    assert_reads("$1,234.50", &["θˈaʊzənd", "dˈɑlɚz", "sˈɛnts"]);
}

#[test]
fn zero_dollars_are_not_said() {
    let Some(result) = english("$0.05") else {
        return;
    };
    assert!(result.phonemes.contains("fˈaɪv"), "{:?}", result.phonemes);
    assert!(
        !result.phonemes.contains("zˈɪɹoʊ"),
        "a zero-dollar amount must not say zero: {:?}",
        result.phonemes
    );
    let Some(half) = english("$0.50") else {
        return;
    };
    assert!(!half.phonemes.contains("zˈɪɹoʊ"), "{:?}", half.phonemes);
}

#[test]
fn the_shapes_upstream_owns_are_untouched() {
    // One fractional digit: a decimal, not cents.
    assert_reads("$1.5", &["pˈɔɪnt"]);
    // Four digits, and a quantity.
    assert_reads("$1.2320", &["pˈɔɪnt", "tˈuː"]);
    assert_reads("$1.2 million", &["mˈɪljən"]);
    // No minor unit for yen.
    assert_reads("¥1200.50", &["jˈɛn", "pˈɔɪnt"]);
    // A whole-dollar amount: upstream's zero fraction.
    let Some(whole) = english("$1.00") else {
        return;
    };
    assert!(
        whole.phonemes.contains("wˈʌn dˈɑlɚ"),
        "{:?}",
        whole.phonemes
    );
    assert!(!whole.phonemes.contains("sˈɛnts"), "{:?}", whole.phonemes);
}

#[test]
fn symbols_are_spoken() {
    assert_reads("It is 4 ÷ 2.", &["dɪvˈaɪdəd", "baɪ"]);
    assert_reads("It is 4 ≈ 5.", &["əbaʊt"]);
    assert_reads("It is ± 5.", &["plˈʌs", "ɔːɹ", "mˈaɪnəs"]);
    assert_reads("x ≠ y", &["nɑt", "ˈiːkwəl"]);
    assert_reads("a ≤ b", &["lˈɛs", "ðæn"]);
    assert_reads("∞", &["ɪnfˈɪnətiː"]);
    assert_reads("√ 9", &["skwˈɛɹ", "ɹˈuːt"]);
}

#[test]
fn a_symbol_without_a_digit_still_reaches_the_grammar() {
    // No digit and no capital run: this sentence used to be skipped by the
    // gate, so the symbol was dropped without the rule ever running.
    assert_reads("a ± b", &["plˈʌs", "mˈaɪnəs"]);
}
