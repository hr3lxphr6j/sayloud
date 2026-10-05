//! English G2P: the Latin runs of a CJK sentence, and the
//! words the dictionary does not have (phase 9A).
//!
//! # Why not espeak
//!
//! The plan called for espeak-ng compiled into this module. That route does not
//! exist: `espeak-ng-sys` is not on crates.io, the C sources do not compile for
//! `wasm32-unknown-unknown` (no libc, and the host `ar` writes Mach-O archives
//! that `rust-lld` cannot read), espeak needs a filesystem for its own data, and
//! the pure-Rust port is GPL-3.0.
//!
//! What this module uses instead is [`piper_plus_g2p`]: the CMU Pronouncing
//! Dictionary (123,455 entries) plus ARPAbet→IPA, MIT-licensed, with the
//! dictionary embedded by `include_str!` so there is nothing to fetch and no
//! filesystem to need. The cost is 3.75 MB in the module and a 27 ms parse the
//! first time English is used.
//!
//! # The three things this module decides
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
//! **A word the dictionary does not have is read by rule.** CMU Dict is a
//! dictionary, not a rule engine: `Kokoro`, `OpenAI`, `GitHub` and `ChatGPT` are
//! not in it. Until phase 9A they were spelled letter by letter, which is not a
//! pronunciation — `GitHub` was `dʒˈiː aɪ tˈiː ˈeɪtʃ jˈuː bˈiː`, six letters read
//! as six letters — and phase 9A is the fix:
//! [`headtts_en`](crate::backends::headtts_en), the letter-to-sound rules of NRL
//! Report 7948 as HeadTTS adapted them, gives `GitHub` `ɡɪθəb` and `TypeScript`
//! `tɪpɛskɹɪpt`. The dictionary is still asked first, so the change is confined
//! to words that used to get nothing.
//!
//! **A reading with no vowel letter in the word is not attempted.** `http`,
//! `xyz` and `sql` are not words, they are initialisms typed in lower case, and
//! the rules read them as `ttp`, `sɪz` and `skl` — the letter-shape answers to a
//! question about a word. Spelling the letters is strictly more informative
//! there, so a run with no `A`, `E`, `I`, `O` or `U` in it never reaches the
//! rules. See [`has_vowel_letter`], which is where the line is drawn and why it is
//! drawn on the input rather than on the answer.

use crate::backends::headtts_en;
use piper_plus_g2p::english::EnglishPhonemizer;
use piper_plus_g2p::Phonemizer;

/// Why English phonemization failed.
///
/// There is no "unknown word" variant on purpose: a word the dictionary does not
/// have is read by rule, and a word the rules cannot read is spelled — neither is
/// a failure. What is left is the two ways the machinery itself can break.
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

