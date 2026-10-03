//! Backends: the language-specific work that happens before a frontend turns
//! text into phonemes.
//!
//! A backend is whatever a language needs and another does not — a segmenter, a
//! numeral reader, a pronunciation table. The Japanese and English ones exist;
//! the Chinese segmenter arrives in phase 5.

pub mod g2p_en;
pub mod numbers;
pub mod numbers_en;
pub mod segmenter_ja;

pub use g2p_en::{EnglishError, EnglishG2p};
pub use segmenter_ja::{JaToken, SegmenterError, SegmenterJa};
