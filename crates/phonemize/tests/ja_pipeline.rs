//! The Japanese pipeline, end to end, against the real IPADic dictionary.
//!
//! Two things live here, and they answer different questions:
//!
//! - the segmenter tests say what the dictionary reads a word as, which is where
//!   a lindera or IPADic change would show up;
//! - the parity corpus says the whole pipeline still produces the phonemes the
//!   JavaScript one produced, which is the P6 acceptance criterion (§0.4).
//!
//! The corpus is `tests/fixtures/ja-parity.json`, generated from the JavaScript
//! pipeline by `tests/unit/models/phonemize/ja-parity.test.ts` before phase 8
//! deleted that chain. It is frozen — the generator is gone — so this test is what
//! keeps the Rust output pinned to it.

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
fn phonemizes_a_latin_run_instead_of_passing_it_through() {
    // Phase 3 handed these runs to the frontend as characters; phase 4 gives them
    // to the English dictionary. `Chat` and `Q` are the two that now match the
    // JavaScript exactly, which is what closed their corpus notes.
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();

    for (input, expected) in [
        // A word: looked up in CMU Dict.
        ("Chatを使う", "tʃˈætoɕiu"),
        // An initialism: read letter by letter, which is what keeps the acronym
        // audible instead of dropping it as an unknown word.
        ("APIを使う", "ə pˈiː aɪoɕiu"),
        ("あQい", "akjˈuːi"),
    ] {
        let result = phonemizer
            .phonemize_with(input, &options)
            .expect("phonemizes");
        assert_eq!(result.phonemes, expected, "{input}");
        assert!(
            result.warnings.is_empty(),
            "{input} has nothing to warn about: {:?}",
            result.warnings
        );
    }
}

#[test]
fn reads_a_latin_run_the_dictionary_does_not_have_by_rule() {
    // This test used to be `warns_about_a_latin_run_the_dictionary_does_not_have`
    // and asserted the letter-by-letter fallback, `kˈeɪ ˈoʊ kˈeɪ ˈoʊ ˈɑːɹ ˈoʊ` —
    // "Kokoro" read as K-O-K-O-R-O. Phase 9A reads it by rule instead, which is
    // the point of the phase: it is one reading rather than six, and it is the
    // same reading a lone English sentence gets (`tests/en_g2p.rs`).
    //
    // The warning channel is untouched and the expectation "no warnings" is now
    // structural rather than incidental: a Latin run reaches the letter fallback
    // only if neither the dictionary nor the rules nor the letters produce
    // anything, and all 26 letters are in the dictionary. So an English warning
    // is unreachable through this pipeline — kept as the honest answer for a run
    // that produces nothing, not as a message anyone should expect to see.
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();

    let result = phonemizer
        .phonemize_with("Kokoroを使う", &options)
        .expect("phonemizes");

    assert_eq!(result.phonemes, "kɑkɔɹoʊoɕiu");
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
}

#[test]
fn does_not_warn_about_text_with_no_latin_in_it() {
    // The common case, and the one that decides whether the warning channel is
    // usable at all: a message on every Japanese sentence would be noise.
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();

    let result = phonemizer
        .phonemize_with("東京は日本の首都です。", &options)
        .expect("phonemizes");

    assert_eq!(result.phonemes, "toukjouhaniʔpoɴnoɕutodesu.");
    assert!(result.warnings.is_empty(), "{:?}", result.warnings);
}

#[test]
fn an_initialism_is_never_dropped() {
    // Why the drop is narrower than it sounds: an all-capitals run is read from
    // single letters, and `every_letter_of_the_alphabet_has_a_reading` is what
    // says those are all in the dictionary. So the words that can go missing are
    // mixed-case proper nouns, never acronyms.
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();

    for input in ["API", "LLM", "GPT", "Q", "PDF"] {
        let result = phonemizer
            .phonemize_with(input, &options)
            .expect("phonemizes");
        assert!(
            !result.phonemes.is_empty(),
            "{input} came out silent, which is the failure an initialism is supposed to be immune to"
        );
        assert!(result.warnings.is_empty(), "{input}: {:?}", result.warnings);
    }
}

#[test]
fn phonemizes_a_whole_english_sentence_now_that_numerals_are_read() {
    // A whole English *sentence* was not phase 4's work: it needs numeral
    // reading, because the CMU dictionary skips digits rather than reading them,
    // so `I have 3 cats` would have lost the 3. The Latin runs of a Japanese
    // sentence never had that problem — a digit is never part of a Latin run —
    // which is why that path was wired and this one was not. `numbers_en.rs` is
    // the missing half, so the sentence is now read out. The full coverage of
    // this path is in `en_g2p.rs`; what this pins is that the dispatch in
    // `lib.rs` no longer reports it as unimplemented.
    let phonemizer = phonemize::Phonemizer::new();
    let options = phonemize::PhonemizeOptions {
        frontend: "kokoro-v1".to_string(),
        lang: "en-US".to_string(),
    };

    let result = phonemizer
        .phonemize_with("hello world", &options)
        .expect("English has a whole-sentence pipeline now");

    assert_eq!(result.phonemes, "həlˈoʊ wˈɜːld");
}