/// English text to IPA, through the CMU Pronouncing Dictionary and then, for a
/// word the dictionary does not have, through the NRL 7948 rules.
///
/// Built once per phonemizer and kept, because building it parses the whole
/// dictionary: 27 ms and ~13 MB of hash map, measured in the wasm. The caller
/// decides when that is worth paying — see `Phonemizer::english` in `lib.rs`,
/// which builds it on the first Latin run rather than on `prepare`, so a
/// Japanese sentence with no Latin text in it never pays.
///
/// The rule table adds nothing to that cost. It is a `&'static [Rule]` of
/// literals, and the regular expressions it names are compiled one at a time, by
/// the first word that tries them.
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
    /// Three answers, in this order:
    ///
    /// 1. **The dictionary**, which is the only one of the three that is a
    ///    pronunciation rather than a reading of the spelling.
    /// 2. **The rules**, for a word the dictionary does not have — see the module
    ///    docs, and [`headtts_en`](crate::backends::headtts_en) for what they are
    ///    and are not.
    /// 3. **The letters**, for a run with no vowel letter in it and for the empty
    ///    run. This is what every OOV word used to get, kept as the last resort so
    ///    that nothing that used to be pronounced becomes silent.
    ///
    /// Both of the first two go through [`is_initialism`] first: an all-capitals
    /// run is spelled, and it is spelled out of the dictionary, so it never
    /// reaches the rules.
    ///
    /// The caller still records a warning when the answer is empty, which is now
    /// only reachable for a run that is empty or whose every letter is absent
    /// from the dictionary — that is, not for a run of ASCII letters.
    pub fn phonemize(&self, run: &str) -> Result<String, EnglishError> {
        // An initialism is spelled — by the dictionary, one letter at a time.
        // Both halves matter: the rule is the JavaScript one, and the dictionary
        // is what makes `A P I` three phoneme strings instead of nothing.
        let dictionary_text = spelled_out(run);
        let (tokens, _) = self
            .phonemizer
            .phonemize_with_prosody(&dictionary_text)
            .map_err(|error| EnglishError::Phonemize {
                detail: error.to_string(),
            })?;

        // The trait hands back one token per IPA character, with the stress
        // marks and the word separators as tokens of their own, so joining them
        // is what reconstructs the string the frontend wants.
        let result = tokens.concat();
        if !result.is_empty() {
            return Ok(result);
        }

        // OOV, and not an initialism: `dictionary_text` is the run itself, and the
        // dictionary had nothing for it. Phase 9A reads it by rule instead of
        // spelling it — unless it is not shaped like a word at all.
        if has_vowel_letter(run) {
            if let Some(ipa) = headtts_en::phonemize(run) {
                if !ipa.is_empty() {
                    return Ok(ipa);
                }
            }
        }

        // The last resort. Decision 1.B: a word nothing can read is spelled
        // letter by letter — "Kokoro" → "K O K O R O" rather than silent, easier
        // to notice and debug.
        self.spell_out(run)
    }

    /// The letters of a run, one at a time, through the dictionary.
    ///
    /// Unconditional, unlike [`spelled_out`], which spaces only an initialism:
    /// this is the fallback, and it is reached *because* the dictionary had
    /// nothing for the run as it was written. Re-asking for it unchanged would be
    /// the same question.
    fn spell_out(&self, run: &str) -> Result<String, EnglishError> {
        if run.is_empty() {
            return Ok(String::new());
        }

        let (tokens, _) = self
            .phonemizer
            .phonemize_with_prosody(&space_letters(run))
            .map_err(|error| EnglishError::Phonemize {
                detail: error.to_string(),
            })?;
        Ok(tokens.concat())
    }
}

/// Whether a run of letters is shaped like a word.
///
/// This is the line between a reading and a spelling, and it is drawn because the
/// rules are a *spelling* oracle: asked for a word they answer with the best
/// reading of the letters, and asked for a run of letters that is not a word they
/// answer anyway. `http` comes out `ttp` with no vowel in it, `sql` comes out
/// `skl`, and `xyz` — which does have a vowel-shaped answer — comes out `sɪz`,
/// one syllable where a speaker would say three letters. `ˈeɪtʃ tˈiː tˈiː pˈiː` is
/// longer and it is what the letters are *for*.
///
/// **On the input rather than on the answer**, which is the decision worth
/// recording. A check on the answer — "does this reading have a syllable in
/// it?" — catches `ttp` and `skl` and misses `xyz`, because `sɪz` has a vowel; the
/// consonant cluster is wrong for a reason the vowel does not explain. What the
/// three runs have in common is upstream of the engine: written as letters, none
/// of them contains `A`, `E`, `I`, `O` or `U`. That is also the cheaper question,
/// since it is asked before any rule is tried.
///
/// **`Y` does not count**, which is the one judgement call. It is a vowel letter
/// in `rhythm` and a consonant letter in `yaml`, and every `y`-only OOV word worth
/// reaching the rules — `rhythm`, `myth`, `sylph`, `lynch` — is in CMU Dict
/// already. Counting it would read `xyz` as a word; not counting it spells a word
/// the dictionary has stopped having, which is the safer of the two failures.
///
/// Real English words with none of the five letters do exist — `hmm`, `tsk`,
/// `nth` — and they are spelled out rather than read by rule. That is the same
/// answer they got before phase 9A, so nothing regressed to get here.
pub fn has_vowel_letter(run: &str) -> bool {
    run.chars()
        .any(|character| matches!(character.to_ascii_uppercase(), 'A' | 'E' | 'I' | 'O' | 'U'))
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

    space_letters(run)
}

