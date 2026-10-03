//! The Japanese pipeline, end to end, against the real IPADic dictionary.
//!
//! Two things live here, and they answer different questions:
//!
//! - the segmenter tests say what the dictionary reads a word as, which is where
//!   a lindera or IPADic change would show up;
//! - the parity corpus says the whole pipeline still produces the same phonemes
//!   as the JavaScript one, which is the P6 acceptance criterion (§0.4).
//!
//! The corpus is `tests/fixtures/ja-parity.json`, generated from the JavaScript
//! pipeline by `tests/unit/models/phonemize/ja-parity.test.ts`. Both sides are
//! pinned to it, so neither can drift alone.

mod common;

use std::collections::HashMap;

use phonemize::backends::SegmenterJa;
use phonemize::dictionary::DictionaryRegistry;
use phonemize::dictionary::IPADIC_JA;

use common::{dictionary_bytes, japanese_options, japanese_phonemizer};

// ------------------------------------------------------------- the segmenter

/// A segmenter built straight from the decompressed container.
///
/// Goes through the registry rather than unpacking the asset itself, because the
/// registry is what does the decompressing in production.
fn segmenter() -> Option<SegmenterJa> {
    let compressed = dictionary_bytes()?;

    let mut registry = DictionaryRegistry::new();
    registry
        .declare_required("kokoro-v1", "ja-JP")
        .expect("kokoro-v1 speaks ja");
    registry
        .load(IPADIC_JA, &compressed)
        .expect("the dictionary loads");

    Some(
        SegmenterJa::from_container(registry.get(IPADIC_JA).expect("loaded"))
            .expect("the container is a usable dictionary"),
    )
}

#[test]
fn reads_kanji_through_the_dictionary() {
    let Some(segmenter) = segmenter() else {
        return;
    };

    // The reading comes from IPADic's `reading` field, looked up through
    // lindera's schema rather than by array index.
    for (text, expected) in [
        ("経営", "ケイエイ"),
        // 日本 reads ニッポン on its own and ニホン inside 日本語, and both
        // pipelines agree on both — the reading depends on how the sentence
        // segments, which is why 日本語 is in the parity corpus as well.
        ("日本", "ニッポン"),
        ("学校", "ガッコウ"),
        ("新聞", "シンブン"),
    ] {
        assert_eq!(
            segmenter.read_as_katakana(text).expect("segments"),
            expected,
            "{text}"
        );
    }
}

#[test]
fn falls_back_to_the_surface_when_the_dictionary_has_no_reading() {
    let Some(segmenter) = segmenter() else {
        return;
    };

    // A run of kana the dictionary does not know is shifted to katakana and read
    // out, because the surface is all kana — this is kuroshiro's rule, and
    // without it an unknown word would reach the IPA table as hiragana and be
    // mapped anyway. `kana_to_ipa` shifts too, so the two agree either way; what
    // this pins is that the *segmenter* does it, which is what keeps a mixed run
    // consistent.
    assert_eq!(
        segmenter.read_as_katakana("ぴゃぴゃ").expect("segments"),
        "ピャピャ"
    );

    // Digits have no reading, and their surface is not kana, so they pass
    // through as themselves — which is why `numbers_to_kanji` runs first.
    assert_eq!(
        segmenter.read_as_katakana("2022").expect("segments"),
        "2022"
    );
}

#[test]
fn splits_a_sentence_into_words() {
    let Some(segmenter) = segmenter() else {
        return;
    };

    let tokens = segmenter.tokenize("東京都に行きます").expect("segments");
    let surfaces: Vec<&str> = tokens.iter().map(|token| token.surface.as_str()).collect();

    assert!(
        surfaces.len() > 1,
        "expected a sentence to be split into words, got {surfaces:?}"
    );
    assert_eq!(surfaces.concat(), "東京都に行きます");
}

// ------------------------------------------------------------------- parity

#[derive(serde::Deserialize)]
struct Corpus {
    samples: Vec<Sample>,
}

#[derive(serde::Deserialize)]
struct Sample {
    input: String,
    js: String,
    rust: Option<String>,
    divergence: Option<String>,
}

fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/ja-parity.json")).expect("the corpus parses")
}

#[test]
fn reports_a_language_whose_pipeline_is_not_built_yet() {
    // `zh` and `en` pass the frontend check — v1.0 can speak both — and have no
    // pipeline in this build. An error rather than an empty string, because an
    // empty string is a sentence that plays as silence.
    let phonemizer = phonemize::Phonemizer::new();
    let options = phonemize::PhonemizeOptions {
        frontend: "kokoro-v1".to_string(),
        lang: "zh-CN".to_string(),
    };

    let error = phonemizer
        .phonemize_with("你好", &options)
        .expect_err("Chinese has no pipeline yet");

    assert_eq!(error.code(), "pipeline-not-implemented");
}

