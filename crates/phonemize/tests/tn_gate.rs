//! The two promises [`tn_gate`](phonemize::tn::gate) makes, held against
//! the shipped grammars.
//!
//! The gate is a cheap filter in front of English text normalization, and it is
//! not allowed to be a second opinion about what needs normalizing — the tagger
//! is the authority on that. So it is checked against the tagger rather than
//! against a hand-written list of expectations:
//!
//! 1. [`the_gate_never_skips_anything_the_tagger_found`] — a `false` from the gate
//!    implies the tagger produced nothing but `w` and `p`, which are the two
//!    classes the verbalizer passes through.
//! 2. [`the_gate_never_skips_text_normalization_would_have_changed`] — a `false`
//!    implies the whole normalizer would have returned the text unchanged. This
//!    is the property that actually matters and the first one is only a way of
//!    getting at it.
//! 3. [`skipping_is_the_same_as_the_pipeline_without_the_engine`] — the phoneme
//!    level version of (2), through `phonemize_en` itself.
//!
//! The corpus below is the input to all three. Every entry carries the reason it
//! is in the list, because a corpus is only evidence to the extent a reader can
//! see what it covers.
//!
//! **What these tests cannot see:** the grammar's whitelist
//! contains 3,050 strings with no shape at all, and a gate that never runs the
//! tagger cannot enumerate them. The corpus pins the ones that are common English
//! words; the proper nouns are a measured, quantified hole.

mod common;

use phonemize::g2p::EnglishG2p;
use phonemize::pipeline::phonemize_en;
use phonemize::text::normalize_punctuation;
use phonemize::tn;
use phonemize::tn::needs_normalization;
use phonemize::tn::wetext::{FstTextNormalizer, Normalizer};

