//! The 1,000-1,999 range reads its leading "one".
//!
//! Upstream's `Cardinal.build_tagger` builds a replacement graph that rewrites
//! "one thousand" to "thousand" at weight -0.0001, so the shortened reading wins
//! for `1,234` and for everything that goes through the shared `Cardinal` —
//! `Decimal` (`1,234.5`), `Money` (`$1,234`) and the cents rule beside it
//! (`$1,234.50`). `tools/fst-build/rules/en_cardinal.py` carries the same method
//! with that one sign flipped, and `build.py` rebinds the class before any
//! normalizer is built, so all five consumers get the fixed graph.
//!
//! Asserted on the words rather than the phonemes: `θˈaʊzənd` would pass on a
//! reading that lost "one" in a place this test cannot see, and the words are
//! what a diff makes legible. `1000` without a comma, in `a_bare_year_is_left_alone`,
//! is the one that must *not* change: it is the grammar's year reading, a genuine
//! tie upstream, and fixing it is not this stage's job.
//!
//! The fix used to be a post-process in `tn/mod.rs`. Nothing here would have
//! caught its absence before, because the post-process ran on whatever the
//! engine said — these assertions are on the engine, so a rebuild that lost the
//! weight flip fails here rather than being papered over downstream.

mod common;

use common::{english_options, english_phonemizer, wetext_fsts, WETEXT_EN_NAMES};
use phonemize::tn;

/// The English engine, built straight from the shipped grammars.
///
/// For the word assertions: the pipeline returns phonemes, and the point of this
/// stage is which *words* the grammar produced.
fn engine() -> Option<tn::Normalizer> {
    let fsts = wetext_fsts(WETEXT_EN_NAMES)?;
    let borrowed: Vec<&[u8]> = fsts.iter().map(|bytes| bytes.as_slice()).collect();
    Some(tn::english(borrowed[0], borrowed[1], borrowed[2]).expect("the FSTs parse"))
}

fn read(text: &str) -> Option<String> {
    let normalized = engine()?
        .normalize(text)
        .unwrap_or_else(|error| panic!("{text:?} normalizes: {error}"));
    Some(normalized)
}

#[test]
fn one_thousand_keeps_its_one() {
    for (text, expected) in [
        // The bug itself, and the range it covers.
        ("1,234", "one thousand two hundred and thirty four"),
        ("1,000", "one thousand"),
        ("1,500", "one thousand five hundred"),
        ("1,999", "one thousand nine hundred and ninety nine"),
        // A leading "one" that was never the problem: the bug is on the *first*
        // group only, and this row is the control that the fix is not a
        // blanket prefix.
        ("11,234", "eleven thousand two hundred and thirty four"),
        // The four ways the shared instance is reached: `Decimal`, upstream's
        // `Money`, the cents rule, and `Measure` (which never had the bug —
        // it reads `graph_with_and`).
        (
            "1,234.5",
            "one thousand two hundred and thirty four point five",
        ),
        ("$1,234", "one thousand two hundred and thirty four dollars"),
        (
            "$1,234.50",
            "one thousand two hundred and thirty four dollars and fifty cents",
        ),
        (
            "1,234 kg",
            "one thousand two hundred and thirty four kilograms",
        ),
        // Already right, and still right: `2,000` starts at "two".
        ("2,000", "two thousand"),
    ] {
        assert_eq!(read(text).as_deref(), Some(expected), "reading {text:?}");
    }
}

/// `1000`, with no comma, is the year reading, and this stage does not move it.
///
/// `1000` is tagged `date { year: "1000" }`, where "ten hundred" and "one
/// thousand" are a genuine tie; the Rust extraction picks "ten hundred" and the
/// Python reference picks "one thousand". The weight flip is about the *cardinal*
/// path, whose "one thousand"/"thousand" choice is not a tie — so changing this
/// row would mean the fix spilled into a reading it was not meant to touch.
#[test]
fn a_bare_year_is_left_alone() {
    assert_eq!(read("1000").as_deref(), Some("ten hundred"));
    assert_eq!(read("1999").as_deref(), Some("nineteen ninety nine"));
    // The same year inside a sentence, which is how it is actually written.
    assert_eq!(
        read("It cost 1000 dollars.").as_deref(),
        Some("It cost ten hundred dollars.")
    );
}

/// The fix has to reach the phonemes, not just the words.
#[test]
fn the_pipeline_says_the_one() {
    let Some(phonemizer) = english_phonemizer() else {
        return;
    };
    let ipa = phonemizer
        .phonemize_with("I have 1,234 apples.", &english_options())
        .expect("phonemizes")
        .phonemes;
    assert!(
        ipa.contains("wˈʌn θˈaʊzənd"),
        "1,234 must say \"one thousand\": {ipa:?}"
    );
}
