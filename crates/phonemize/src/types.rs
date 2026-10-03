//! The shapes that cross the JS boundary.
//!
//! These mirror the TypeScript interfaces in `lib/models/phonemize-rust.ts`.
//! Rust keeps snake_case field names; `rename_all` makes the wire format
//! camelCase to match. The plan's two halves disagreed on that (snake_case in
//! Rust, camelCase in TypeScript) and nothing would have caught it until the
//! first real serialization.

use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

/// Which phoneme inventory the output has to belong to (spec §1.3).
///
/// The two Kokoro models do not share a vocabulary — v1.0 keeps 115 characters
/// and v1.1-zh keeps 172, and each drops characters the other keeps. The
/// frontend follows the voice the user picked, not the language of the page.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FrontendId {
    KokoroV1 = "kokoro-v1",
    KokoroV11Zh = "kokoro-v11-zh",
}

/// What to phonemize with.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonemizeOptions {
    /// [`FrontendId`] as a string, so the boundary stays a plain object.
    pub frontend: String,
    /// BCP-47 tag of the text.
    pub lang: String,
}

/// Text to phonemes, plus where each run came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PhonemizeResult {
    /// Exactly what goes into the tokenizer, guaranteed to contain only
    /// characters the target model's vocabulary keeps (spec §1.3).
    pub phonemes: String,
    /// Offsets for word-level highlighting. Unpopulated in v1: the engine
    /// highlights per sentence today, and this is here so adding word-level
    /// later does not change the signature (spec §3.1).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub spans: Option<Vec<PhonemeSpan>>,
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
