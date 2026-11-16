//! Character canonicalisation and the unread-text invariant.
//!
//! Two behaviours are pinned here, both of them end-to-end because both were
//! found end-to-end:
//!
//! - **whitespace runs.** `I  have 3 cats.` used to phonemize to `aɪ hæv kˈæts.`
//!   The grammar has no path for a double space, the engine returned the text
//!   unchanged, and the digit was then dropped as an `Other` run. The canonical
//!   pass collapses the run before the engine sees it.
//! - **the characters no reader can pronounce**, folded before the engine:
//!   ligatures, sub/superscripts, circled numbers, Roman code points, the minus
//!   sign, half-width kana.
//!
//! The fallback is pinned too: what the engine still does not read is spelled
//! rather than dropped. `§3.2` was that test's example — the one shape with no
//! grammar path at all — until the section rule read it; the test now
//! asserts the reading exists and that `tn-no-path` no longer fires for it.

mod common;

use common::{
    chinese_options, chinese_phonemizer, english_options, english_phonemizer, japanese_options,
    japanese_phonemizer,
};
use phonemize::{PhonemizeOptions, PhonemizeResult, Phonemizer};

/// One sentence through a prepared phonemizer, or `None` when the dictionaries
/// are absent (the same skip the other pipeline tests use).
fn phonemize(
    phonemizer: Option<Phonemizer>,
    options: &PhonemizeOptions,
    text: &str,
) -> Option<PhonemizeResult> {
    let phonemizer = phonemizer?;
    Some(
        phonemizer
            .phonemize_with(text, options)
            .unwrap_or_else(|error| panic!("{text:?}: {error}")),
    )
}

fn english(text: &str) -> Option<PhonemizeResult> {
    phonemize(english_phonemizer(), &english_options(), text)
}

#[test]
fn double_spaces_no_longer_swallow_the_number() {
    let Some(with_run) = english("I  have 3 cats.") else {
        return;
    };
    // The bug: `aɪ hæv kˈæts.` — the 3 was dropped when the engine gave up.
    assert!(
        with_run.phonemes.contains("θɹˈiː"),
        "the 3 must be read: {:?}",
        with_run.phonemes
    );
    assert!(with_run.warnings.is_empty(), "{:?}", with_run.warnings);

    // A single space is the unchanged path.
    let Some(single) = english("I have 3 cats.") else {
        return;
    };
    assert_eq!(single.phonemes, with_run.phonemes);
}

#[test]
fn ligature_survives_as_a_word() {
    let Some(result) = english("The ﬁle is here.") else {
        return;
    };
    // It used to be `ðə lə ɪz hˈiːɹ.`: the ligature split the run and `le` was
    // all the dictionary saw.
    assert!(
        result.phonemes.contains("fˈaɪl"),
        "ﬁle must read as file: {:?}",
        result.phonemes
    );
}

#[test]
fn subscripts_and_roman_and_circled_are_read() {
    let Some(water) = english("Water is H₂O.") else {
        return;
    };
    assert!(
        water.phonemes.contains("tˈuː"),
        "H₂O must say two: {:?}",
        water.phonemes
    );

    let Some(roman) = english("Ⅳ is four.") else {
        return;
    };
    assert!(
        roman.phonemes.contains("fˈɔːɹ"),
        "Ⅳ must read as four: {:?}",
        roman.phonemes
    );

    let Some(circled) = english("①②") else {
        return;
    };
    assert!(
        circled.phonemes.contains("wˈʌn") && circled.phonemes.contains("tˈuː"),
        "①② must be one two, not twelve: {:?}",
        circled.phonemes
    );

    let Some(minus) = english("It is −5 degrees.") else {
        return;
    };
    assert!(
        minus.phonemes.contains("fˈaɪv"),
        "−5 must keep the number: {:?}",
        minus.phonemes
    );

    let Some(squared) = english("x² and 10³") else {
        return;
    };
    assert!(
        squared.phonemes.contains("skwˈɛɹd") && squared.phonemes.contains("kjˈuːbd"),
        "x²/10³ must be squared/cubed: {:?}",
        squared.phonemes
    );
}

#[test]
fn halfwidth_kana_is_composed() {
    let Some(result) = phonemize(japanese_phonemizer(), &japanese_options(), "ｶﾞｷﾞ") else {
        return;
    };
    assert!(
        result.phonemes.contains("ɡa") && result.phonemes.contains("ɡi"),
        "ｶﾞｷﾞ must be ガギ: {:?}",
        result.phonemes
    );
}

#[test]
fn chinese_circled_and_digits_are_read() {
    let Some(result) = phonemize(chinese_phonemizer(), &chinese_options(), "① 是数字") else {
        return;
    };
    assert!(
        result.phonemes.contains("i→"),
        "① must read as 一: {:?}",
        result.phonemes
    );

    let Some(three) = phonemize(chinese_phonemizer(), &chinese_options(), "3个") else {
        return;
    };
    assert!(
        three.phonemes.contains("sa"),
        "3个 must read as 三个: {:?}",
        three.phonemes
    );
}

#[test]
fn a_fraction_glyph_reaches_the_grammar() {
    // `½` is not an ASCII digit, so before the gate learned it the whole
    // sentence was skipped and `keep_punctuation` dropped the glyph: "a cup".
    let Some(result) = english("Add ½ cup of milk.") else {
        return;
    };
    assert!(
        result.phonemes.contains("hˈæf"),
        "½ must read as \"half\": {:?}",
        result.phonemes
    );
}

#[test]
fn a_pathless_shape_no_longer_has_to_be_reported() {
    // This test used to pin the *absence* of a grammar path: `§3.2` was the one
    // shape the tagger could not join, so the engine returned the sentence
    // unchanged and the invariant said `tn-no-path` while spelling the digits.
    // `rules/en_section.py` reads it, so the assertion has flipped:
    // the shape is read, and the warning that used to accompany it must not fire.
    // The reporting path itself is still covered by
    // [`a_surviving_symbol_is_reported`] for symbols, and `§3.2` is pinned as
    // words in `shapes_and_grouping.rs`.
    let Some(result) = english("See §3.2 of the spec.") else {
        return;
    };

    assert!(
        !result
            .warnings
            .iter()
            .any(|warning| warning.starts_with("tn-no-path")),
        "§3.2 has a grammar path now: {:?}",
        result.warnings
    );
    assert!(
        result.phonemes.contains("sˈɛkʃən"),
        "section must be said: {:?}",
        result.phonemes
    );
    // The digits are read by the rule rather than spelled by the invariant.
    assert!(
        result.phonemes.contains("θɹˈiː") && result.phonemes.contains("tˈuː"),
        "3 and 2 must be audible: {:?}",
        result.phonemes
    );
}

#[test]
fn a_surviving_symbol_is_reported() {
    // `±` used to stand for this, but the symbol rule reads it; `¢` is still unread.
    let Some(result) = english("It is ¢ 5.") else {
        return;
    };
    assert!(
        result
            .warnings
            .iter()
            .any(|warning| warning.starts_with("unread-symbol")),
        "¢ has no reading and must say so: {:?}",
        result.warnings
    );
}
