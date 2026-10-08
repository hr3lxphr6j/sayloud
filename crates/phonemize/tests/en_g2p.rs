//! The English pipeline, end to end, with nothing prepared.
//!
//! No dictionary fixture and no `prepare`: the CMU dictionary is compiled into
//! the module, so unlike `ja_pipeline.rs` these tests run everywhere and on the
//! first call.
//!
//! **What that costs is the numeral step.** The CMU dictionary is a dictionary
//! and not a rule engine, so a digit has no pronunciation to find — and English
//! has no hand-written reader any more (`tn::Lang::reader`; the note where the
//! crate used to be declared is in `Cargo.toml`). So a sentence with a digit in it
//! is refused rather than read with the digit missing, which is what
//! [`the_numeral_step_refuses_what_it_cannot_read`] pins; the readings the engine
//! gives those sentences are in `wetext_en.rs`, which does prepare.
//!
//! Everything else here is text the engine was never needed for: ordinary prose
//! and the words the dictionary does not have. A sentence the engine *would* have
//! read differently — a contraction, a capital run, an abbreviation — is read the
//! older way rather than refused (`tn::gate::drops_without_engine`), and
//! `splits_a_contraction_because_the_segmenter_does` is that boundary.
//!
//! **The rule path changes nothing for a word in CMU Dict**, which is worth
//! stating rather than leaving to a diff: every word in the sentences at the top
//! is in the dictionary, so none of them reaches the rules. A word the
//! dictionary does not have is where the rules answer, and there was no such word
//! in this file to move — the OOV cases below are new tests, not moved
//! expectations. The one expectation in the tree that did move is in
//! `ja_pipeline.rs`, where `Kokoro` was pinned to its letter-by-letter spelling.

use phonemize::{PhonemizeOptions, Phonemizer};