#[test]
fn reports_a_language_the_frontend_cannot_speak_as_a_frontend_problem() {
    // The distinction that matters for the message the user sees (spec §8.1):
    // this is "that voice cannot read this", not "this build is unfinished".
    let phonemizer = phonemize::Phonemizer::new();
    let options = phonemize::PhonemizeOptions {
        frontend: "kokoro-v11-zh".to_string(),
        lang: "ja-JP".to_string(),
    };

    let error = phonemizer
        .phonemize_with("経営", &options)
        .expect_err("v1.1-zh has no Japanese frontend");

    assert_eq!(error.code(), "unsupported-language");
}

#[test]
fn reports_a_japanese_call_that_never_prepared_a_dictionary() {
    let phonemizer = phonemize::Phonemizer::new();
    let options = japanese_options();

    let error = phonemizer
        .phonemize_with("経営", &options)
        .expect_err("nothing was prepared");

    assert_eq!(error.code(), "dictionary-not-loaded");
}

#[test]
fn the_pipeline_matches_the_javascript_one() {
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();
    let corpus = corpus();

    assert!(
        corpus.samples.len() >= 10,
        "the corpus is meant to be more than a smoke test"
    );

    let mut failures: Vec<String> = Vec::new();
    for sample in &corpus.samples {
        let expected = sample.rust.as_ref().unwrap_or(&sample.js);
        let actual = phonemizer
            .phonemize_with(&sample.input, &options)
            .expect("phonemizes");

        if &actual.phonemes != expected {
            failures.push(format!(
                "{:?}\n    expected {expected:?}\n    actual   {:?}",
                sample.input, actual.phonemes
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} samples diverged from the corpus:\n  {}",
        failures.len(),
        corpus.samples.len(),
        failures.join("\n  ")
    );
}

#[test]
fn every_recorded_divergence_is_still_a_divergence() {
    // A divergence note that has stopped being true is worse than none: it says
    // "known and accepted" about something that is now a bug. When phase 4 lands
    // espeak, the Latin samples in the corpus start matching the JavaScript and
    // this test fails, which is the reminder to delete their notes.
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();

    let mut stale: Vec<String> = Vec::new();
    for sample in corpus()
        .samples
        .iter()
        .filter(|sample| sample.rust.is_some())
    {
        let actual = phonemizer
            .phonemize_with(&sample.input, &options)
            .expect("phonemizes")
            .phonemes;

        if actual == sample.js {
            stale.push(format!(
                "{:?} no longer diverges ({})",
                sample.input,
                sample.divergence.as_deref().unwrap_or("no reason recorded")
            ));
        }
    }

    assert!(
        stale.is_empty(),
        "stale divergence notes:\n  {}",
        stale.join("\n  ")
    );
}

#[test]
fn the_corpus_covers_the_paths_that_break_independently() {
    // Not a property of the output, but of the corpus: a parity suite is only
    // worth its name if it would notice the things that can break. Each of these
    // is a distinct code path, and each has a sample whose expected output
    // contains the phoneme that path produces.
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();
    let corpus = corpus();

    let by_input: HashMap<&str, &str> = corpus
        .samples
        .iter()
        .map(|sample| {
            (
                sample.input.as_str(),
                sample.rust.as_deref().unwrap_or(&sample.js),
            )
        })
        .collect();

    // ʔ from ッ, ː from ー, ɴ from ン, a palatalized pair read as one mora, and
    // each of the five numeral sound changes.
    for (input, marker) in [
        ("がっこう", "ʔ"),
        ("コーヒー", "ː"),
        ("しんぶん", "ɴ"),
        ("キャンプ", "kja"),
        ("三百", "bja"),
        ("六百", "ʔpj"),
        ("八百", "ʔpj"),
        ("三千", "zeɴ"),
        ("8000", "ʔseɴ"),
        ("15.6%", "paːseɴto"),
    ] {
        let Some(phonemes) = by_input.get(input) else {
            panic!("the corpus has no sample for {input:?}, so nothing pins {marker:?}");
        };
        assert!(
            phonemes.contains(marker),
            "{input:?} should contain {marker:?}, got {phonemes:?}"
        );
    }

    // And the whole pipeline, not just the corpus strings.
    let actual = phonemizer
        .phonemize_with("三百", &options)
        .expect("phonemizes")
        .phonemes;
    assert_eq!(actual, "saɴbjaku");
}