/// The corpus, as `(text, why it is here)`.
///
/// Ordinary prose is the majority because ordinary prose is what the gate is
/// for: it is the text that pays 33 ms for a composition that finds nothing.
/// Everything after the first block is an entity or a shape that TN rewrites, and
/// is here to catch a gate that got too clever.
const CORPUS: &[(&str, &str)] = &[
    // ------------------------------------------------ prose the gate should skip
    (
        "The quick brown fox jumps over the lazy dog.",
        "45 characters, no entity",
    ),
    (
        "It was the best of times, it was the worst of times, it was the age of wisdom.",
        "prose, 80 characters",
    ),
    ("Hello there, how are you?", "greeting, question mark"),
    (
        "I think that this is a reasonable thing to say.",
        "prose, no short final word",
    ),
    (
        "She walked to the window and looked out at the garden.",
        "prose, no entity",
    ),
    (
        "This sentence has a comma, a pause, and nothing else.",
        "punctuation only",
    ),
    ("the lowercase opening is fine too", "no capital at all"),
    (
        "A well-known fact about the world.",
        "hyphen, not a numeral sign",
    ),
    ("Everything went according to plan.", "prose"),
    ("We should probably leave before it gets dark.", "prose"),
    ("The meeting was long but not unpleasant.", "prose"),
    ("Neither of them said anything for a moment.", "prose"),
    ("His answer was short and completely wrong.", "prose"),
    ("The whole thing took longer than anyone expected.", "prose"),
    ("Nobody knew what to do about the leaking roof.", "prose"),
    (
        "It is a good idea, and it is also a cheap one.",
        "two clauses",
    ),
    ("They left the building through a side door.", "prose"),
    (
        "Nothing here needs rewriting at all.",
        "prose, and the claim itself",
    ),
    (
        "A sentence, another sentence, and then a third sentence, all quite ordinary.",
        "multi-clause prose, the shape a paragraph is made of",
    ),
    ("Consider how the thing behaves when it is cold.", "prose"),
    (
        "Please close the door on your way out.",
        "imperative with a trailing period",
    ),
    (
        "Both of those are correct, actually.",
        "prose ending in a comma clause",
    ),
    // `the mat.` is the counterexample to the abbreviation shape rule: 3 letters
    // and a period, but the period ends the text, so it is punctuation and not an
    // abbreviation. Ten of these because the rule is the gate's riskiest.
    (
        "The cat sat on the mat.",
        "sentence-final short word: not `mat.` the abbreviation",
    ),
    ("It is done.", "sentence-final 2-letter word"),
    ("He is not sure.", "sentence-final 4-letter word"),
    ("That was fast.", "sentence-final 4-letter word"),
    ("I have no idea.", "sentence-final 4-letter word"),
    ("Then it stopped.", "sentence-final 7-letter word"),
    ("What do you want?", "sentence-final after `?`"),
    // ------------------------------------------- prose the gate must NOT skip
    (
        "Hello. How are you?",
        "a period followed by more text: the same shape as `Dr. Smith`, so the gate fires",
    ),
    (
        "The mat. Then it ended.",
        "the `mat.` above, with more text after it",
    ),
    // ------------------------------------------------------------ entity classes
    (
        "I have 3 cats",
        "cardinal: the case the hand-written reader existed for",
    ),
    ("There are 100 people.", "cardinal, three digits"),
    ("Total 1,234 items.", "cardinal with a comma separator"),
    ("About 1000000 people.", "cardinal, millions"),
    (
        "Meet at 3:30pm.",
        "time, the case that motivated the whole phase",
    ),
    ("Meet at 3:30 pm.", "time with a space before the suffix"),
    (
        "About 50% agreed.",
        "measure: `%` is a symbol from symbol.tsv",
    ),
    (
        "It is 250 km away.",
        "measure with the `and` in the reading",
    ),
    ("She came 1st.", "ordinal"),
    (
        "The 21st of March",
        "ordinal in a sentence, which is why it is not `two one`",
    ),
    ("Use 1/2 cup.", "fraction: `/` alone is enough"),
    ("I paid $20.50", "money: `$` is a symbol"),
    ("It costs £5.", "money in pounds"),
    ("Call 555-1234.", "telephone/range: digits with a hyphen"),
    ("Made in 2024.", "date, a bare year"),
    ("10/4/2024", "date, all digits"),
    ("Room 007.", "serial: leading zeros"),
    ("Read page 42.", "cardinal at the end of a sentence"),
    ("It is 5 ft 10 in tall.", "measure, two units"),
    // ----------------------------------------------------------- electronic
    (
        "Write to foo@bar.com today.",
        "email: `@` is a symbol but the shape is its own case",
    ),
    (
        "See https://example.com/x for details.",
        "URL: `://` needs the scheme",
    ),
    (
        "Visit www.example.com.",
        "URL with no scheme, which `://` alone would miss",
    ),
    // --------------------------------------------------------- abbreviations
    ("Dr. Smith arrived.", "abbreviation with following text"),
    ("Mr. Jones called.", "abbreviation with following text"),
    ("Prof. Green lectured.", "abbreviation with following text"),
    (
        "Acme Inc. & Co. shipped it.",
        "abbreviation plus `&`, a symbol",
    ),
    (
        "He has a Ph.D. in physics.",
        "two-dot abbreviation, no space after the first dot",
    ),
    (
        "The U.S.A. is large.",
        "capitals separated by dots: neither capital run nor plain dot shape",
    ),
    ("She lives in the U.S.", "the same, two letters"),
    // ------------------------------------------------- shape-less whitelist keys
    (
        "See you on Mon morning.",
        "shape-less weekday abbreviation: `Mon` reads `Monday`",
    ),
    (
        "I saw Mrs Smith.",
        "shape-less honorific: `Mrs` reads `Misses`",
    ),
    (
        "Martin Luther King Jr spoke.",
        "shape-less suffix: `Jr` reads `junior`",
    ),
    (
        "We watched TV all evening.",
        "capital run, and the grammar reads it as `Television`",
    ),
    (
        "Read Vol 3 when you can.",
        "a dot-less table key the grammar does *not* tag: a false positive",
    ),
    // ------------------------------------------------------------ symbols
    ("Use salt & pepper.", "`&` from symbol.tsv"),
    ("Mail it to Dept #4.", "`#` from symbol.tsv"),
    ("That is 100% certain.", "`%` from symbol.tsv"),
    ("Add 1 + 1.", "`+` from symbol.tsv"),
    (
        "It was 20° outside.",
        "`°`, one of the three the brief's list omitted",
    ),
    ("She paid in ₩.", "`₩`, non-ASCII symbol"),
    // ------------------------------------------------------------- not an entity
    (
        "Roman numeral IV is ambiguous.",
        "`IV` is a capital run but upstream leaves Roman out",
    ),
    (
        "World War II was long.",
        "`II` the same, and the grammar does not tag this phrase",
    ),
    (
        "He said OK and left.",
        "`OK`: a capital run with nothing behind it",
    ),
];

