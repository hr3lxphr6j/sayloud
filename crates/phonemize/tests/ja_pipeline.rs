//! The Japanese pipeline, end to end, against the real IPADic dictionary.
//!
//! Two things live here, and they answer different questions:
//!
//! - the segmenter tests say what the dictionary reads a word as, which is where
//!   a lindera or IPADic change would show up;
//! - the reference corpus says the whole pipeline produces the phonemes the
//!   reference chain produces, which is the acceptance criterion now that the
//!   JavaScript chain is gone.
//!
//! The corpus is `tests/fixtures/ja-reference.json`, and its two halves come from
//! different places on purpose: `kana` is what pyopenjtalk — the OpenJTalk chain,
//! which is what Kokoro's Japanese voices were trained with — reads the text as,
//! and `expected` is those readings put through this crate's own table.
//! `scripts/check/check-ja-reference.py` recomputes both from the reference, so a
//! wrong expectation fails there as well as here. Two kinds of sample are the
//! exceptions, and each says so in the file: the ones with a Latin run this crate
//! reads with its own English backend (`check: skip`), and the dictionary gaps
//! (`gap`), where `expected` is what this dictionary can reach today.

mod common;

use std::collections::HashMap;

use phonemize::dictionary::DictionaryRegistry;
use phonemize::dictionary::IPADIC_JA;
use phonemize::g2p::SegmenterJa;

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

    // The reading comes from IPADic's `pronunciation` field, looked up through
    // lindera's schema rather than by array index. `pronunciation` and not
    // `reading` because that is the field the reference chain uses: it is where
    // 学校 is ガッコー and the particle は is ワ.
    // A `pronunciation` field, not a `reading` one: 学校 is ガッコー, 新聞 is
    // シンブン. The two fields differ exactly where Japanese is not written the way
    // it is said — see the module comment — and 経営 is the one worth naming: our
    // IPADic keeps ケイエイ where the reference dictionaries have ケーエー, because
    // it collapses the ウ-row long vowels and not the エ-row ones. That is a gap in
    // the dictionary, not in this crate, and it is recorded as one in
    // `tests/fixtures/ja-reference.json`.
    for (text, expected) in [
        ("経営", "ケイエイ"),
        // 日本 reads ニッポン on its own and ニホン inside 日本語, and both
        // pipelines agree on both — the reading depends on how the sentence
        // segments, which is why 日本語 is in the reference corpus as well.
        ("日本", "ニッポン"),
        ("学校", "ガッコー"),
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

/// The reference corpus: `tests/fixtures/ja-reference.json`.
///
/// Every sample records where its expectation comes from. `expected` is what this
/// crate is asserted to produce; `kana` is the reading the reference tool
/// (pyopenjtalk, the OpenJTalk chain) gives the same text, and `reading` — when
/// present — is what the punctuation map and the text normalizer hand the
/// dictionary, which is the input that reading belongs to. Those two columns are
/// documentation for a failure, and `scripts/check/check-ja-reference.py` is what
/// checks them against the reference rather than against this crate.
///
/// The file replaces `ja-parity.json`, whose values were the JavaScript chain's
/// output. That chain is gone, and the readings it pinned are ones this crate now
/// calls wrong (`は` as ハ, `学校` as ガッコウ) — the corpus is anchored to the
/// reference chain instead, which is the one Kokoro's Japanese voices were
/// trained with. `the_pipeline_matches_the_reference_g2p` says what that means
/// for the acceptance criterion.
#[derive(serde::Deserialize)]
struct Corpus {
    samples: Vec<Sample>,
}

#[derive(serde::Deserialize)]
struct Sample {
    input: String,
    /// The reading the reference gives, in the reference's own alphabet.
    #[allow(dead_code)]
    kana: String,
    expected: String,
    /// Where the expectation came from, and what it replaced.
    #[allow(dead_code)]
    source: String,
    /// What the dictionary is handed, when that is not `input` itself.
    #[allow(dead_code)]
    reading: Option<String>,
}

fn corpus() -> Corpus {
    serde_json::from_str(include_str!("fixtures/ja-reference.json")).expect("the corpus parses")
}

#[test]
fn phonemizes_a_latin_run_instead_of_passing_it_through() {
    // These runs go to the English dictionary rather than through the frontend
    // as characters. `Chat` and `Q` are the two that now match the
    // JavaScript exactly, which is what closed their corpus notes.
    //
    // The Japanese half is not incidental: 使う used to be two runs — Han and
    // kana — so its kanji was read on its own as シ, and the sentence said
    // オシウ. Read as the word it is, it is ツカウ.
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();

    for (input, expected) in [
        // A word: looked up in CMU Dict.
        ("Chatを使う", "tʃˈætoʦukau"),
        // An initialism: read letter by letter, which is what keeps the acronym
        // audible instead of dropping it as an unknown word.
        ("APIを使う", "ə pˈiː aɪoʦukau"),
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
    // "Kokoro" read as K-O-K-O-R-O. It is read by rule instead: one reading
    // rather than six, and the same reading a lone English sentence gets
    // (`tests/en_g2p.rs`).
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

    assert_eq!(result.phonemes, "kɑkɔɹoʊoʦukau");
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

    assert_eq!(result.phonemes, "toːkjoːwaniʔpoɴnoɕutodesu.");
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
    // A whole English *sentence* needs numeral reading, because the CMU
    // dictionary skips digits rather than reading them, so `I have 3 cats` would
    // lose the 3. The Latin runs of a Japanese sentence never have that problem —
    // a digit is never part of a Latin run — which is why that path works without
    // this step. The full coverage of this path is in `en_g2p.rs`; what this pins
    // is that the dispatch in `lib.rs` reaches it.
    let phonemizer = phonemize::Phonemizer::new();
    let options = phonemize::PhonemizeOptions {
        vocab: "kokoro-v1".to_string(),
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
    // asserting that `zh` came back `pipeline-not-implemented`. That error has no
    // language left to fire for, and what is worth checking now is the property
    // that replaced it: every language the frontend table lists reaches a
    // pipeline, and the only thing an unprepared instance is missing is a
    // dictionary.
    //
    // Written as a loop over the table rather than as three assertions, so that
    // adding a language to `supported_languages` without a pipeline shows up here
    // as a `pipeline-not-implemented` failure rather than as a new test someone
    // has to remember to write.
    let phonemizer = phonemize::Phonemizer::new();

    for lang in ["zh-CN", "ja-JP"] {
        let options = phonemize::PhonemizeOptions {
            vocab: "kokoro-v1".to_string(),
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
        vocab: "kokoro-v1".to_string(),
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
    // The distinction that matters for the message the user sees:
    // this is "that voice cannot read this", not "this build is unfinished".
    let phonemizer = phonemize::Phonemizer::new();
    let options = phonemize::PhonemizeOptions {
        vocab: "kokoro-v11-zh".to_string(),
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
fn the_pipeline_matches_the_reference_g2p() {
    // This test used to be `the_pipeline_matches_the_javascript_one`, comparing
    // byte for byte against what the JavaScript chain produced. That chain is gone,
    // and what it produced was wrong in a way the vocabulary gate cannot see: it
    // read the dictionary one script run at a time, so `語る` came out カタリル and
    // `詳しい` lost its first kanji. The comparison now is the reference chain —
    // the one Kokoro's Japanese voices were trained with; see the fixture for
    // where each expectation comes from.
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();
    let corpus = corpus();

    assert!(
        corpus.samples.len() >= 50,
        "the corpus is meant to be more than a smoke test"
    );

    let mut failures: Vec<String> = Vec::new();
    for sample in &corpus.samples {
        let actual = phonemizer
            .phonemize_with(&sample.input, &options)
            .expect("phonemizes");

        if actual.phonemes != sample.expected {
            failures.push(format!(
                "{:?}\n    expected {:?} (the reference reads it {:?})\n    actual   {:?}",
                sample.input, sample.expected, sample.kana, actual.phonemes
            ));
        }
    }

    assert!(
        failures.is_empty(),
        "{} of {} samples diverged from the reference:\n  {}",
        failures.len(),
        corpus.samples.len(),
        failures.join("\n  ")
    );
}

#[test]
fn a_middle_dot_becomes_a_pause() {
    // The one expectation in the corpus that is a *decision* rather than a
    // reference reading: pyopenjtalk keeps `・` in its katakana, so the reference
    // has nothing to say about it here. Three implementations do: OpenJTalk's
    // dictionary gives the symbol the pronunciation `、`, and its full-context
    // labels make it the same pause as a comma; Style-Bert-VITS2 rewrites `・` to
    // `,`; misaki drops the character and leaves a space behind.
    //
    // Ours is the comma. A space is also in the v1.0 vocabulary, but a space is
    // the word separator misaki already emits between every two words, and a
    // pause is what a middle dot is for.
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };
    let options = japanese_options();

    let result = phonemizer
        .phonemize_with("春・夏の二季に分けて行われる。", &options)
        .expect("a middle dot is punctuation, not something to refuse");

    assert_eq!(result.phonemes, "haru, naʦunonikiniwaketeokonawareru.");
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
        .map(|sample| (sample.input.as_str(), sample.expected.as_str()))
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

/// What the WeText numeral step buys, at the phoneme level.
///
/// **The corpus has nothing in this table**, and for Japanese that is a stronger
/// statement than it looks: `ja-reference.json`'s expectations come from
/// pyopenjtalk rather than from the JavaScript frontend's own reader, and its rows
/// come out *identically* through the engine — including the eight with digits in
/// them. So `the_pipeline_matches_the_reference_g2p` holds through the shipped path
/// with nothing listed, and deleting the hand-written reader (2026-10-09) moved no
/// corpus expectation at all.
///
/// The rows below are what is *not* in the corpus, with the value through the
/// engine pinned; the column that used to hold the deleted reader's reading is
/// gone with it (a sentence with a digit in it no longer phonemizes at all without
/// an engine — `tn::NoReader`), so what remains is one pin instead of a comparison.
/// The comments say which reading the engine replaced, which is the part worth
/// keeping.
///
/// Three rows read *worse* than the reader, and they are here for the same reason
/// the `０` row in `wetext_ja.rs` is: a table of only the improvements could not
/// fail in the direction that matters.
#[test]
fn the_numeral_step_reads_these_entities() {
    let Some(segmenter) = segmenter() else {
        return;
    };
    let Some(tn) = common::japanese_tn() else {
        return;
    };
    let english = phonemize::g2p::EnglishG2p::new().ok();

    let table: &[(&str, &str)] = &[
        // A comma-grouped number: the old reader stopped at the separator.
        ("1,234", "seɴniçakusaɴʥuːjoɴ"),
        // A fraction, which the old reader read as two cardinals: いちに.
        ("1/2", "nibuɴnoiʨi"),
        // Currency, where the old pipeline lost the 円 and read the digits as two
        // separate quantities.
        ("¥1,200", "seɴniçakueɴ"),
        ("3,000円", "saɴzeɴeɴ"),
        // A unit, where the old reader handed `km` to the English dictionary and
        // got the letters K and M.
        ("2.5km", "niteɴɡokiromeːtoru"),
        // A telephone number inside a sentence: the grammar reads the hyphens as
        // a range and inserts マイナス. A bare one reads as a telephone number
        // (`tests/wetext_ja.rs`); this is the contextual case.
        ("電話は555-1234", "deɴwawaɡoçakuɡoʥuːɡomainasuseɴniçakusaɴʥuːjoɴ"),
        ("電話番号は090-1234-5678です。", "deɴwabaɴɡoːwakjuːmainasuseɴniçakusaɴʥuːjoɴmainasuɡoseɴroʔpjakunanaʥuːhaʨidesu."),
        // **The one genuine loss.** `０` normalizes to `〇` (U+3007), which no
        // script run in this crate claims, so it is dropped and the digit reads
        // as silence where it used to say れい. The reference produces `〇` too.
        ("０", ""),
    ];

    for (input, expected) in table {
        let actual =
            phonemize::pipeline::phonemize_ja(input, &segmenter, english.as_ref(), Some(&tn))
                .expect("phonemizes")
                .phonemes;

        assert_eq!(actual, *expected, "{input:?} through the numeral step");
    }
}
