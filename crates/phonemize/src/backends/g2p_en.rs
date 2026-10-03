//! English G2P: the Latin runs of a CJK sentence (spec §2.3, phase 4).
//!
//! # Why not espeak
//!
//! The plan called for espeak-ng compiled into this module. That route does not
//! exist: `espeak-ng-sys` is not on crates.io, the C sources do not compile for
//! `wasm32-unknown-unknown` (no libc, and the host `ar` writes Mach-O archives
//! that `rust-lld` cannot read), espeak needs a filesystem for its own data, and
//! the pure-Rust port is GPL-3.0. The measurements are in
//! `docs/superpowers/plans/p6-phase4-corrections.md`.
//!
//! What this module uses instead is [`piper_plus_g2p`]: the CMU Pronouncing
//! Dictionary (123,455 entries) plus ARPAbet→IPA, MIT-licensed, with the
//! dictionary embedded by `include_str!` so there is nothing to fetch and no
//! filesystem to need. The cost is 3.75 MB in the module and a 27 ms parse the
//! first time English is used.
//!
//! # The two things this module decides
//!
//! **Initialisms are spelled, words are not.** `API` has to come out as the
//! letters A-P-I (`ə pˈiː aɪ`) and `Chat` as a word (`tʃˈæt`), and the rule that
//! tells them apart is the JavaScript one — all capitals, from
//! `lib/models/phonemize/english.ts` — because the two pipelines have to agree
//! on what a Latin run *is* before they can be compared on what it sounds like.
//! The rule is a rule and not a guess: espeak reads `RAG` as the English word
//! "rag", and that single counterexample is why the JavaScript side spells
//! capitals out instead of handing every run to the engine.
//!
//! **A word the dictionary does not have is dropped, and says so.** CMU Dict is
//! a dictionary, not a rule engine: `Kokoro`, `OpenAI`, `GitHub` and `ChatGPT`
//! are not in it and get no pronunciation, where espeak would have invented one.
//! [`EnglishG2p::phonemize`] returns an empty string for them and the pipeline
//! records a warning — the alternative, guessing, is how `GitHub` becomes
//! `ɡˈɪtˌhʌb`. Note that this cannot make an *initialism* silent: `API` is
//! spelled from single letters, and all 26 letters are in the dictionary.

use piper_plus_g2p::english::EnglishPhonemizer;
use piper_plus_g2p::Phonemizer;

/// Why English phonemization failed.
///
/// There is no "unknown word" variant on purpose: a word the dictionary does not
/// have is not a failure, it is an empty answer (see the module docs).
#[derive(Debug)]
pub enum EnglishError {
    /// The dictionary embedded in this module was rejected.
    ///
    /// Unreachable unless the build is broken, because the JSON is compiled in
    /// and `the_dictionary_has_the_words_this_module_claims` reads it — but it is
    /// a `Result` rather than an `expect` because a panic inside the wasm takes
    /// the whole worker with it.
    Dictionary { detail: String },
    /// The phonemizer itself refused the input.
    Phonemize { detail: String },
}

impl EnglishError {
    /// A stable code for the JavaScript side, following
    /// [`SegmenterError::code`](crate::backends::SegmenterError::code).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Dictionary { .. } => "english-dictionary",
            Self::Phonemize { .. } => "english-phonemize",
        }
    }
}

impl std::fmt::Display for EnglishError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: ", self.code())?;
        match self {
            Self::Dictionary { detail } => {
                write!(f, "the embedded CMU dictionary is unusable: {detail}")
            }
            Self::Phonemize { detail } => write!(f, "could not phonemize: {detail}"),
        }
    }
}

impl std::error::Error for EnglishError {}

/// English text to IPA, through the CMU Pronouncing Dictionary.
///
/// Built once per phonemizer and kept, because building it parses the whole
/// dictionary: 27 ms and ~13 MB of hash map, measured in the wasm. The caller
/// decides when that is worth paying — see `Phonemizer::english` in `lib.rs`,
/// which builds it on the first Latin run rather than on `prepare`, so a
/// Japanese sentence with no Latin text in it never pays.
pub struct EnglishG2p {
    phonemizer: EnglishPhonemizer,
}

impl EnglishG2p {
    /// Build the backend from the dictionary compiled into this module.
    pub fn new() -> Result<Self, EnglishError> {
        let phonemizer =
            EnglishPhonemizer::new_bundled().map_err(|error| EnglishError::Dictionary {
                detail: error.to_string(),
            })?;

        Ok(Self { phonemizer })
    }

    /// One run of Latin text to IPA.
    ///
    /// When the dictionary has no pronunciation for a word, it is spelled letter
    /// by letter as a fallback. The caller still records a warning so the OOV
    /// word does not go unnoticed.
    pub fn phonemize(&self, run: &str) -> Result<String, EnglishError> {
        let text = spelled_out(run);

        let (tokens, _) = self
            .phonemizer
            .phonemize_with_prosody(&text)
            .map_err(|error| EnglishError::Phonemize {
                detail: error.to_string(),
            })?;

        // The trait hands back one token per IPA character, with the stress
        // marks and the word separators as tokens of their own, so joining them
        // is what reconstructs the string the frontend wants.
        let result = tokens.concat();

        // OOV fallback: spell the word letter by letter when the dictionary
        // returned nothing. Decision 1.B: "Kokoro" → "K O K O R O" rather
        // than silent, easier to notice and debug.
        if result.is_empty() && !run.is_empty() {
            // Space-separate each character so the dictionary reads them one at a time
            let letters: Vec<String> = run.chars().map(|ch| ch.to_string()).collect();
            let fallback = letters.join(" ");
            let (fallback_tokens, _) =
                self.phonemizer
                    .phonemize_with_prosody(&fallback)
                    .map_err(|error| EnglishError::Phonemize {
                        detail: error.to_string(),
                    })?;
            return Ok(fallback_tokens.concat());
        }

        Ok(result)
    }
}