/// The letters of a run, separated by spaces: `API` → `A P I`.
///
/// This is what makes the dictionary read them one at a time, and it is the shape
/// `phonemizeSpelled` builds on the JavaScript side.
fn space_letters(run: &str) -> String {
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
        // The extended set from the phase 4 plan. These are dictionary words, and
        // phase 9A moved them nowhere — the point of asserting them here is that
        // the rule path did not get in front of the dictionary.
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
    fn a_word_outside_the_dictionary_is_read_by_rule() {
        // Phase 9A. Before it, each of these was spelled: `Kokoro` was
        // `kˈeɪ ˈoʊ kˈeɪ ˈoʊ ˈɑːɹ ˈoʊ` and `GitHub` was
        // `dʒˈiː aɪ tˈiː ˈeɪtʃ jˈuː bˈiː`.
        for (run, expected) in [
            ("Kokoro", "kɑkɔɹoʊ"),
            ("OpenAI", "oʊpɛneɪ"),
            ("GitHub", "ɡɪθəb"),
            ("TypeScript", "tɪpɛskɹɪpt"),
            ("PyTorch", "paɪtɔɹtʃ"),
            ("YouTube", "jutub"),
        ] {
            assert_eq!(ipa(run), expected, "{run}");
        }
    }

    #[test]
    fn a_lowercase_initialism_is_spelled_rather_than_read_as_a_cluster() {
        // The rules answer a spelling question, and a run of letters that is not
        // a word still gets an answer — `ttp` for `http` is a consonant cluster
        // with no syllable in it, and `sɪz` for `xyz` is one syllable where a
        // speaker says three letters. The letters are what the run is *for*.
        assert!(!has_vowel_letter("http"));
        assert!(!has_vowel_letter("xyz"));
        assert_eq!(ipa("http"), "ˈeɪtʃ tˈiː tˈiː pˈiː");
        assert_eq!(ipa("xyz"), "ˈɛks wˈaɪ zˈiː");
        assert_eq!(ipa("sql"), "ˈɛs kjˈuː ˈɛl");
        // `json` has an `o`, so it is read as a word and the rules get it, which
        // is the boundary this rule draws and not a claim that `dʒsən` is right.
        assert_eq!(ipa("json"), "dʒsən");
    }

    #[test]
    fn an_all_capital_run_is_still_spelled_rather_than_read() {
        // The rule engine offers `ttp` for `HTTP` and `sɪz` for `XYZ`, which is
        // why the capitals rule comes first and keeps them away from it. Pinned
        // because "the rules improved OOV words" must not turn into "the rules
        // read initialisms".
        assert_eq!(ipa("HTTP"), "ˈeɪtʃ tˈiː tˈiː pˈiː");
        assert_eq!(ipa("XYZ"), "ˈɛks wˈaɪ zˈiː");
        assert_eq!(ipa("JSON"), "dʒˈeɪ ˈɛs ˈoʊ ˈɛn");
    }

    #[test]
    fn has_vowel_letter_is_about_the_word_and_not_the_reading() {
        for run in ["Kokoro", "GitHub", "json", "kubectl", "yaml", "TypeScript"] {
            assert!(has_vowel_letter(run), "{run:?}");
        }
        for run in [
            "http", "https", "xyz", "sql", "ssh", "html", "css", "", "hmm",
        ] {
            assert!(!has_vowel_letter(run), "{run:?}");
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
