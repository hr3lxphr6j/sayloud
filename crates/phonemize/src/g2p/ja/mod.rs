//! Japanese: the kana table, and the dictionary that fills it in.
//!
//! The split is by what needs a dictionary: [`segmenter`] reads text with kanji
//! in it through lindera and IPADic, and [`ipa`] turns katakana — from the
//! dictionary, or straight from input that was already kana — into phonemes.
//! [`table`] is the generated katakana table `ipa` is a lookup over.

pub mod ipa;
pub mod segmenter;
pub mod table;

pub use ipa::{fix_numeral_sound_changes, kana_to_ipa, KATAKANA_TO_IPA};
pub use segmenter::{JaToken, SegmenterError, SegmenterJa};
