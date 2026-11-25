//! The word spans: which phonemes came from which word of the input.
//!
//! These tests pin the *contract*, not the exact phonemes — the corpus tests do
//! that. What matters here is that a span's phoneme range slices the phonemes
//! string into the word's own sounds, that its input range covers the word and
//! not the punctuation around it, and that a sentence whose numerals the engine
//! rewrote — the one rewrite this layer cannot trace — reports no spans at all
//! rather than spans nobody verified.

mod common;

use common::{chinese_options, english_options, japanese_options};
use phonemize::PhonemeSpan;

/// Structural checks every span must pass, whatever the language.
fn check(sentence: &str, phonemes: &str, spans: &[PhonemeSpan]) {
    assert!(
        !spans.is_empty(),
        "{sentence:?}: no spans, and this test asked for them"
    );
    let mut previous_end = 0;
    for span in spans {
        assert!(span.char_start < span.char_end, "{sentence:?}: {span:?}");
        assert!(span.phoneme_start < span.phoneme_end, "{sentence:?}: {span:?}");
        assert!(
            span.phoneme_start >= previous_end,
            "{sentence:?}: spans overlap or go backwards: {span:?}"
        );
        assert!(
            span.phoneme_end <= phonemes.chars().count(),
            "{sentence:?}: {span:?} past the phonemes ({phonemes:?})"
        );
        assert!(
            span.char_end <= sentence.len(),
            "{sentence:?}: {span:?} past the sentence"
        );
        // The slice must be real characters of the phonemes string, and must be
        // word material — not a lone space.
        let slice: String = phonemes
            .chars()
            .skip(span.phoneme_start)
            .take(span.phoneme_end - span.phoneme_start)
            .collect();
        assert!(
            !slice.trim().is_empty(),
            "{sentence:?}: span over empty phonemes: {span:?}"
        );
        previous_end = span.phoneme_end;
    }
}

#[test]
fn english_words_cover_their_own_characters() {
    let Some(phonemizer) = common::english_phonemizer() else {
        panic!("run scripts/setup/setup-lindera-dict.sh first");
    };
    let sentence = "Hello, world.";
    let result = phonemizer
        .phonemize_with(sentence, &english_options())
        .expect("phonemizes");
    let spans = result.spans.expect("two words, both traceable");

    check(sentence, &result.phonemes, &spans);
    assert_eq!(spans.len(), 2, "{spans:?}");
    // The punctuation is between the words and belongs to neither.
    assert_eq!((spans[0].char_start, spans[0].char_end), (0, 5));
    assert_eq!((spans[1].char_start, spans[1].char_end), (7, 12));
    // The first word's phonemes are the string's opening, before the comma.
    assert_eq!(spans[0].phoneme_start, 0);
    assert!(spans[1].phoneme_start > spans[0].phoneme_end);
}

#[test]
fn a_hyphen_is_neither_word_but_the_two_halves_are_spans() {
    let Some(phonemizer) = common::english_phonemizer() else {
        panic!("run scripts/setup/setup-lindera-dict.sh first");
    };
    // The segmenter sends `-` to an `other` run, so `well-known` is two Latin
    // runs. Each gets a span of its own; the hyphen is in neither.
    let sentence = "well-known";
    let result = phonemizer
        .phonemize_with(sentence, &english_options())
        .expect("phonemizes");
    let spans = result.spans.expect("two words, both traceable");

    check(sentence, &result.phonemes, &spans);
    assert_eq!(spans.len(), 2, "{spans:?}");
    assert_eq!((spans[0].char_start, spans[0].char_end), (0, 4));
    assert_eq!((spans[1].char_start, spans[1].char_end), (5, 10));
}

#[test]
fn a_sentence_the_engine_rewrote_keeps_the_words_it_left_alone() {
    let Some(phonemizer) = common::english_phonemizer() else {
        panic!("run scripts/setup/setup-lindera-dict.sh first");
    };
    // The engine expands `3` to a phrase, and its expansion is a mapping this
    // layer does not have — so the number itself gets no span. The words the
    // engine returned verbatim keep theirs, which is most English sentences'
    // worth of the feature.
    let sentence = "I have 3 cats.";
    let result = phonemizer
        .phonemize_with(sentence, &english_options())
        .expect("phonemizes");
    let spans = result.spans.expect("the words around the number are traceable");
    check(sentence, &result.phonemes, &spans);

    // `3` is character 7; no span may cover it, and the words on both sides
    // of it are covered.
    assert!(
        spans.iter().all(|span| !(span.char_start <= 7 && 7 < span.char_end)),
        "{spans:?}"
    );
    assert!(spans.iter().any(|span| span.char_end <= 7), "{spans:?}");
    assert!(spans.iter().any(|span| span.char_start >= 8), "{spans:?}");
    // The phonemes themselves are unchanged by all of this.
    assert!(result.phonemes.contains("kˈæts"), "{:?}", result.phonemes);
}

