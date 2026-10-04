//! Text normalization, vendored from `wetext-rs` 0.1.2.
//!
//! This is a copy of [`wetext-rs`](https://github.com/SpenserCai/wetext-rs) —
//! SpenserCai's Rust port of
//! [`WeTextProcessing`](https://github.com/wenet-e2e/WeTextProcessing), the
//! weighted-FST text normalizer PaddleSpeech uses — kept in-tree rather than
//! depended on, because the crate cannot be used from
//! `wasm32-unknown-unknown` as published and this project will not carry a git
//! fork of a nine-star crate. See `NOTICE` for the licence and the six
//! modifications, and `p6-wetext-evaluation.md` §五 for the measurements behind
//! that decision.
//!
//! # What it does
//!
//! Reads OpenFST binaries and runs the three-stage WeText TN over them:
//! a *tagger* FST rewrites the input into tagged entities
//! (`date { year: "2024" month: "1" }`), [`TokenParser`] reorders each
//! entity's fields into the order its verbalizer expects, and a *verbalizer*
//! FST turns the reordered entity into words. [`Normalizer`] is the whole of it.
//!
//! English is the language wired up today
//! ([`crate::backends::wetext_tn`]); the FSTs for the other two are not
//! shipped yet, so `zh`/`ja` configurations would fail to find the FSTs they
//! ask for.
//!
//! # No filesystem, no lazy loading
//!
//! Upstream loads FSTs on demand from a directory through `std::fs`. There is
//! no filesystem here (see the crate README), so [`Normalizer::from_bytes`] is
//! the only constructor and every FST a configuration can ask for has to be
//! supplied up front. That is modification 2 of the four in `NOTICE`, and it is
//! also why [`Normalizer::normalize`] takes `&self`: with nothing left to load
//! lazily there is no cache to mutate.

mod config;
mod contractions;
mod error;
mod normalizer;
mod text_normalizer;
mod token_parser;

pub use config::{Language, NormalizerConfig, Operator};
pub use error::{Result, WeTextError};
pub use normalizer::Normalizer;
pub use text_normalizer::FstTextNormalizer;