/// The tagger's output, as the class name of each token it produced.
///
/// A token is `class { field: "value" }`, the class name being the last
/// whitespace-separated word before the `{`. Anything left over after the last
/// token is a parse failure rather than a silent truncation, because a parser
/// that quietly skipped a token would let a `date` through and pass this test.
///
/// **No braces at all means the tagger matched nothing and returned its input.**
/// That is a real outcome for text the grammar has no rule for (`The evaluation
/// predicted +2.` does it), and it counts as "no classes", which is what it is:
/// there is no entity in it to find.
fn tagger_classes(tagged: &str) -> Vec<&str> {
    if !tagged.contains('{') {
        return Vec::new();
    }

    let mut classes = Vec::new();
    let mut rest = tagged;
    while !rest.is_empty() {
        let open = rest
            .find('{')
            .unwrap_or_else(|| panic!("a token never opened in {tagged:?} at {rest:?}"));
        let name = rest[..open].trim();
        let name = name
            .split_whitespace()
            .last()
            .unwrap_or_else(|| panic!("a token has no class name in {tagged:?}"));
        assert!(
            !name.contains('}'),
            "the class name of a token ran past its closing brace in {tagged:?}"
        );
        classes.push(name);

        let close = rest[open..]
            .find('}')
            .unwrap_or_else(|| panic!("a token never closed in {tagged:?} at {rest:?}"));
        rest = rest[open + close + 1..].trim_start();
    }
    classes
}

/// `(tagger, normalizer)`, built once for the tests that need them.
///
/// The parse is 247 ms in a debug native test, so this is per test rather than
/// shared — and there are only a handful of tests here.
fn engine() -> Option<(FstTextNormalizer, Normalizer)> {
    let (tagger, verbalizer) = common::wetext_fsts(common::WETEXT_EN_NAMES)?;
    Some((
        FstTextNormalizer::from_bytes(&tagger).expect("the tagger parses"),
        tn::english(&tagger, &verbalizer).expect("both grammars parse"),
    ))
}

/// **The invariant.** A skip means the tagger had nothing to say.
///
/// `w` (word) and `p` (punctuation) are the two classes the verbalizer passes
/// through untouched, so a tagger output made only of those is one the
/// composition would leave alone — which is what makes it safe not to run it.
///
/// This is the reason the gate is allowed to exist at all: it is a filter, and
/// this is the check that keeps the filter's opinion of "nothing to do" tied to
/// the grammar's rather than to a hand-written list that would drift from it.
#[test]
fn the_gate_never_skips_anything_the_tagger_found() {
    let Some((tagger, _)) = engine() else {
        return;
    };

    let mut skipped = 0;
    for (text, why) in CORPUS {
        if needs_normalization(text) {
            continue;
        }
        skipped += 1;

        let tagged = tagger
            .normalize(&normalize_punctuation(text))
            .unwrap_or_else(|error| panic!("{text:?} tags: {error}"));
        let entities: Vec<&str> = tagger_classes(&tagged)
            .into_iter()
            .filter(|class| *class != "w" && *class != "p")
            .collect();

        assert!(
            entities.is_empty(),
            "the gate skipped {text:?} ({why}) but the tagger found {entities:?}:\n  {tagged}"
        );
    }

    // A corpus the gate skips wholesale would satisfy the assertion above and
    // prove nothing, so the other direction has to be non-trivial too.
    assert!(
        skipped >= 25,
        "only {skipped} of {} corpus entries are skipped: the gate is not filtering anything",
        CORPUS.len()
    );
}

/// **The property the first test is a proxy for.** A skip means the normalizer
/// would have handed the text back unchanged.
///
/// This is stronger than the tagger test and not implied by it: the tagger's `w`
/// and `p` classes are passed through by the verbalizer, but the whole pipeline
/// also trims, and a tagger that matched *nothing* returns its input, which the
/// verbalizer then composes. Checking the composed engine directly is what turns
/// "the tagger found no entity" into "the text does not move".
#[test]
fn the_gate_never_skips_text_normalization_would_have_changed() {
    let Some((_, normalizer)) = engine() else {
        return;
    };

    for (text, why) in CORPUS {
        if needs_normalization(text) {
            continue;
        }
        let normalized = normalizer
            .normalize(&normalize_punctuation(text))
            .unwrap_or_else(|error| panic!("{text:?} normalizes: {error}"));
        assert_eq!(
            normalized,
            normalize_punctuation(text),
            "the gate skipped {text:?} ({why}) but the engine rewrites it"
        );
    }
}

