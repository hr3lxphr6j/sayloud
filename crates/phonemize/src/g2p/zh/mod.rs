//! Chinese: word boundaries, readings, the tone rules, and the text rules.
//!
//! Four pieces, and the order they run in is [`crate::pipeline::phonemize_zh`]'s:
//! [`text`] decides the punctuation and where the runs are, [`segmenter`] gives
//! the word boundaries, [`pinyin`] gives one reading per character and the IPA
//! for each syllable, and [`tone_sandhi`] decides the tone a second time — from
//! the words and the tags, because Mandarin does not pronounce a character's
//! tone as the dictionary gives it.
//!
//! The readings and the boundaries come from different places on purpose: they
//! answer different questions, and a mismatch between them is refused rather than
//! guessed at.

pub mod pinyin;
pub mod segmenter;
pub mod text;
pub mod tone_sandhi;

pub use pinyin::{ChinesePinyin, PinyinError, Syllable};
pub use segmenter::{SegmenterZh, SegmenterZhError, TaggedWord};
