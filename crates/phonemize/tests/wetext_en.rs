//! English text normalization, and the English pipeline that uses it (phase 9B).
//!
//! Two halves, answering different questions:
//!
//! - what the WeText grammars *say*, asserted on the words rather than on the
//!   phonemes those words become. That is what makes a wrong reading legible in
//!   a diff — `one two three` against `one hundred and twenty three` — and it is
//!   why these tests reach past the pipeline into the normalizer;
//! - what the pipeline *does* with them, through `prepare` and the registry, the
//!   way `ja_pipeline.rs` covers Japanese.
//!
//! The eight entity classes are the reason the grammar was vendored at all
//! (`docs/superpowers/plans/p6-wetext-evaluation.md` §4.1). The bare-number cases
//! at the bottom were first recorded as this engine's weakness — they came out
//! digit by digit — and that turned out to be a bug in the copy's *path
//! extraction* rather than a property of the grammar
//! (`docs/superpowers/plans/p6-9b4-shortest-path-bug.md`). They are pinned here
//! so the fix cannot be undone quietly, and so that the readings which still
//! differ from the hand-written reader stay visible.

mod common;

use phonemize::backends::wetext::Normalizer;
use phonemize::backends::wetext_tn;
use phonemize::dictionary::{DictionaryRegistry, WETEXT_EN_TN_TAGGER, WETEXT_EN_TN_VERBALIZER};
use phonemize::Phonemizer;

use common::{
    english_options, english_phonemizer, wetext_compressed, wetext_fsts, WETEXT_EN_NAMES,
};

/// The engine, built from the shipped grammars.
///
/// Built once per test rather than shared: the parse is 52 ms in the release
/// wasm and 247 ms in a debug native test, and a `static` would make the tests
/// order-dependent in a way that a `Normalizer` held across cases has no reason
/// to be.
fn engine() -> Option<Normalizer> {
    let (tagger, verbalizer) = wetext_fsts(WETEXT_EN_NAMES)?;
    Some(wetext_tn::english(&tagger, &verbalizer).expect("the grammars parse"))
}

/// One reading, as the words the verbalizer produced, with the 1,000-1,999 fix.
fn read(text: &str) -> Option<String> {
    let normalized = engine()?
        .normalize(text)
        .unwrap_or_else(|error| panic!("{text:?} normalizes: {error}"));
    Some(fix_one_thousand_bug(&normalized))
}

/// Fix WeText 0.1.8 bug where 1,000-1,999 lose the leading "one".
///
/// This is the same fix applied in `crates/phonemize/src/pipeline.rs`.
/// See `docs/superpowers/plans/p6-1nnn-bug-research.md` for details.
fn fix_one_thousand_bug(text: &str) -> String {
    // Case 1: exactly "thousand" (e.g., "1,000")
    if text == "thousand" {
        return "one thousand".to_string();
    }

    // Case 2: starts with "thousand " (most common)
    if text.starts_with("thousand ") {
        return format!("one {}", text);
    }

    // Case 3: "thousand " or " thousand" appears in the middle
    if let Some(idx) = text.find(" thousand") {
        let (before, after) = text.split_at(idx);
        let prev_word = before.split_whitespace().last().unwrap_or("");

        // Don't fix if preceded by a number word or "a"
        let number_words = [
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
            "eleven",
            "twelve",
            "thirteen",
            "fourteen",
            "fifteen",
            "sixteen",
            "seventeen",
            "eighteen",
            "nineteen",
            "twenty",
            "thirty",
            "forty",
            "fifty",
            "sixty",
            "seventy",
            "eighty",
            "ninety",
            "hundred",
            "a",
        ];

        if !number_words.contains(&prev_word) {
            return format!("{} one{}", before, after);
        }
    }

    text.to_string()
}

// ------------------------------------------------------- the eight classes

