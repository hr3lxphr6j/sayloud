//! The hand-written numeral readers, one per language.
//!
//! These are not "the old code kept around": they are the answer for a caller
//! that never called `prepare`, and they are the phase 6 pipeline that the
//! JavaScript parity corpora are still asserted against. The Chinese one is not
//! even a worse version of the same thing — it reads `2024` as a quantity
//! (二千零二十四) where the engine reads it as a year (二零二四) when the text
//! says 年, and that difference is a property of the *engine*, not of the reader.
//!
//! They run when `Lang::fallback` asks for one — which is a caller that never
//! called `prepare`, a build whose grammars were not fetched, or a sentence the
//! engine could not read.

pub mod en;
pub mod ja;
pub mod zh;