#[test]
fn every_language_the_frontend_lists_reaches_a_pipeline() {
    // This test used to be `reports_a_language_whose_pipeline_is_not_built_yet`,
    // asserting that `zh` came back `pipeline-not-implemented`. Phase 6 wired the
    // last language, so there is no such language left, and what is worth
    // checking now is the property that replaced it: every language the frontend
    // table lists reaches a pipeline, and the only thing an unprepared instance
    // is missing is a dictionary.
    //
    // Written as a loop over the table rather than as three assertions, so that
    // adding a language to `supported_languages` without a pipeline shows up here
    // as a `pipeline-not-implemented` failure rather than as a new test someone
    // has to remember to write.
    let phonemizer = phonemize::Phonemizer::new();

    for lang in ["zh-CN", "ja-JP"] {
        let options = phonemize::PhonemizeOptions {
            frontend: "kokoro-v1".to_string(),
            lang: lang.to_string(),
        };

        // Not `pipeline-not-implemented`: the pipeline is there, the word list is
        // not. The two are different problems with different fixes, which is the
        // distinction `PhonemizeError` exists to make.
        let error = phonemizer
            .phonemize_with("你好", &options)
            .expect_err("nothing was prepared");

        assert_eq!(error.code(), "dictionary-not-loaded", "{lang}");
    }

    // English is the one that needs no preparation, because its dictionary is
    // compiled in — so this is the arm where "wired up" and "ready" are the same
    // thing.
    let options = phonemize::PhonemizeOptions {
        frontend: "kokoro-v1".to_string(),
        lang: "en-US".to_string(),
    };
    assert!(phonemizer.phonemize_with("hello", &options).is_ok());
}

#[test]
fn the_unwired_language_code_is_still_stable() {
    // `pipeline-not-implemented` is unreachable through `phonemize_with` today —
    // see the test above — but the variant stays as the honest answer for the
    // next language added to `supported_languages` before its pipeline exists,
    // and the JavaScript side switches on the code. Pinned directly, because no
    // call can reach it.
    let error = phonemize::PhonemizeError::NotImplemented {
        lang: "xx".to_string(),
    };

    assert_eq!(error.code(), "pipeline-not-implemented");
    assert!(error.to_string().contains("xx"));
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
    // "known and accepted" about something that is now a bug. This is what
    // caught the two notes phase 4 made stale — `Chatを使う` and `あQい` matched
    // the JavaScript once the English backend landed, so their notes had to go
    // rather than stay as a claim about a gap that no longer exists.
    //
    // `APIを使う` is the one still here, and it is a different kind of note than
    // it was: the pass-through is gone, and what is left is piper's
    // `ə pˈiː aɪ` against espeak's `ɐ pˈiː ˈaɪ`.
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

/// What the phase 9E numeral step buys, at the phoneme level.
///
/// **The corpus has nothing in this table**, which is itself the finding: all 40
/// Japanese corpus samples come out identically with and without the engine, so
/// `the_pipeline_matches_the_javascript_one` still holds through the shipped path.
/// The rows below are what is not in the corpus, with both sides pinned so a
/// failure says which of the two readers changed.
///
/// Three rows read *worse*, and they are here for the same reason the `０` row in
/// `wetext_ja.rs` is: a table of only the improvements could not fail in the
/// direction that matters.
#[test]
fn the_numeral_step_reads_these_entities() {
    let Some(segmenter) = segmenter() else {
        return;
    };
    let Some(tn) = common::japanese_tn() else {
        return;
    };
    let english = phonemize::backends::g2p_en::EnglishG2p::new().ok();

    let table: &[(&str, &str, &str)] = &[
        // A comma-grouped number: the old reader stopped at the separator.
        ("1,234", "seɴniçakusaɴʥuujoɴ", "iʨi,niçakusaɴʥuujoɴ"),
        // A fraction, which the old reader read as two cardinals: いちに.
        ("1/2", "nibuɴnoiʨi", "iʨini"),
        // Currency, where the old pipeline lost the 円 and read the digits as two
        // separate quantities.
        ("¥1,200", "seɴniçakueɴ", "iʨi,niçaku"),
        ("3,000円", "saɴzeɴeɴ", "saɴ,reieɴ"),
        // A unit, where the old reader handed `km` to the English dictionary and
        // got the letters K and M.
        ("2.5km", "niteɴɡokiromeːtoru", "niteɴɡokˈeɪ ˈɛm"),
        // A telephone number inside a sentence: the grammar reads the hyphens as
        // a range and inserts マイナス. A bare one reads as a telephone number
        // (`tests/wetext_ja.rs`); this is the contextual case.
        (
            "電話は555-1234",
            "deɴwahaɡoçakuɡoʥuuɡomainasuseɴniçakusaɴʥuujoɴ",
            "deɴwahaɡoçakuɡoʥuuɡoseɴniçakusaɴʥuujoɴ",
        ),
        (
            "電話番号は090-1234-5678です。",
            "deɴwabaɴɡouhakjuumainasuseɴniçakusaɴʥuujoɴmainasuɡoseɴroʔpjakunanaʥuuhaʨidesu.",
            "deɴwabaɴɡouhakjuuʥuuseɴniçakusaɴʥuujoɴɡoseɴroʔpjakunanaʥuuhaʨidesu.",
        ),
        // **The one genuine loss.** `０` normalizes to `〇` (U+3007), which no
        // script run in this crate claims, so it is dropped and the digit reads
        // as silence where it used to say れい. The reference produces `〇` too.
        ("０", "", "rei"),
    ];

    for (input, with, without) in table {
        let before = phonemize::pipeline::phonemize_ja(input, &segmenter, english.as_ref(), None)
            .expect("phonemizes")
            .phonemes;
        let after =
            phonemize::pipeline::phonemize_ja(input, &segmenter, english.as_ref(), Some(&tn))
                .expect("phonemizes")
                .phonemes;

        assert_eq!(before, *without, "{input:?} without the numeral step");
        assert_eq!(after, *with, "{input:?} with WeText");
        assert_ne!(with, without, "{input:?} is in the table but did not move");
    }
}
