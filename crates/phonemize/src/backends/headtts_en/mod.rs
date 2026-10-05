//! HeadTTS's letter-to-sound rules: the spelling of a word the dictionary does
//! not have (phase 9A).
//!
//! # Why this is here
//!
//! The English pipeline reads a word out of the CMU Pronouncing Dictionary, and
//! a word the dictionary does not have used to be spelled letter by letter —
//! `GitHub` came out as `dʒiː aɪ tiː eɪtʃ juː biː`, six letters read as six
//! letters. That is not a pronunciation, it is the absence of one made audible,
//! and it is worst exactly where it matters most in a browser extension: product
//! names, surnames and place names, which are the words a dictionary of common
//! English is least likely to have.
//!
//! What replaces it is the rule table HeadTTS uses for the same job — the
//! English language module of [HeadTTS](https://github.com/met4citizen/HeadTTS),
//! which is an adaptation of the letter-to-sound rules of NRL Report 7948,
//! *Automatic Translation of English Text to Phonetics by Means of
//! Letter-to-Sound Rules* (1976). `GitHub` becomes `ɡɪθəb`, `TypeScript`
//! becomes `tɪpɛskɹɪpt`, `YouTube` becomes `jutub`. They are not transcriptions
//! of a pronunciation — no rule table is — but they are attempts at one, and an
//! attempt is what the alternative did not even make.
//!
//! # What it is not
//!
//! **Not a dictionary, and not consulted first.** A word the dictionary has keeps
//! the dictionary's answer; see [`EnglishG2p`](super::EnglishG2p), which is where
//! the two are put in order. The rules are the fallback, and they only ever see
//! what the dictionary refused.
//!
//! **Not an initialism reader.** `API` and `LLM` are read letter by letter on
//! purpose, by the pipeline's own capitals rule, before either the dictionary or
//! these rules are reached. A rule engine asked for `HTTP` offers `ttp`, and
//! asked for `XYZ` offers `sɪz`; both are worse than the letters. The rule table
//! is for words that are *shaped* like words, and an all-capitals run is not.
//!
//! **Not a size problem.** 309 rules — the "7948" in the report title is the
//! report's number, not a rule count — as a `&'static [Rule]` of pattern,
//! advance and phonemes. The generated `rules.rs` is 25 KB of source and about
//! 16 KB of wasm data, against the 3.75 MB dictionary compiled in beside it.
//!
//! # Layout
//!
//! - [`rules`] is generated (`scripts/generate/gen-headtts-rules.mjs`) from a fixture that
//!   is a dump of upstream's own constructor, so it cannot disagree with HeadTTS
//!   about what a rule means.
//! - [`engine`] is the loop, ported from `Language#phonemizeWord`.
//! - [`phonemize`] is the two together, and [`to_ipa`] is the notation the rest of
//!   the pipeline wants.
//!
//! # Licence
//!
//! HeadTTS is MIT, (c) 2025 Mika Suominen; the rule data in this module is a
//! transcription of it. `LICENSE` beside this file is the copyright notice and
//! the licence text, and `NOTICE` records what was taken, from which revision,
//! and what was changed. Nothing here is copied C or a vendored crate: the port
//! is a Rust re-implementation of a JavaScript loop, and the tables are data.
//!
//! The NRL report itself is a US Government publication and is not the licensed
//! work; the adaptation of its rules into a machine-readable table is.

pub mod engine;
pub mod rules;

pub use engine::{normalize, phonemize_native, to_ipa, trace};

/// The phonemes for a word the dictionary does not have, as IPA.
///
/// HeadTTS's rules, with [`to_ipa`] applied — which is the form the pipeline and
/// the vocabulary gate both work in. `phonemize_native` is the same reading
/// without the translation, and is what the parity tests compare against
/// upstream.
///
/// `None` when the word has a character no rule could even be tried for, which a
/// word of letters cannot have. An empty string is a real answer: `H` is silent,
/// so a word of nothing but `H` is a real, empty reading.
pub fn phonemize(word: &str) -> Option<String> {
    phonemize_native(word).map(|native| to_ipa(&native))
}
