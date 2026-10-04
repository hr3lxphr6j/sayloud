//! English text normalization, through the vendored WeText engine.
//!
//! The engine itself is [`crate::backends::wetext`]; this module is the seam
//! between it and the dictionary protocol — it turns the two FSTs the registry
//! holds into the [`Normalizer`] the English pipeline runs, and it is where the
//! design decisions about that live.
//!
//! # Why this is optional
//!
//! [`pipeline::phonemize_en`](crate::pipeline::phonemize_en) takes an
//! `Option<&Normalizer>` and falls back to the hand-written numeral reader when
//! it is `None`. English is the one language whose *phonemes* need no
//! dictionary — the CMU dictionary is compiled in (spec §2.3) — so making the
//! pipeline unreachable without one would be a contract change in service of a
//! feature. The FSTs are still declared as required dictionaries, so a caller
//! that goes through `prepare` gets them or gets an error; the fallback exists
//! for the caller that did not, and for a build whose assets were not fetched.
//!
//! # Why per instance rather than a global cache
//!
//! Upstream's own cache lives inside the [`Normalizer`], and the PoC cached one
//! per language in a `thread_local`. That is wrong here for two reasons: the
//! `Phonemizer` already owns everything else it needs per worker (the
//! segmenters), and a `thread_local` would be shared state between two
//! `Phonemizer`s on one thread — which is exactly the shape `cargo test
//! --test-threads=1` would take, turning "not prepared" into an order-dependent
//! answer.
//!
//! Parsing is the expensive half (12 MB of English FST, 52 ms measured in the
//! wasm) and it happens once, in `finish_loading`, so holding the parsed
//! normalizer for the life of the worker is what keeps the cost off the first
//! sentence.
//!
//! # What it costs at runtime
//!
//! Every English sentence used to pay the whole composition, because upstream's
//! English TN is deliberately not gated on digits — `should_normalize` returns
//! true for any non-empty English text, and the `\d` early exit only applies to
//! the other two languages (see modification 5 in `NOTICE` and the note on that
//! method). So the cost was ~4.6 ms per 100 characters, ~92% of it in the tagger.
//!
//! Since phase 9B.6 [`crate::backends::tn_gate`] answers "could there be anything
//! here for this engine to rewrite?" first, and a `false` means this normalizer is
//! never touched: 2.8 µs for 950 characters against the 43 ms the same text costs
//! below. The gate is a filter and not a second opinion about what needs
//! normalizing; `tests/tn_gate.rs` is what keeps it one.

use super::wetext::{Language, Normalizer, NormalizerConfig, WeTextError};

/// The relative name the English tagger is keyed under.
///
/// The same string upstream would have joined to its FST directory, kept
/// because it is what the normalizer asks for internally — see
/// [`crate::backends::wetext::Normalizer`].
const TAGGER: &str = "en/tn/tagger.fst";

/// The relative name the English verbalizer is keyed under.
const VERBALIZER: &str = "en/tn/verbalizer.fst";

/// Build the English normalizer from the two FSTs the registry delivered.
///
/// Both are the *TN* grammars; the `itn` and `prefix` files the Python package
/// also ships are not read by this configuration. `fix_contractions` is left at
/// its default (off), which is upstream's default too and matches what the
/// Python `wetext` does — English TN is not where an apostrophe should become
/// three words.
pub fn english(tagger: &[u8], verbalizer: &[u8]) -> Result<Normalizer, WeTextError> {
    let config = NormalizerConfig::new().with_lang(Language::En);

    Normalizer::from_bytes(
        config,
        [
            (TAGGER.to_string(), tagger),
            (VERBALIZER.to_string(), verbalizer),
        ],
    )
}
