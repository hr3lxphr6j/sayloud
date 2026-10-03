//! Backends: the language-specific work that happens before a frontend turns
//! text into phonemes.
//!
//! A backend is whatever a language needs and another does not — a segmenter, a
//! numeral reader, a pronunciation table. The Japanese, English and Chinese ones
//! exist; the Chinese segmenter and numeral reader arrive in phase 6, and the rest
//! of its frontend (punctuation, Latin runs) with it.

pub mod g2p_en;
pub mod numbers;
pub mod numbers_en;
pub mod numbers_zh;
pub mod pinyin;
pub mod segmenter_ja;
pub mod segmenter_zh;

pub use g2p_en::{EnglishError, EnglishG2p};
pub use pinyin::{ChinesePinyin, PinyinError, Syllable};
pub use segmenter_ja::{JaToken, SegmenterError, SegmenterJa};
pub use segmenter_zh::{SegmenterZh, SegmenterZhError};