/// Skipping is only safe because the fallback is a no-op on the same text.
///
/// [`phonemize_en`] takes an `Option<&Normalizer>` and falls back to
/// [`numbers_to_english`](phonemize::tn::numbers_to_english)
/// when there is no engine; the gate replaces the engine with *the text itself*
/// on a skip, so the two are the same answer only if the fallback would have
/// changed nothing. It matches a digit and a minus sign followed by a digit and
/// nothing else, so the claim is not a coincidence — but it is a claim about
/// another module, and it is asserted here rather than written in a comment.
#[test]
fn the_fallback_the_gate_bypasses_is_a_no_op_on_every_skipped_entry() {
    use phonemize::tn::numbers_to_english;

    for (text, why) in CORPUS {
        let text = normalize_punctuation(text);
        if numbers_to_english(&text) != text {
            // Only interesting for the skipped half, but a corpus entry the gate
            // fires on is allowed to have digits in it.
            assert!(
                needs_normalization(&text),
                "the gate skipped {text:?} ({why}) but the fallback would have rewritten it"
            );
        }
    }

    // And the same statement in the direction that matters, over the whole
    // corpus: no digit anywhere in the skipped half.
    for (text, why) in CORPUS {
        if !needs_normalization(text) {
            assert!(
                !text.bytes().any(|byte| byte.is_ascii_digit()),
                "the gate skipped {text:?} ({why}) and it has a digit in it"
            );
        }
    }
}

/// The end-to-end version: the phonemes do not depend on whether the engine was
/// asked.
///
/// Two calls through the real pipeline, with the engine deliberately excluded
/// from the right-hand side: the left one lets the gate decide, the right one
/// runs the pipeline on what the engine *would* have produced. They agree exactly
/// when a skip was correct — the "did skipping cost anything audible?"
/// question, asserted instead of measured.
///
/// This is the strongest of the three because it is the level the user hears, and
/// it is the one that would have caught the mistake in the first measurement of
/// these numbers: `key` was phonemized with the engine on one side and the gate
/// turned it off on both, and got zero differences by construction.
#[test]
fn skipping_is_the_same_as_the_pipeline_without_the_engine() {
    let Some((_, normalizer)) = engine() else {
        return;
    };
    let Ok(english) = EnglishG2p::new() else {
        panic!("the CMU dictionary is compiled in");
    };

    let mut skipped = 0;
    for (text, why) in CORPUS {
        let normalized = normalize_punctuation(text);
        if needs_normalization(text) {
            continue;
        }
        skipped += 1;

        let through_the_gate = phonemize_en(text, Some(&english), Some(&normalizer))
            .unwrap_or_else(|error| panic!("{text:?} phonemizes: {error}"));
        let with_the_engine = normalizer
            .normalize(&normalized)
            .unwrap_or_else(|error| panic!("{text:?} normalizes: {error}"));
        // `tn = None` on this side, so the engine cannot be involved in the
        // answer whatever the gate thinks.
        let without_the_gate = phonemize_en(&with_the_engine, Some(&english), None)
            .unwrap_or_else(|error| panic!("{text:?} phonemizes: {error}"));

        assert_eq!(
            through_the_gate.phonemes, without_the_gate.phonemes,
            "skipping {text:?} ({why}) changed the phonemes\n  \
             through the gate: {}\n  through the engine: {}",
            through_the_gate.phonemes, without_the_gate.phonemes
        );
    }
    assert!(skipped >= 25, "only {skipped} entries were skipped");
}

/// A paragraph of prose, end to end: the engine is not consulted and the answer
/// is what the same text phonemizes to with no engine at all.
///
/// The point is not the equality — see the test above for the version that can
/// actually fail — but that the *whole* gate-plus-pipeline path runs on a length
/// of text that used to cost a 33 ms composition, and produces the same IPA as
/// the path that never had an engine.
///
/// **The paragraph is chosen so that the gate skips it, and that is a limitation
/// worth naming.** The abbreviation rule fires on a `.` with text after it, so a
/// paragraph fires whenever one of its sentences ends in a word of five letters or
/// fewer — which, measured on this crate's own English README, is 9 of 12
/// paragraphs. A paragraph whose sentences all end in longer words is quiet, and
/// this is one.
#[test]
fn a_paragraph_with_nothing_in_it_goes_through_the_pipeline_unchanged() {
    let Some((_, normalizer)) = engine() else {
        return;
    };
    let Ok(english) = EnglishG2p::new() else {
        panic!("the CMU dictionary is compiled in");
    };

    let paragraph = "Several things happened quickly and nothing was explained afterwards. \
                     Everyone waited patiently, and eventually the silence itself became an \
                     answer.";
    assert!(
        !needs_normalization(paragraph),
        "the paragraph has to be one the gate skips"
    );

    let with_the_engine = phonemize_en(paragraph, Some(&english), Some(&normalizer))
        .expect("phonemizes")
        .phonemes;
    let without_the_engine = phonemize_en(paragraph, Some(&english), None)
        .expect("phonemizes")
        .phonemes;

    assert_eq!(with_the_engine, without_the_engine);
    assert!(!with_the_engine.is_empty());
}