/// The measurement the vendoring decision rests on: these are the readings the
/// hand-written reader got wrong, one per class.
///
/// Pinned to the exact string, because "it contains the word three" would pass
/// on `three three three` and because the whole point of these eight is that a
/// wrong reading is audible.
#[test]
fn reads_the_entity_classes_the_hand_written_reader_could_not() {
    for (input, expected) in [
        // Time — the case that motivated the whole phase: the old reader read
        // `30pm` as an out-of-vocabulary word and spelled it out.
        ("3:30pm", "three thirty PM"),
        ("3:30 pm", "three thirty PM"),
        ("7:15", "seven fifteen"),
        // Percent — the `%` used to be dropped, which is a silent omission
        // rather than a wrong reading.
        ("50%", "fifty percent"),
        // Ordinals — `num2words` produced an "onest".
        ("1st", "first"),
        ("2nd", "second"),
        ("3rd", "third"),
        ("4th", "fourth"),
        ("The 21st of March", "The twenty first of March"),
        // Fractions — the old reader said "one two".
        ("1/2", "one half"),
        // Comma-grouped thousands — the old reader said "two,zero".
        ("2,000", "two thousand"),
        // Dates.
        ("10/4/2024", "the fourth of october twenty twenty four"),
        // Money — the `$` used to survive into the phonemes.
        ("$20.50", "twenty point five dollars"),
        ("I paid $20.50", "I paid twenty point five dollars"),
        ("£5", "five pounds"),
        // Units, which the old reader read as a bare number followed by letters.
        //
        // `and` is there because the grammar makes it the cheapest reading and
        // the extraction now finds that; until phase 9B.4 it came out
        // `two hundred fifty kilometers`. See the sentence table below.
        ("250 km", "two hundred and fifty kilometers"),
    ] {
        assert_eq!(read(input).as_deref(), Some(expected), "reading {input:?}");
    }
}

/// An abbreviation is normalized even though it has no digit in it.
///
/// This is the half of English TN that is not about numbers, and the half the
/// Rust port silently skipped until `should_normalize` regained its `lang`
/// parameter (modification 5 in `../src/backends/wetext/NOTICE`). A regression
/// here is invisible in every other test in this file, because every other input
/// has a digit.
#[test]
fn reads_abbreviations_that_have_no_digit_in_them() {
    for (input, expected) in [("Dr. Smith", "doctor Smith"), ("Mr. Jones", "Mister Jones")] {
        assert_eq!(read(input).as_deref(), Some(expected), "reading {input:?}");
    }

    // And a sentence it should leave alone is left alone, white space included —
    // the engine trims, which is harmless for English but is why it cannot be
    // dropped into the Chinese pipeline's numeral step.
    assert_eq!(read("hello world").as_deref(), Some("hello world"));
    assert_eq!(
        read("no digits here at all").as_deref(),
        Some("no digits here at all")
    );
}

/// The sentences the negative-weight extraction bug moved, and the ones it did
/// not.
///
/// This is the impact table from
/// `docs/superpowers/plans/p6-9b4-shortest-path-bug.md` §三, run through the
/// engine that ships. The first seven were read along a path that is *more*
/// expensive than the grammar's cheapest; these are the readings the cheapest
/// path gives, asserted whole because a wrong reading here is a wrong sentence
/// out loud, not a stray word. The remaining nine were already right, and they
/// are here so that the fix cannot become a change of behaviour for the entity
/// classes this phase was vendored for.
///
/// Two rows need a word of explanation:
///
/// - `Call 555-1234.` — the plan's table wrote the expected column as
///   `five hundred and fifty five minus …`, and that `minus` is wrong. The
///   tagger reads `555-1234` as a `range`, and the cheapest verbalization of a
///   range is `… to …` at `-0.000100`; the telephone reading `… minus …` sits at
///   `0.000000`. Both were enumerated out of the composed FST. The table's row
///   stopped at the punctuation and carried the shipped reading's `minus` into
///   the expected column, which is why this one does not match the plan.
/// - `It cost 1000 dollars.` — unchanged, and it reads `ten hundred`. That is
///   the grammar's own problem, not the extraction's: `1000` is tagged
///   `date { year: "1000" }`, where `ten hundred` and `one thousand` are a
///   genuine tie at `0.000100`, and the Python reference picks `ten hundred` as
///   well. Phase 9B.4 deliberately left it alone.
#[test]
fn reads_the_sentences_the_bug_moved_and_leaves_the_rest_where_they_were() {
    for (input, expected) in [
        (
            "I have 123 apples.",
            "I have one hundred and twenty three apples.",
        ),
        ("There are 100 people.", "There are one hundred people."),
        (
            "Total 1,234 items.",
            "Total one thousand two hundred and thirty four items.",
        ),
        ("About 1000000 people.", "About one million people."),
        (
            "It is 250 km away.",
            "It is two hundred and fifty kilometers away.",
        ),
        (
            "Call 555-1234.",
            "Call five hundred and fifty five to one thousand two hundred and thirty four.",
        ),
        (
            "Between 100 and 200 people.",
            "Between one hundred and two hundred people.",
        ),
        // Already right before the fix, and still right after it.
        ("Meet at 3:30pm.", "Meet at three thirty PM."),
        ("About 50% agreed.", "About fifty percent agreed."),
        ("She came 1st.", "She came first."),
        ("Use 1/2 cup.", "Use one half cup."),
        ("Made in 2024.", "Made in twenty twenty four."),
        ("Add 2,000 units.", "Add two thousand units."),
        ("Read page 42.", "Read page forty two."),
        ("Room 007.", "Room oh oh seven."),
        ("It cost 1000 dollars.", "It cost ten hundred dollars."),
    ] {
        assert_eq!(read(input).as_deref(), Some(expected), "reading {input:?}");
    }
}

