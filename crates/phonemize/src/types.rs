//! The shapes that cross the JS boundary.
//!
//! These mirror the TypeScript interfaces in `lib/models/phonemize-rust.ts`.
//! Rust keeps snake_case field names; `rename_all` makes the wire format
//! camelCase to match. The Rust half is snake_case and the TypeScript half is
//! camelCase, so the field rename is what makes the wire format the second one —
//! and nothing else would catch a mismatch before the first real serialization.

use serde::{Deserialize, Serialize};

/// What to phonemize with.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonemizeOptions {
    /// Which phoneme inventory the output has to belong to, by name:
    /// `"kokoro-v1"` or `"kokoro-v11-zh"`.
    ///
    /// The two Kokoro models do not share a vocabulary — v1.0 keeps 115
    /// characters, v1.1-zh 172, and each drops characters the other keeps — so
    /// this follows the *voice* the user picked rather than the language of the
    /// page. A string rather than an enum, so the whole options object stays a
    /// plain object across the boundary; [`crate::vocab::Vocab`] is the Rust
    /// side of it, and the name is the model's.
    pub vocab: String,
    /// BCP-47 tag of the text.
    pub lang: String,
}

/// Text to phonemes, plus where each run came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonemizeResult {
    /// Exactly what goes into the tokenizer, guaranteed to contain only
    /// characters the target model's vocabulary keeps.
    pub phonemes: String,
    /// Offsets for word-level highlighting. Unpopulated in v1: the engine
    /// highlights per sentence today, and this is here so adding word-level
    /// later does not change the signature.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spans: Option<Vec<PhonemeSpan>>,
    /// Runs of text that produced no phonemes, one message each.
    ///
    /// Omitted from the wire format when there are none, so the common case is
    /// the object it has always been — the JavaScript test that compares the
    /// whole result (`phonemize-rust.test.ts`) is pinned to that.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// A run of phonemes produced by a run of the input text.
///
/// Offsets are into the *input* text.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonemeSpan {
    pub char_start: usize,
    pub char_end: usize,
    pub phoneme_start: usize,
    pub phoneme_end: usize,
}
