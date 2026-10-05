//! Backends: the language-specific work that happens before a frontend turns
//! text into phonemes.
//!
//! A backend is whatever a language needs and another does not — a segmenter, a
//! numeral reader, a pronunciation table. All three languages' backends exist
//! now: Japanese segmentation, English G2P, Chinese readings, and the Chinese
//! segmenter and text rules the Chinese frontend added.
//!
//! **The numeral readers have moved out**, to [`crate::tn`], which is where the
//! stage they belong to lives — they are not per-language work in the same sense
//! as the rest of this module: every language runs the same WeText engine and
//! keeps its reader only as the stand-in for a caller that never prepared.
//!
//! [`tone_sandhi`] is the one backend that runs *after* a G2P rather than before
//! it: Mandarin decides a tone twice, once per character from the dictionary and
//! again from the words the character sits in, and that second pass is what
//! turns 你好 into *ní hǎo* (phase 9D).
//!
//! [`crate::tn::gate`] is not a reader and produces no output: it is the cheap
//! "is there anything here for the FSTs to do?" question asked before them,
//! because they answer every English sentence whether or not it has an answer to
//! find.
//!
//! [`headtts_en`] is the other half of the English G2P: the CMU dictionary is a
//! dictionary, so a word outside it has no reading at all, and the letter-to-sound
//! rules of NRL Report 7948 (as HeadTTS adapted them) are what reads it.

pub mod g2p_en;
pub mod headtts_en;
pub mod pinyin;
pub mod segmenter_ja;
pub mod segmenter_zh;
pub mod tone_sandhi;
pub mod zh_text;

pub use g2p_en::{EnglishError, EnglishG2p};
pub use pinyin::{ChinesePinyin, PinyinError, Syllable};
pub use segmenter_ja::{JaToken, SegmenterError, SegmenterJa};
pub use segmenter_zh::{SegmenterZh, SegmenterZhError};
