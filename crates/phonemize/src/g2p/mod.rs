//! Grapheme to phoneme: text in, phonemes out.
//!
//! The second stage of the pipeline, after [`crate::tn`] has made the text
//! pronounceable and before [`crate::vocab`] checks the answer against the model
//! that will speak it. Every language gets a directory, because what differs here
//! really is per language: Japanese has a dictionary and a kana table, Chinese
//! has word boundaries, readings and a tone layer, English has neither a
//! segmenter nor a dictionary that covers everything — only a pronunciation
//! dictionary compiled in, three layers of fallback over it, and no rules from
//! punctuation at all.
//!
//! What is *not* here is anything that only reads strings: the numeral step is
//! [`crate::tn`], the shared segmenter, punctuation and whitespace rules are
//! [`crate::text`], and the kana predicates are [`crate::kana`].

pub mod en;
pub mod ja;
pub mod zh;

pub use en::{EnglishError, EnglishG2p};
pub use ja::{
    fix_numeral_sound_changes, kana_to_ipa, JaToken, SegmenterError, SegmenterJa, KATAKANA_TO_IPA,
};
pub use zh::{ChinesePinyin, PinyinError, SegmenterZh, SegmenterZhError, Syllable};
