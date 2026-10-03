//! The English pipeline, end to end.
//!
//! No dictionary fixture and no `prepare`: the CMU dictionary is compiled into
//! the module, so unlike `ja_pipeline.rs` these tests run everywhere and on the
//! first call.
//!
//! The number cases are what this phase is for. The CMU dictionary is a
//! dictionary and not a rule engine, so a digit has no pronunciation to find and
//! was skipped rather than read — measured before `numbers_to_english` ran,
//! `I have 3 cats` → `aɪ hæv kˈæts`, the 3 gone. Every sentence here is pinned to
//! its exact phonemes because that is what makes the absence audible in a diff.

use phonemize::{PhonemizeOptions, Phonemizer};

/// What a v1.0 English voice asks for.
fn options() -> PhonemizeOptions {
    PhonemizeOptions {
        frontend: "kokoro-v1".to_string(),
        lang: "en-US".to_string(),
    }
}

fn phonemize(text: &str) -> String {
    let phonemizer = Phonemizer::new();
    phonemizer
        .phonemize_with(text, &options())
        .expect("phonemizes")
        .phonemes
}

#[test]
fn plain_sentence() {
    let ipa = phonemize("hello world");

    assert_eq!(ipa, "həlˈoʊ wˈɜːld");
    assert!(!ipa.is_empty(), "should produce phonemes");
}

#[test]
fn sentence_with_number() {
    // The regression this phase exists to close. A digit is an `other` run, so
    // `keep_punctuation` dropped it; it has to become a word before the text is
    // segmented for the dictionary to have anything to look up.
    let ipa = phonemize("I have 3 cats");

    // "three" is /θɹˈiː/ — the θ is the part that cannot come from anything else
    // in the sentence, so it is the cheap check that the 3 was read.
    assert!(
        ipa.contains('θ'),
        "3 should phonemize as 'three' (θ): {ipa}"
    );
    assert_eq!(ipa, "aɪ hæv θɹˈiː kˈæts");
}

#[test]
fn sentence_with_large_number() {
    // Thousands are where the numeral reader stops being a digit table: the word
    // "thousand" is not a digit name, and neither is the "and" 2024 gains.
    assert_eq!(
        phonemize("There are 1000 ways"),
        "ðˈɛɹ ɑːɹ wˈʌn θˈaʊzənd wˈeɪz"
    );

    assert_eq!(
        phonemize("The year 2024"),
        "ðə jˈɪɹ tˈuː θˈaʊzənd ənd twˈɛntiːfˈɔːɹ"
    );
    // The hyphen in `num2words`' "twenty-four" is not in Kokoro's vocabulary, so
    // `keep_punctuation` drops it and the two words run together — which is what
    // the tokenizer has always done with it, since it would have deleted the
    // character itself. Reading it as a word boundary instead would be a change
    // to what the model hears, and is not this phase's question.
}

#[test]
fn sentence_with_decimal() {
    // A fraction is read digit by digit — "one four", not "fourteen" — which is
    // decided by the point and not by the length of the fraction.
    assert_eq!(phonemize("3.14 is pi"), "θɹˈiː pˈɔɪnt wˈʌn fˈɔːɹ ɪz pˈaɪ");
}

#[test]
fn does_not_report_not_implemented() {
    let phonemizer = Phonemizer::new();
    let result = phonemizer.phonemize_with("hello world", &options());

    assert!(
        result.is_ok(),
        "English pipeline should be wired: {:?}",
        result.err()
    );
}

#[test]
fn drops_a_cjk_run_instead_of_reading_it() {
    // `hello 世界` is English text with a word in a script this frontend has no
    // reading for, and a character Kokoro cannot use is worth less than the
    // sentence around it. Same answer `keep_punctuation` gives to a character it
    // does not know.
    assert_eq!(phonemize("hello 世界"), "həlˈoʊ");
}

#[test]
fn splits_a_contraction_because_the_segmenter_does() {
    // A known gap, pinned so that it cannot stop being true without someone
    // noticing: `segment_text` sends `'` to an `other` run, so `don't` reaches
    // the dictionary as `don` and `t`, and the `t` is then read as the letter.
    // Invisible in the Latin runs of a Japanese sentence — a run there is one
    // word by construction — so a whole English sentence is what exposes it.
    // The fix belongs in the shared segmenter, which the Japanese side splits on
    // too, and is not this phase's work.
    //
    // The apostrophe itself is gone from the output, because it is not in the
    // vocabulary and the tokenizer would delete it — see `KOKORO_PUNCTUATION`.
    assert_eq!(phonemize("don't stop"), "dˈɑntˈiː stˈɑp");
}