#[test]
fn chinese_words_cover_their_own_characters() {
    let Some(phonemizer) = common::chinese_phonemizer() else {
        panic!("run scripts/setup/setup-jieba-dict.sh first");
    };
    let sentence = "你好，世界。";
    let result = phonemizer
        .phonemize_with(sentence, &chinese_options())
        .expect("phonemizes");
    let spans = result.spans.expect("two words, both traceable");

    check(sentence, &result.phonemes, &spans);
    assert_eq!(spans.len(), 2, "{spans:?}");
    // 你好，世界。 — the comma is character 2, in neither word.
    assert_eq!((spans[0].char_start, spans[0].char_end), (0, 2));
    assert_eq!((spans[1].char_start, spans[1].char_end), (3, 5));
}

#[test]
fn chinese_words_within_one_han_run_are_separate_spans() {
    let Some(phonemizer) = common::chinese_phonemizer() else {
        panic!("run scripts/setup/setup-jieba-dict.sh first");
    };
    // One Han run, several words: the boundaries are jieba's, and each word is
    // its own span.
    let sentence = "今天天气很好。";
    let result = phonemizer
        .phonemize_with(sentence, &chinese_options())
        .expect("phonemizes");
    let spans = result.spans.expect("traceable words");
    check(sentence, &result.phonemes, &spans);
    assert!(spans.len() >= 2, "{spans:?}: one Han run, several words");
    // Consecutive spans partition the Han characters.
    for pair in spans.windows(2) {
        assert!(pair[0].char_end <= pair[1].char_start, "{spans:?}");
    }
}

#[test]
fn a_chinese_sentence_the_engine_rewrote_keeps_the_words_it_left_alone() {
    let Some(phonemizer) = common::chinese_phonemizer() else {
        panic!("run scripts/setup/setup-jieba-dict.sh first");
    };
    // The engine expands the number; the number itself gets no span, the words
    // around it keep theirs.
    let sentence = "营收10,000,000元。";
    let result = phonemizer
        .phonemize_with(sentence, &chinese_options())
        .expect("phonemizes");
    let spans = result.spans.expect("the words around the number are traceable");
    check(sentence, &result.phonemes, &spans);
    // `10,000,000` is characters 2..12; no span may cover any of it.
    assert!(
        spans
            .iter()
            .all(|span| !(span.char_start < 12 && 2 < span.char_end)),
        "{spans:?}"
    );
}

#[test]
fn japanese_dictionary_tokens_are_the_words() {
    let Some(phonemizer) = common::japanese_phonemizer() else {
        panic!("run scripts/setup/setup-lindera-dict.sh first");
    };
    let sentence = "今日は良い天気です。";
    let result = phonemizer
        .phonemize_with(sentence, &japanese_options())
        .expect("phonemizes");
    let spans = result.spans.expect("traceable tokens");
    check(sentence, &result.phonemes, &spans);

    // The tokens partition the text (the full stop is a run of its own and in
    // no span), so every Han/Kana character is inside exactly one span.
    let covered: usize = spans
        .iter()
        .map(|span| span.char_end - span.char_start)
        .sum();
    let han_kana: usize = sentence
        .chars()
        .filter(|ch| !ch.is_whitespace() && !matches!(ch, '。' | '、' | '，' | '.' | ','))
        .count();
    assert_eq!(covered, han_kana, "{spans:?}");
}

#[test]
fn a_japanese_sentence_the_engine_rewrote_keeps_the_words_it_left_alone() {
    let Some(phonemizer) = common::japanese_phonemizer() else {
        panic!("run scripts/setup/setup-lindera-dict.sh first");
    };
    // The engine reads `3` as 三. The digit itself is character 0 and no span
    // may cover it; the characters the engine returned verbatim — つ, の, りんご
    // — keep theirs.
    let sentence = "3つのりんご。";
    let result = phonemizer
        .phonemize_with(sentence, &japanese_options())
        .expect("phonemizes");
    let spans = result.spans.expect("the tokens after the numeral are traceable");
    check(sentence, &result.phonemes, &spans);
    assert!(spans.iter().all(|span| span.char_start >= 1), "{spans:?}");
    assert!(spans.iter().any(|span| span.char_start == 1), "{spans:?}");
}

#[test]
fn spans_cover_full_width_text_at_its_own_offsets() {
    let Some(phonemizer) = common::chinese_phonemizer() else {
        panic!("run scripts/setup/setup-jieba-dict.sh first");
    };
    // Full-width letters fold to ASCII, and the fold's ranges are what the
    // spans report — offsets into the *input*, not into the folded text.
    let sentence = "ＡＢＣ测试。";
    let result = phonemizer
        .phonemize_with(sentence, &chinese_options())
        .expect("phonemizes");
    if let Some(spans) = &result.spans {
        check(sentence, &result.phonemes, spans);
        // The Latin run covers ＡＢＣ: characters 0..3, whatever they became.
        let latin = spans
            .iter()
            .find(|span| span.char_start == 0)
            .expect("the folded letters are a span");
        assert_eq!(latin.char_end, 3, "{spans:?}");
    }
}