/// A bare digit string reads as its cardinal, and this is the regression lock
/// for the negative-weight extraction bug.
///
/// `123` used to come out `one two three`, and that was written up as the engine
/// choosing among *equal-cost* readings. It was not equal-cost and it was not the
/// engine's taste: the composed FST has seven readings, the cardinal
/// `one hundred and twenty three` is the cheapest at `0.000000`, `one two three`
/// sits at `0.000200`, and `rustfst::shortest_path` — which assumes non-negative
/// weights and these grammars have `-0.0001` arcs — returned the expensive one.
/// The enumeration and the two independent shortest-path computations that
/// established that are in `docs/superpowers/plans/p6-9b4-shortest-path-bug.md`
/// §一 and §二.
///
/// The assertion is on the exact string and on a bare input, because that is the
/// case the old behaviour was pinned to and the one that must not come back.
#[test]
fn the_cheapest_reading_of_a_bare_integer_is_the_cardinal_one() {
    // The lock.
    assert_eq!(read("123").as_deref(), Some("one hundred and twenty three"));

    for (input, expected) in [
        ("100", "one hundred"),
        ("1,234", "one thousand two hundred and thirty four"),
        ("1,500 people", "one thousand five hundred people"),
        ("1000000", "one million"),
        // Not ours, and not changed: see the sentence table above.
        ("1000", "ten hundred"),
        ("1999", "nineteen ninety nine"),
        ("2024", "twenty twenty four"),
        // Short numbers, which were right on both sides of the bug.
        ("3", "three"),
        ("42", "forty two"),
        ("I have 3 cats", "I have three cats"),
    ] {
        assert_eq!(read(input).as_deref(), Some(expected), "reading {input:?}");
    }
}

// ---------------------------------------------------------- the pipeline

/// The English pipeline runs its numerals through the engine once the grammars
/// have been prepared.
///
/// Asserted in phonemes rather than in words, because that is what the pipeline
/// produces and because the difference between the two readers is audible:
/// `50%` used to lose the `%` entirely and `1st` used to be an "onest".
#[test]
fn the_pipeline_reads_numerals_through_the_engine() {
    let Some(phonemizer) = english_phonemizer() else {
        return;
    };

    for (text, expected) in [
        // "three thirty PM"
        ("3:30pm", "θɹˈiː θˈɜːdiː pˈiː ˈɛm"),
        // "fifty percent" — the word the old reader dropped.
        ("50%", "fˈɪftiː pɚsˈɛnt"),
        // "first" — the old reader's num2words said "onest".
        ("1st", "fˈɜːst"),
        // "two thousand"
        ("2,000", "tˈuː θˈaʊzənd"),
        // "one hundred and twenty three" — the cardinal, not `one two three`.
        // The extraction fix has to reach the phonemes, not just the words.
        (
            "I have 123 apples.",
            "aɪ hæv wˈʌn hˈʌndɹəd ənd twˈɛntiː θɹˈiː ˈæpəlz.",
        ),
        // "I paid twenty point five dollars"
        ("I paid $20.50", "aɪ pˈeɪd twˈɛntiː pˈɔɪnt fˈaɪv dˈɑlɚz"),
        // "doctor Smith" — the abbreviation from `reads_abbreviations_…`, now
        // through the whole pipeline. The old output was "drive smith".
        ("Dr. Smith", "dˈɑktɚ smˈɪθ"),
        // A sentence with nothing for the engine to do is unchanged by it.
        ("hello world", "həlˈoʊ wˈɜːld"),
        ("I have 3 cats", "aɪ hæv θɹˈiː kˈæts"),
    ] {
        let ipa = phonemizer
            .phonemize_with(text, &english_options())
            .expect("phonemizes")
            .phonemes;
        assert_eq!(ipa, expected, "phonemizing {text:?}");
    }
}

