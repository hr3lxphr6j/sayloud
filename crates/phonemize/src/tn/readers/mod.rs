//! The hand-written numeral readers, one per language that still has one.
//!
//! These are not "the old code kept around": they are the answer for a caller
//! that never called `prepare`, and they are the frozen pipeline that the
//! JavaScript parity corpora are still asserted against. The Chinese one is not
//! even a worse version of the same thing — it reads `2024` as a quantity
//! (二千零二十四) where the engine reads it as a year (二零二四) when the text
//! says 年, and that difference is a property of the *engine*, not of the reader.
//!
//! They run when `Lang::reader` asks for one — which is a caller that never
//! called `prepare`, a build whose grammars were not fetched, or a sentence the
//! engine could not read.
//!
//! **English has none**, and that is a decision rather than an omission: what it
//! had was a crate (`num2words`) reading the same numerals this engine reads, and
//! the copy was removed for 60 KB of the release wasm. `Lang::reader` returns
//! `None` for it, and `tn::normalize` turns the sentence into `NoReader` instead
//! of text with the digits missing — see that module for what a caller gets.

pub mod ja;
pub mod zh;
