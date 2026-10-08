//! The vocabulary gate: what stops a phoneme the model cannot use.
//!
//! The two Kokoro models do not share a phoneme inventory, and a character
//! outside one is not an error the tokenizer reports — its normaliser is a
//! `Replace` with the empty string, so the phoneme is silently deleted and the
//! word is heard without it. The gate turns that into a message.
//!
//! The Japanese pipeline is where the need was found: the kana
//! table had an ASCII `g` where the vocabulary has `ɡ` (U+0261), and every ガ行
//! syllable was read as ア行. Nothing noticed, because the output was a string of
//! valid-looking IPA. So the tests below are mostly about *what gets through*.

mod common;

use phonemize::g2p::ChinesePinyin;
use phonemize::vocab::{validate_phonemes, Vocab, VocabError};
use phonemize::{PhonemizeError, PhonemizeOptions, Phonemizer};

use common::{japanese_options, japanese_phonemizer};

/// The phonemes the gate accepts, as a set of characters.
fn vocabulary(vocab: Vocab) -> std::collections::HashSet<char> {
    vocab.characters().collect()
}

// -------------------------------------------------------------- what it takes

#[test]
fn accepts_a_phoneme_string_from_its_own_vocabulary() {
    // The IPA the JavaScript pipeline produces for 你好世界, which the model was
    // trained on. Every character in it is in v1.0's vocabulary except U+0329,
    // which is one of the two the normaliser strips.
    validate_phonemes("ni↓ xau↓ ʂɻ̩↘ ʨje↘", Vocab::V1_0).expect("v1.0's own IPA");

    // The same for the other model, which spells the same sentence in zhuyin and
    // uses tone digits rather than arrows.
    validate_phonemes("ㄋㄧ2ㄏㄠ3/ㄕ4ㄐㄧㄝ4", Vocab::V1_1_ZH).expect("v1.1-zh's own zhuyin");
}

#[test]
fn allows_the_two_combining_marks_the_tokenizer_strips() {
    // U+032F (COMBINING INVERTED BREVE BELOW) is in 好's IPA and U+0329
    // (COMBINING VERTICAL LINE BELOW) in 世's, and neither is in either
    // vocabulary — the tokenizer's normaliser deletes both. Rejecting them would
    // reject every Japanese sentence, so they are allowed by name.
    for vocab in [Vocab::V1_0, Vocab::V1_1_ZH] {
        validate_phonemes("a\u{032F}", vocab).expect("U+032F");
        validate_phonemes("a\u{0329}", vocab).expect("U+0329");
    }

    // ʂɻ̩ is where U+0329 actually comes from, and it is only v1.0's: `ɻ` is one
    // of the nine characters v1.1-zh does not have. That is not the combining
    // mark's problem, and the message says so rather than blaming it.
    validate_phonemes("ʂɻ\u{0329}", Vocab::V1_0).expect("世's IPA is v1.0's");
    let error = validate_phonemes("ʂɻ\u{0329}", Vocab::V1_1_ZH).expect_err("v1.1-zh has no ɻ");
    assert_eq!(error.characters, ['ɻ']);
}

#[test]
fn allows_whitespace() {
    // Word boundaries are spaces in v1.0 and slashes in v1.1-zh, and the
    // collapse at the end of a pipeline leaves neither leading nor trailing —
    // but a tab or a newline in the middle must not be reported as a phoneme the
    // model does not have.
    validate_phonemes("ni↓ \txau↓\n", Vocab::V1_0).expect("whitespace is not a phoneme");
}

#[test]
fn accepts_the_empty_string() {
    // A run that produced nothing is a pipeline question, not a vocabulary one.
    validate_phonemes("", Vocab::V1_0).expect("nothing to check");
    validate_phonemes("", Vocab::V1_1_ZH).expect("nothing to check");
}

// ------------------------------------------------------------ what it refuses

#[test]
fn refuses_a_character_only_the_other_model_has() {
    // The four tone arrows are v1.0's and v1.1-zh has none of them; the zhuyin
    // symbols are v1.1-zh's and v1.0 has none of those. Getting the vocabulary
    // wrong for the chosen voice is exactly this mistake, and it is the one the
    // gate is for.
    let error = validate_phonemes("ni↓", Vocab::V1_1_ZH).expect_err("v1.1-zh has no arrows");
    assert_eq!(error.characters, ['↓']);

    let error = validate_phonemes("ㄋㄧ2", Vocab::V1_0).expect_err("v1.0 has no zhuyin");
    // And no digits either: the tone is an arrow in v1.0, so a tone *number* is
    // a character the tokenizer would drop — which is why the two paths cannot
    // share an output format.
    assert_eq!(error.characters, ['ㄋ', 'ㄧ', '2']);
}