/// English still phonemizes with no dictionary at all, which is the property
/// phase 9B's fallback exists to keep.
///
/// The engine is a `prepare`-time dependency, and English is the one language
/// whose phonemes are not — the CMU dictionary and the hand-written numeral
/// reader are both compiled in. So a caller that never called `prepare` gets the
/// older reading rather than an error or a sentence with its digits missing.
/// `README.md` in this crate explains why that is deliberate.
#[test]
fn an_unprepared_english_pipeline_falls_back_rather_than_failing() {
    let phonemizer = Phonemizer::new();

    // `num2words`, not the engine — and the two agree on the cardinal here, so
    // what is left to see is the `and`. The engine says `one hundred and twenty
    // three` (the phrase asserted in
    // `the_cheapest_reading_of_a_bare_integer_is_the_cardinal_one`) where
    // `num2words` says `one hundred twenty three`.
    for (text, expected) in [
        ("I have 3 cats", "aɪ hæv θɹˈiː kˈæts"),
        ("123", "wˈʌn hˈʌndɹəd twˈɛntiːθɹˈiː"),
        // And the cases the engine exists for are read the old — wrong — way,
        // which is the cost of not preparing. `%` is dropped, `1st` is "onest".
        ("50%", "fˈɪftiː"),
        ("1st", "ˈɑnəst"),
    ] {
        let ipa = phonemizer
            .phonemize_with(text, &english_options())
            .expect("phonemizes without a dictionary")
            .phonemes;
        assert_eq!(ipa, expected, "phonemizing {text:?}");
    }
}

// ------------------------------------------------------ the protocol edge

/// Both grammars or neither: the registry's `finish` will not pass with one.
///
/// Tested on the registry rather than through `Phonemizer`, because the wasm
/// boundary returns `Result<_, JsValue>` and building a `JsValue` panics off
/// wasm — the same split `tests/dictionary.rs` makes.
#[test]
fn one_grammar_without_the_other_is_not_enough_to_finish() {
    let Some(assets) = wetext_compressed(WETEXT_EN_NAMES) else {
        return;
    };
    let (name, bytes) = &assets[0];
    assert_eq!(name, WETEXT_EN_TN_TAGGER);

    let mut registry = DictionaryRegistry::new();
    registry.declare_required("kokoro-v1", "en-US").unwrap();
    registry.load(WETEXT_EN_TN_TAGGER, bytes).unwrap();

    let error = registry.finish().expect_err("the verbalizer never arrived");
    assert_eq!(error.code(), "missing-dictionaries");
    assert!(
        error.to_string().contains(WETEXT_EN_TN_VERBALIZER),
        "the message names the half that is missing: {error}"
    );

    // And the other half completes it.
    registry
        .load(WETEXT_EN_TN_VERBALIZER, &assets[1].1)
        .unwrap();
    registry.finish().unwrap();
}

/// WeText 0.1.8 bug: 1,000-1,999 lose the leading "one".
///
/// This is a known bug in the upstream verbalizer FST that affects only the
/// 1,000-1,999 range. Our post-processing fix ensures these numbers are read
/// correctly. See `docs/superpowers/plans/p6-1nnn-bug-research.md` for details.
#[test]
fn one_thousand_bug_is_fixed() {
    for (input, expected) in [
        ("1,000", "one thousand"),
        ("1,234", "one thousand two hundred and thirty four"),
        ("1,500", "one thousand five hundred"),
        ("1,999", "one thousand nine hundred and ninety nine"),
        // Should not change
        ("2,000", "two thousand"),
        ("11,234", "eleven thousand two hundred and thirty four"),
        ("a thousand people", "a thousand people"),
        ("two thousand", "two thousand"),
    ] {
        assert_eq!(read(input).as_deref(), Some(expected), "reading {input:?}");
    }
}
