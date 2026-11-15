//! The code-point ranges the CJK predicates are built from.
//!
//! Shared by `text::classify`, `pipeline::is_han`, `g2p::zh::text::classify`,
//! `kana::is_kanji` and the vendored `tn::wetext::normalizer`. The predicates that
//! are supposed to *differ* still do: each one names the shared range it reads
//! and, in its own doc comment, the part it leaves out and why. What is shared
//! here is the numbers, not the questions.
//!
//! The ranges are `RangeInclusive<u32>` rather than `RangeInclusive<char>` because
//! every caller compares `ch as u32`, and a `char` range would have to be built
//! through `char::from_u32`, which is fallible and not a `const fn`.
//!
//! One range is deliberately **not** here: the CJK Symbols and Punctuation block,
//! U+3000..=U+303F. It holds `、。「」` as well as the three ideographic marks, so a
//! Han predicate covering the block would send punctuation through the dictionary;
//! [`CJK_IDEOGRAPHIC_MARKS`] is the sub-range the predicates actually mean.

use std::ops::RangeInclusive;

/// CJK Unified Ideographs, U+4E00..=U+9FFF.
pub const CJK_UNIFIED: RangeInclusive<u32> = 0x4e00..=0x9fff;

/// The same block cut at U+9FCF, which is where kuroshiro's `\u9fcf` ends.
///
/// Code points between the two bounds exist, so the difference is real rather
/// than a rounding; [`crate::kana::is_kanji`] has to answer the way kuroshiro does
/// because the Rust pipeline is line-for-line parity with it.
pub const CJK_UNIFIED_KUROSHIRO: RangeInclusive<u32> = 0x4e00..=0x9fcf;

/// CJK Unified Ideographs Extension A, U+3400..=U+4DBF.
pub const CJK_EXT_A: RangeInclusive<u32> = 0x3400..=0x4dbf;

/// CJK Compatibility Ideographs, U+F900..=U+FAFF.
pub const CJK_COMPAT: RangeInclusive<u32> = 0xf900..=0xfaff;

/// CJK Unified Ideographs Extension B and the supplement that follows it,
/// U+20000..=U+2EBEF.
pub const CJK_EXT_B: RangeInclusive<u32> = 0x20000..=0x2ebef;

/// `〇`, the ideographic zero, U+3007.
pub const IDEOGRAPHIC_ZERO: u32 = 0x3007;

/// The three marks of the CJK Symbols and Punctuation block that the Han
/// predicates count: `々` (U+3005), `〆` (U+3006) and `〇` (U+3007).
///
/// Narrower than the block on purpose; see the module comment.
pub const CJK_IDEOGRAPHIC_MARKS: RangeInclusive<u32> = 0x3005..=0x3007;

/// Hiragana, U+3040..=U+309F.
pub const HIRAGANA: RangeInclusive<u32> = 0x3040..=0x309f;

/// Katakana, U+30A0..=U+30FF.
pub const KATAKANA: RangeInclusive<u32> = 0x30a0..=0x30ff;

/// Hiragana and katakana together, U+3040..=U+30FF.
///
/// The two blocks are adjacent, so this is their union and not a third thing.
pub const HIRAGANA_KATAKANA: RangeInclusive<u32> = 0x3040..=0x30ff;

/// Katakana Phonetic Extensions, U+31F0..=U+31FF.
///
/// Kana for `text::classify`, which puts a run of them on the dictionary route.
/// [`crate::kana::is_katakana`] leaves them out because kuroshiro does; the two
/// layers are answering different questions, and `text::classify`'s doc comment is
/// where that is argued.
pub const KATAKANA_PHONETIC_EXTENSIONS: RangeInclusive<u32> = 0x31f0..=0x31ff;

/// Whether `ch` is a Han ideograph, by the ranges `text::classify` calls Han.
///
/// The text layer and the word layer ask the same question, so
/// `pipeline::is_han` and `text::classify` both call this rather than keeping a
/// range list each.
///
/// Extension B is included, which is a departure from the JavaScript: it tests
/// `char.charCodeAt(0)`, so an astral character arrives as a surrogate and never
/// matches, while Rust's `char` is a code point. See `text::segment_text`.
pub fn is_han(ch: char) -> bool {
    let code = ch as u32;
    CJK_UNIFIED.contains(&code)
        || CJK_EXT_A.contains(&code)
        || CJK_IDEOGRAPHIC_MARKS.contains(&code)
        || CJK_COMPAT.contains(&code)
        || CJK_EXT_B.contains(&code)
}