/// What a v1.0 English voice asks for.
fn options() -> PhonemizeOptions {
    PhonemizeOptions {
        vocab: "kokoro-v1".to_string(),
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
fn the_numeral_step_refuses_what_it_cannot_read() {
    // The boundary the removal of the numeral reader drew, and the reason it is a
    // refusal rather than a reading: without an engine, `I have 3 cats` used to
    // come out `aɪ hæv kˈæts` — the 3 gone from the IPA without a word said about
    // it. Silence about a character is worse than an error about a sentence, so
    // the step declines instead.
    //
    // `prepare` is what fixes it, and it is the *same* failure the other two
    // languages raise for a missing dictionary: `NotPrepared`, code
    // `dictionary-not-loaded` (`lib.rs` maps it there).
    let phonemizer = Phonemizer::new();
    for text in [
        // A digit: no dictionary has a pronunciation for it.
        "I have 3 cats",
        "The year 2024",
        "3.14 is pi",
        // A symbol the grammar maps to a word, with no digit to carry it.
        "It costs $",
        // A full-width form: not classified as a letter at all, so the whole run
        // is dropped — `Ｈｅｌｌｏ world` lost `Ｈｅｌｌｏ`.
        "Ｈｅｌｌｏ world",
    ] {
        let error = phonemizer
            .phonemize_with(text, &options())
            .expect_err("the numeral step has no reader to fall back to");
        let message = error.to_string();
        assert!(
            message.contains("dictionary-not-loaded"),
            "{text:?} should be refused as a missing dictionary, got {message:?}"
        );
    }
}

#[test]
fn a_reading_with_no_engine_is_still_a_reading() {
    // The other side of that boundary: a contraction, a capital run and an
    // abbreviation all *read* without an engine — worse than the engine reads
    // them, and that is what an unprepared caller has always had — so they are not
    // refused with it. `tn::gate::drops_without_engine` is the line, and this is
    // the behaviour it is drawn for: `We'll` comes out as `We` `L` `L` here
    // (`wiːˈɛl ˈɛl ɡˈoʊ`) where the engine says `wiː wɪl ɡˈoʊ`, and `HTTP` is
    // spelled either way.
    assert_eq!(phonemize("We'll go"), "wiːˈɛl ˈɛl ɡˈoʊ");
    assert_eq!(phonemize("HTTP"), "ˈeɪtʃ tˈiː tˈiː pˈiː");
    assert_eq!(phonemize("Mon"), "mˈoʊn");
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
    // too.
    //
    // The apostrophe itself is gone from the output, because it is not in the
    // vocabulary and the tokenizer would delete it — see `KOKORO_PUNCTUATION`.
    //
    // Both halves reach the dictionary: `don` and `t` are both in CMU Dict, so
    // the rules never see this case.
    assert_eq!(phonemize("don't stop"), "dˈɑntˈiː stˈɑp");
}

// ---------------------------------------------------------------------------
// The words the dictionary does not have
//
// Without the rules every test below would be the same sentence, spelled letter
// by letter: `Kokoro speaks` → `kˈeɪ ˈoʊ kˈeɪ ˈoʊ ˈɑːɹ ˈoʊ spˈiːks`. Six letters
// read as six letters is not a pronunciation, and these are the words a
// dictionary of common English is least likely to have and a reader is most
// likely to type.
// ---------------------------------------------------------------------------

#[test]
fn reads_a_word_the_dictionary_does_not_have_by_rule() {
    // The letter-to-sound rules of NRL Report 7948, as HeadTTS adapted them. The
    // dictionary is asked first (`keeps_the_dictionary_in_front_of_the_rules`),
    // so nothing here had a reading before.
    for (text, expected) in [
        ("Kokoro speaks", "kɑkɔɹoʊ spˈiːks"),
        ("GitHub and OpenAI", "ɡɪθəb ənd oʊpɛneɪ"),
        ("TypeScript is a language", "tɪpɛskɹɪpt ɪz ə lˈæŋɡwədʒ"),
        ("YouTube", "jutub"),
        ("PyTorch", "paɪtɔɹtʃ"),
        ("localhost", "lˈoʊkɔlhoʊst"),
    ] {
        assert_eq!(phonemize(text), expected, "{text}");
    }
}

#[test]
fn keeps_the_dictionary_in_front_of_the_rules() {
    // The rules are a fallback and not an improvement pass: a word CMU Dict has
    // keeps the dictionary's answer, even when the rules would give a different
    // one. `Shakespeare` is the clear case — the rules read it `ʃækɛspiɹ`, the
    // dictionary says `ʃˈeɪkspˌiːɹ`, and the dictionary is the one that is a
    // transcription rather than a reading. `through` is the same shape (`θɹuː`
    // against the rules' `θɹu`).
    //
    // Asserted through the pipeline so it is the *order* being tested, not the
    // rule engine's output: swapping the two would change both sentences.
    assert_eq!(
        phonemize("Shakespeare wrote Hamlet"),
        "ʃˈeɪkspˌiːɹ ɹˈoʊt hˈæmlət"
    );
    assert_eq!(phonemize("through the door"), "θɹuː ðə dˈɔːɹ");
}

#[test]
fn reads_an_initialism_letter_by_letter_even_though_the_rules_have_an_answer() {
    // The rule engine offers `ttp` for `HTTP`, `dʒsən` for `JSON` and `ə` for
    // `A`, and every one of those is worse than the letters. The capitals rule
    // runs first and keeps all-capitals runs away from it, which is what stops
    // "the rules made OOV words better" from also meaning "acronyms stopped being
    // spelled".
    assert_eq!(
        phonemize("The API is a LLM"),
        "ðə ə pˈiː aɪ ɪz ə ˈɛl ˈɛl ˈɛm"
    );
    assert_eq!(phonemize("HTTP"), "ˈeɪtʃ tˈiː tˈiː pˈiː");
    assert_eq!(phonemize("XYZ"), "ˈɛks wˈaɪ zˈiː");
}

#[test]
fn spells_a_lowercase_initialism_because_it_is_not_shaped_like_a_word() {
    // A run with no `A`, `E`, `I`, `O` or `U` in it is not a word, and the rules
    // read it as one: `http` → `ttp`, `xyz` → `sɪz`, `sql` → `skl`. The letters
    // are what the run is for, so it never reaches the rules.
    //
    // `json` has an `o` and does reach them — `dʒsən` is not right either, but it
    // is a reading of a word-shaped run and the boundary has to be somewhere the
    // next reader can check.
    assert_eq!(
        phonemize("xyz http json sql"),
        "ˈɛks wˈaɪ zˈiː ˈeɪtʃ tˈiː tˈiː pˈiː dʒsən ˈɛs kjˈuː ˈɛl"
    );
}

#[test]
fn a_rule_reading_stays_inside_the_vocabulary() {
    // Every phoneme a rule emits has to be one Kokoro's tokenizer keeps, and the
    // gate is what turns one it does not into an error rather than into a
    // silently deleted character. This is the end-to-end half of
    // `tests/headtts_en.rs::the_vocabulary_keeps_every_phoneme_the_rules_can_emit`:
    // that test asks the vocabulary, this one asks `phonemize_with`, which is
    // where the gate actually runs.
    let phonemizer = Phonemizer::new();
    for text in ["Kokoro", "GitHub and OpenAI", "TypeScript", "wojciechowski"] {
        let result = phonemizer
            .phonemize_with(text, &options())
            .unwrap_or_else(|error| panic!("{text:?} was refused: {error:?}"));
        assert!(!result.phonemes.is_empty(), "{text:?}");
    }
}