#[test]
fn names_every_character_that_is_missing_once_each() {
    // The whole list, deduplicated and in the order it appears: a report that
    // stopped at the first character would make a systematically wrong table
    // look like a single typo.
    let error = validate_phonemes("ㄅㄆㄅ2", Vocab::V1_0).expect_err("none of these are v1.0's");
    assert_eq!(error.characters, ['ㄅ', 'ㄆ', '2']);

    // And the code point, because two of the characters that matter here are
    // indistinguishable at a glance: `g` (U+0067) and `ɡ` (U+0261).
    let message = error.to_string();
    assert!(message.contains("ㄅ (U+3105)"), "{message}");
    assert!(message.contains("2 (U+0032)"), "{message}");
}

#[test]
fn refuses_an_ascii_g_where_the_vocabulary_has_a_script_g() {
    // The bug that motivated the gate, written down as a test. The two are
    // different characters and only one is in the vocabulary; the other is
    // deleted by the normaliser, and ガ行 reads as ア行.
    validate_phonemes("ɡa↓", Vocab::V1_0).expect("U+0261 is the one v1.0 has");

    let error = validate_phonemes("ga↓", Vocab::V1_0).expect_err("U+0067 is not");
    assert_eq!(error.characters, ['g']);
}

#[test]
fn reports_which_id_the_vocabulary_belongs_to() {
    let error = validate_phonemes("↓", Vocab::V1_1_ZH).expect_err("v1.1-zh has no arrows");
    assert_eq!(error.vocab, Vocab::V1_1_ZH);
    assert!(error.to_string().contains("kokoro-v11-zh"), "{error}");
    assert_eq!(error.code(), "vocabulary-mismatch");
}

// ------------------------------------------------------------ the two tables

#[test]
fn has_a_vocabulary_for_the_two_ids_and_no_others() {
    assert_eq!(Vocab::for_id("kokoro-v1"), Some(Vocab::V1_0));
    assert_eq!(Vocab::for_id("kokoro-v11-zh"), Some(Vocab::V1_1_ZH));
    assert_eq!(Vocab::for_id("kokoro-v2"), None);
    assert_eq!(Vocab::for_id(""), None);
}

#[test]
fn the_two_vocabularies_are_the_sizes_that_were_measured() {
    // The counts are the measured `model.vocab` sizes. Asserted because a
    // truncated data file would make the gate pass everything, which is the
    // failure mode of a gate: it is invisible until something gets through.
    assert_eq!(vocabulary(Vocab::V1_0).len(), 115);
    assert_eq!(vocabulary(Vocab::V1_1_ZH).len(), 172);

    // And the difference is not a superset: each has characters the other does
    // not, so a single shared table would be wrong for both.
    let v1 = vocabulary(Vocab::V1_0);
    let v11 = vocabulary(Vocab::V1_1_ZH);
    assert_eq!(v1.difference(&v11).count(), 9);
    assert_eq!(v11.difference(&v1).count(), 66);
    assert_eq!(v1.intersection(&v11).count(), 106);
}

// --------------------------------------------------------------- substitution

#[test]
fn repairs_the_rhotic_vowel_v11_zh_does_not_have() {
    // espeak reads `never` as `nˈɛvɚ`, and v1.1-zh's vocabulary has neither `ɚ`
    // nor a combining rhotic — the normaliser would delete it and the word would
    // lose its last sound. `əɹ` is what it should have been, and both characters
    // are in the vocabulary, so the gate repairs rather than refuses.
    let repaired = Vocab::V1_1_ZH.repair("nˈɛvɚ");
    assert_eq!(repaired, "nˈɛvəɹ");
    validate_phonemes(&repaired, Vocab::V1_1_ZH).expect("the repair is in the vocabulary");

    // v1.0 *has* `ɚ`, and replacing it there would be a change to phonemes the
    // model was trained on. The substitution is per vocabulary, not global.
    assert_eq!(Vocab::V1_0.repair("nˈɛvɚ"), "nˈɛvɚ");
}

#[test]
fn leaves_a_string_it_has_nothing_to_repair_alone() {
    // Borrowed, not copied: this runs on every phonemize call.
    assert!(matches!(
        Vocab::V1_1_ZH.repair("ni↓ xau↓"),
        std::borrow::Cow::Borrowed(_)
    ));
    assert!(matches!(
        Vocab::V1_1_ZH.repair("nˈɛvɚ"),
        std::borrow::Cow::Owned(_)
    ));
}

// -------------------------------------------------------------- the pipelines

#[test]
fn the_japanese_pipeline_passes_the_v1_vocabulary() {
    let Some(phonemizer) = japanese_phonemizer() else {
        return;
    };

    // The real thing, through the real dictionary, for text that covers kana,
    // kanji, numerals and punctuation. This is the assertion the kana table's
    // ASCII `g` would have failed.
    for text in [
        "こんにちは、世界。",
        "経営",
        "がっこう",
        "ガ行のガ",
        "2022年",
        "東京は日本の首都です。",
    ] {
        let result = phonemizer
            .phonemize_with(text, &japanese_options())
            .unwrap_or_else(|error| panic!("{text}: {error}"));
        validate_phonemes(&result.phonemes, Vocab::V1_0)
            .unwrap_or_else(|error| panic!("{text}: {error}"));
    }
}