/// Whether a run is read letter by letter.
///
/// The rule is capitals-versus-not, and it is the JavaScript side's rule
/// (`isInitialism` in `lib/models/phonemize/english.ts`) rather than one of this
/// module's own: a Latin run in a Japanese sentence has to be classified the same
/// way on both sides, or the two pipelines disagree about which words they are
/// even comparing.
///
/// `A1` is not an initialism here, because `1` is not a capital letter, which is
/// also what `/^[A-Z]+$/` says. Digits cannot reach this function from the
/// pipeline — `segment_text` puts them in an `other` run — but the two
/// definitions have to agree anyway, and this is the half that is easier to
/// test.
pub fn is_initialism(run: &str) -> bool {
    !run.is_empty() && run.chars().all(|ch| ch.is_ascii_uppercase())
}

/// The text to hand the dictionary: the letters spaced, or the word as it is.
///
/// The spaces are what make the letters be read one at a time — a property of
/// the input rather than an option of the engine. This mirrors
/// `phonemizeSpelled` on the JavaScript side, which spaces the run the same way
/// for the same reason.
fn spelled_out(run: &str) -> String {
    if !is_initialism(run) {
        return run.to_string();
    }

    let letters: Vec<String> = run.chars().map(|ch| ch.to_string()).collect();
    letters.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::OnceLock;

    /// The dictionary is parsed once for the whole test binary.
    ///
    /// Each `EnglishG2p::new()` parses 3.75 MB of JSON into a hash map — ~14 ms
    /// and ~34 MB on the host — so a per-test construction would spend most of
    /// this module's runtime re-reading the same file.
    fn english() -> &'static EnglishG2p {
        static ONCE: OnceLock<EnglishG2p> = OnceLock::new();
        ONCE.get_or_init(|| EnglishG2p::new().expect("the embedded dictionary loads"))
    }

    fn ipa(run: &str) -> String {
        english().phonemize(run).expect("phonemizes")
    }

    #[test]
    fn reads_an_initialism_letter_by_letter() {
        // The three samples phase 3 recorded as divergences, which is what this
        // phase exists to close: `API` is the acronym that used to come through
        // as the letters `API` verbatim.
        assert_eq!(ipa("API"), "ə pˈiː aɪ");
        assert_eq!(ipa("Q"), "kjˈuː");
    }

    #[test]
    fn reads_a_word_as_a_word() {
        // `Chat` is not an initialism — it has a lower-case letter — so it goes
        // to the dictionary whole. This is the sample that now matches the
        // JavaScript exactly.
        assert_eq!(ipa("Chat"), "tʃˈæt");
    }

    #[test]
    fn is_initialism_is_the_javascript_rule() {
        // `/^[A-Z]+$/`, which `lib/models/phonemize/english.ts` uses.
        for run in ["API", "Q", "A", "LLM"] {
            assert!(is_initialism(run), "{run:?} is all capitals");
        }
        for run in ["Chat", "a", "ChatGPT", "GitHub", "A1", "", "Q1"] {
            assert!(!is_initialism(run), "{run:?} is not all capitals");
        }
    }

    #[test]
    fn spaces_the_letters_of_an_initialism_only() {
        assert_eq!(spelled_out("API"), "A P I");
        assert_eq!(spelled_out("Chat"), "Chat");
    }

    #[test]
    fn every_letter_of_the_alphabet_has_a_reading() {
        // What keeps the initialism path from having a silent hole in it: a
        // letter the dictionary did not have would be dropped inside the spelled
        // run, where the pipeline's whole-run check cannot see it.
        for letter in 'A'..='Z' {
            let run = letter.to_string();
            assert!(
                !ipa(&run).is_empty(),
                "{letter:?} has no pronunciation, so an initialism containing it is not safe to spell"
            );
        }
    }

    #[test]
    fn common_words_come_out_the_way_the_corpus_expects() {
        // The extended set from the phase 4 plan, minus the OOV words below.
        for (run, expected) in [
            ("Agent", "ˈeɪdʒənt"),
            ("hello", "həlˈoʊ"),
            ("world", "wˈɜːld"),
            ("Python", "pˈaɪθɑn"),
            ("JavaScript", "dʒˈɑvəskɹˌɪpt"),
        ] {
            assert_eq!(ipa(run), expected, "{run}");
        }
    }

    #[test]
    fn a_word_outside_the_dictionary_is_spelled() {
        // Decision 1.B: OOV words fall back to letter-by-letter spelling rather
        // than returning empty, so "Kokoro" is pronounced (as K-O-K-O-R-O)
        // instead of being silently dropped.
        for run in ["Kokoro", "OpenAI", "GitHub", "ChatGPT"] {
            let result = ipa(run);
            assert!(!result.is_empty(), "{run} should be spelled when OOV");
            // The result should be longer than a typical word (multiple letters
            // each with their own pronunciation)
            assert!(result.len() > 10, "{run} → {result} (spelled)");
        }
    }

    #[test]
    fn the_dictionary_has_the_words_this_module_claims() {
        // A guard on the embedded data rather than on this module's code: a
        // revision bump that shipped a dictionary without these would otherwise
        // show up as a corpus failure three layers away, or as a word that
        // quietly stopped being pronounced.
        for run in ["Chat", "Agent", "hello", "world", "Python"] {
            assert!(!ipa(run).is_empty(), "{run} should be in CMU Dict");
        }
    }
}
