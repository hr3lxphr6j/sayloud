//! Roman numerals in the contexts that disambiguate them.
//!
//! Upstream's `Roman` rule is not in the default pipeline because a bare `IV`
//! or `MIX` is ambiguous. Ours keeps only the key-word branch, so the tests are
//! as much about what *does not* fire as about what does: `MIX`, `DC`, `IV` and
//! `Louis XIV` must keep their old readings, and `Will I go` must not become
//! "Will the first".
//!
//! The gate is part of this stage. A single capital `V` is not a capital run, so
//! `Chapter V` never reached the grammar until `needs_normalization` learned the
//! key words; `Chapter IV` worked by accident because `IV` is a run.

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

#[test]
fn key_words_read_the_numeral() {
    for (text, expected) in [
        ("Chapter IV", "fˈɔːɹ"),         // four
        ("Chapter V", "fˈaɪv"),          // five — the gate case
        ("Chapter VIII", "ˈeɪt"),        // eight
        ("Super Bowl LVIII", "fˈɪftiː"), // fifty…
    ] {
        let Some(result) = english(text) else {
            return;
        };
        assert!(
            result.phonemes.contains(expected),
            "{text:?} must read the numeral: {:?}",
            result.phonemes
        );
    }

    // …and the second half of LVIII.
    let Some(lviii) = english("Super Bowl LVIII") else {
        return;
    };
    assert!(lviii.phonemes.contains("ˈeɪt"), "{:?}", lviii.phonemes);
}

#[test]
fn a_bare_roman_numeral_keeps_its_old_reading() {
    // Upstream's third branch reads `IV` as four and `MIX` as 1009. Ours must
    // not: these are a letter run and a word.
    for (text, expected) in [
        ("IV", "aɪ"),
        ("MIX", "ˈɛm"),
        ("DC", "dˈiː"),
        ("Louis XIV", "ˈɛks"),
        ("Will I go", "wɪl"),
    ] {
        let Some(result) = english(text) else {
            return;
        };
        assert!(
            result.phonemes.contains(expected),
            "{text:?} must keep its old reading: {:?}",
            result.phonemes
        );
    }

    // The `names` branch would turn this into "Will the first"; ours cannot.
    let Some(will) = english("Will I go") else {
        return;
    };
    assert!(
        !will.phonemes.contains("fˈɜːst"),
        "`Will I go` must not be an ordinal: {:?}",
        will.phonemes
    );
}

#[test]
fn the_pronoun_i_is_not_a_roman_numeral() {
    // The key words are exactly the contexts where a Roman numeral is meant;
    // a common noun followed by `I` is a relative clause, not a numeral.
    for (text, expected) in [("the act I saw", "aɪ"), ("at table C", "sˈiː")] {
        let Some(result) = english(text) else {
            return;
        };
        assert!(
            result.phonemes.contains(expected),
            "{text:?} must keep its old reading: {:?}",
            result.phonemes
        );
        assert!(
            !result.phonemes.contains("wˈʌn") && !result.phonemes.contains("hˈʌndɹəd"),
            "{text:?} must not invent a numeral: {:?}",
            result.phonemes
        );
    }
}

#[test]
fn prose_with_a_key_word_is_untouched() {
    // A key word with no numeral after it must not turn the sentence into a
    // reason to run the grammar (the gate) or change a reading.
    let Some(book) = english("a book on the table") else {
        return;
    };
    assert!(book.phonemes.contains("bˈʊk"), "{:?}", book.phonemes);
    let Some(neck) = english("I have a V neck") else {
        return;
    };
    assert!(neck.phonemes.contains("vˈiː"), "{:?}", neck.phonemes);
}
