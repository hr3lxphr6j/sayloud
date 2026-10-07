//! The Chinese readings and IPA, against the corpus the JavaScript pipeline left
//! behind.
//!
//! The corpus is `tests/fixtures/zh-parity.json`, generated from the JavaScript
//! side by `tests/unit/models/phonemize/zh-parity.test.ts`. It is frozen: the
//! generator is gone, so nothing can regenerate it, and this test is what keeps
//! the Rust output pinned to it. It compares two things separately, because they
//! fail separately:
//!
//! - `jsPinyin` is what `pinyin-pro` reports. A mismatch is the phrase tables, the
//!   segmentation, or the 一/不/了/々 rules.
//! - `js` is the IPA. A mismatch with the pinyin agreeing is the syllable table,
//!   the tone arrows, or the `ü` spelling.
//!
//! That split is the whole reason the fixture records both: a single IPA string
//! that differs tells you there is a bug but not which half of the port to look
//! at.
//!
//! What this corpus does **not** cover, and where the coverage is instead:
//!
//! - word boundaries (jieba) and the spacing they produce — the frozen pipeline's
//!   business, and the corpus is deliberately one space per syllable;
//! - the punctuation, numeral and Latin-run rules — also the frozen pipeline's;
//! - characters with no reading, and a syllable the table is missing — the error
//!   paths are in `tests/pinyin.rs`, because a corpus of successes cannot record
//!   a refusal.

use phonemize::g2p::ChinesePinyin;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Corpus {
    samples: Vec<Sample>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sample {
    input: String,
    /// What `pinyin-pro` reports, in tone-number form.
    js_pinyin: Vec<String>,
    /// What the JavaScript IPA step produces, one space per syllable.
    js: String,
    /// What Rust produces, when it is deliberately not the same as `js`.
    rust: Option<String>,
    /// Why. Required whenever `rust` is present.
    divergence: Option<String>,
}

fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/zh-parity.json")).expect("the corpus parses")
}

#[test]
fn reads_every_character_the_way_pinyin_pro_does() {
    let chinese = ChinesePinyin::new();
    let mut failures = Vec::new();

    for sample in corpus().samples {
        let rust = chinese.text_to_pinyin(&sample.input);
        if rust != sample.js_pinyin {
            failures.push(format!(
                "{}\n  javascript {}\n  rust       {}",
                sample.input,
                sample.js_pinyin.join(" "),
                rust.join(" ")
            ));
        }
    }

    // Every sample, not the first failure: a wrong reading usually means the
    // segmentation went wrong somewhere earlier, and one example of that is much
    // less useful than the shape of all of them.
    assert!(
        failures.is_empty(),
        "{} samples differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn phonemizes_every_run_the_way_javascript_does() {
    let chinese = ChinesePinyin::new();
    let mut failures = Vec::new();

    for sample in corpus().samples {
        let expected = sample.rust.as_ref().unwrap_or(&sample.js);
        match chinese.han_to_ipa(&sample.input) {
            Ok(rust) if &rust == expected => {}
            Ok(rust) => failures.push(format!(
                "{}\n  expected {expected}\n  rust     {rust}",
                sample.input
            )),
            Err(error) => failures.push(format!("{}\n  {error}", sample.input)),
        }
    }

    assert!(
        failures.is_empty(),
        "{} samples differ:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

#[test]
fn records_a_reason_for_every_divergence() {
    for sample in corpus().samples {
        if sample.rust.is_some() {
            assert!(
                sample.divergence.is_some(),
                "{:?} records a Rust divergence with no reason",
                sample.input
            );
        }
    }
}

/// The corpus covers the paths that break independently.
///
/// A parity test passes trivially on a corpus that stopped containing the thing
/// it was written for, which is the failure mode this project keeps finding — a
/// test that passes because its input went away. So the samples that are here for
/// a specific reason are asserted to still be here.
#[test]
fn the_corpus_covers_the_paths_that_break_independently() {
    let corpus = corpus();
    let inputs: Vec<&str> = corpus
        .samples
        .iter()
        .map(|sample| sample.input.as_str())
        .collect();

    for (reason, needle) in [
        ("the four tones", "妈麻马骂"),
        ("the neutral tone", "吗"),
        ("the `ü` spelling", "女绿略虐"),
        ("U+032F in the IPA", "好"),
        ("a phrase from DICT3", "为什么"),
        ("a phrase from DICT4", "成吉思汗"),
        ("the 一/不 tone sandhi", "一个"),
        ("the 叠词 neutral tone", "看一看"),
        ("the blocking suffix list", "一的"),
        ("the numeral rule table", "一重"),
        ("了 read as liǎo", "了"),
        ("the reduplication mark", "人々"),
        (
            "a run long enough to underflow the probabilities",
            "下溢为零",
        ),
    ] {
        assert!(
            inputs.iter().any(|input| input.contains(needle)),
            "the corpus no longer covers {reason} ({needle:?})"
        );
    }

    // And it is still large enough to be worth comparing at all.
    assert!(
        corpus.samples.len() >= 40,
        "{} samples",
        corpus.samples.len()
    );
}
