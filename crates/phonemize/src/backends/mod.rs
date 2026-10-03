//! Backends: the language-specific work that happens before a frontend turns
//! text into phonemes.
//!
//! A backend is whatever a language needs and another does not — a segmenter, a
//! numeral reader, a pronunciation table. Today only the Japanese ones exist;
//! the Chinese segmenter and the English espeak data arrive in phases 4-6.

pub mod numbers;
pub mod segmenter_ja;

pub use segmenter_ja::{JaToken, SegmenterError, SegmenterJa};