#[test]
fn the_english_pipeline_passes_both_vocabularies() {
    // The 106 characters the two models share are the whole English IPA set, so
    // English phonemes belong to both — with one exception that the gate has to
    // repair rather than report: `ɚ`, and `never` is the word it was found on.
    for id in ["kokoro-v1", "kokoro-v11-zh"] {
        let vocab = Vocab::for_id(id).expect("a known vocabulary");
        let options = PhonemizeOptions {
            vocab: id.to_string(),
            lang: "en-US".to_string(),
        };

        for text in [
            "never",
            "hello world",
            // Spelled out: nothing is prepared in this test, and English without
            // the engine refuses a sentence with a digit in it rather than reading
            // it (`pipeline::phonemize_en`). The words are what the engine would
            // have produced, so the phoneme coverage is the same.
            "I have three cats",
            "The letter was better",
        ] {
            let result = Phonemizer::new()
                .phonemize_with(text, &options)
                .unwrap_or_else(|error| panic!("{text} ({id}): {error}"));
            validate_phonemes(&result.phonemes, vocab)
                .unwrap_or_else(|error| panic!("{text} ({id}): {error}"));
        }
    }
}

#[test]
fn the_english_output_through_v11_zh_has_no_rhotic_vowel() {
    // The repair, end to end rather than as a string function: v1.1-zh cannot
    // have `ɚ` in its output, and `never` is a word espeak gives one to.
    let options = PhonemizeOptions {
        vocab: "kokoro-v11-zh".to_string(),
        lang: "en-US".to_string(),
    };
    let result = Phonemizer::new()
        .phonemize_with("never", &options)
        .expect("English phonemizes");

    assert!(!result.phonemes.contains('ɚ'), "{}", result.phonemes);
    assert!(
        result.phonemes.contains("əɹ"),
        "the rhotic should still be audible: {}",
        result.phonemes
    );
}

#[test]
fn the_chinese_han_run_passes_the_v1_vocabulary() {
    // The Chinese backend, validated by the gate. Not reachable through
    // `phonemize` without the Chinese dictionary fixture, so this calls the
    // backend directly.
    let phonemes = ChinesePinyin::new()
        .han_to_ipa("你好世界")
        .expect("the run phonemizes");
    validate_phonemes(&phonemes, Vocab::V1_0).expect("Chinese IPA belongs to v1.0");
}

// ----------------------------------------------------------- the gate in the
// pipeline

#[test]
fn every_punctuation_mark_kept_is_in_both_vocabularies() {
    // The gate checks what a *pipeline* produces; this checks the table the
    // pipelines filter through, so the two cannot disagree. It is here because
    // they already did: `KOKORO_PUNCTUATION` listed `-` and `'`, the vocabulary
    // has neither, and `don't stop` was the first thing the gate refused.
    //
    // Both vocabularies, because `keep_punctuation` is shared by the Japanese and
    // English pipelines and either vocabulary can be the one in use.
    let v1 = vocabulary(Vocab::V1_0);
    let v11 = vocabulary(Vocab::V1_1_ZH);

    for mark in [
        ' ', ',', '.', '!', '?', ':', ';', '(', ')', '"', '$', '—', '…', '“', '”',
    ] {
        // What `keep_punctuation` keeps is the whole question, so ask it rather
        // than restating the list: a mark it drops cannot reach the gate.
        assert_eq!(
            phonemize::text::keep_punctuation(&mark.to_string()),
            mark.to_string(),
            "{mark:?} should survive keep_punctuation"
        );
        assert!(v1.contains(&mark), "v1.0 has no {mark:?}");
        assert!(v11.contains(&mark), "v1.1-zh has no {mark:?}");
    }

    // And the two the table used to keep, which it must not.
    for mark in ['-', '\''] {
        assert_eq!(
            phonemize::text::keep_punctuation(&mark.to_string()),
            "",
            "{mark:?} is not in the vocabulary and must be dropped"
        );
    }
}

#[test]
fn a_vocabulary_mismatch_becomes_a_pipeline_error() {
    // `phonemize_with` returns this through `?`, so the code the JavaScript side
    // switches on has to be the vocabulary's and not something generic.
    let error = PhonemizeError::from(VocabError {
        vocab: Vocab::V1_0,
        characters: vec!['ㄅ'],
        phonemes: "ㄅ".to_string(),
    });
    assert_eq!(error.code(), "vocabulary-mismatch");
    assert!(error.to_string().contains("ㄅ (U+3105)"), "{error}");
}
