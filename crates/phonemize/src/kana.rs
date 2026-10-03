//! Kana and kanji predicates, and the kana conversions.
//!
//! Every range here is copied from kuroshiro's `lib/util.js`, bounds included,
//! because the Rust pipeline has to agree with the JavaScript one character for
//! character. Two of these are easy to "fix" into disagreement:
//!
//! - [`is_katakana`] covers `U+30A0..=U+30FF` and **not** the katakana phonetic
//!   extensions at `U+31F0..=U+31FF`. `segment_text` in `text.rs` does treat the
//!   extensions as kana, and that is not an inconsistency: it is a different
//!   layer, and kuroshiro's predicate is the one that decides how a token's
//!   reading is filled in.
//! - [`to_raw_katakana`] and [`to_raw_hiragana`] are strict at both ends
//!   (`> U+3040 && < U+3097`), which is *not* the same set as `is_hiragana`.
//!   The two differ at `U+3097`-`U+309F` and at `U+3040`, and text containing
//!   those is text where the two conversions disagree.

/// `HIRAGANA_KATAKANA_SHIFT` in kuroshiro: `U+30A1 - U+3041`.
const HIRAGANA_KATAKANA_SHIFT: u32 = 0x60;

/// Hiragana, `U+3040..=U+309F`.
pub fn is_hiragana(ch: char) -> bool {
    ('\u{3040}'..='\u{309f}').contains(&ch)
}

/// Katakana, `U+30A0..=U+30FF`.
///
/// Not the phonetic extensions; see the module comment.
pub fn is_katakana(ch: char) -> bool {
    ('\u{30a0}'..='\u{30ff}').contains(&ch)
}

/// Hiragana or katakana.
pub fn is_kana(ch: char) -> bool {
    is_hiragana(ch) || is_katakana(ch)
}

/// The three kanji blocks kuroshiro recognises.
///
/// The upper bound of the first block is `U+9FCF`, not the `U+9FFF` that the
/// Unicode block table gives — kuroshiro's is `\u9fcf`, and code points between
/// the two exist.
pub fn is_kanji(ch: char) -> bool {
    ('\u{4e00}'..='\u{9fcf}').contains(&ch)
        || ('\u{f900}'..='\u{faff}').contains(&ch)
        || ('\u{3400}'..='\u{4dbf}').contains(&ch)
}

/// Any kana or kanji, i.e. anything kuroshiro would call Japanese.
pub fn has_japanese(text: &str) -> bool {
    text.chars().any(|ch| is_kana(ch) || is_kanji(ch))
}

/// Whether any character is hiragana.
pub fn has_hiragana(text: &str) -> bool {
    text.chars().any(is_hiragana)
}

/// Hiragana to katakana by code point offset.
///
/// The shifted set is `U+3041..=U+3096` — the small kana through ゖ — which is
/// exactly the key set of the JavaScript pipeline's explicit
/// `HIRAGANA_TO_KATAKANA` map. That map and this shift are the same function,
/// and `to_raw_katakana_matches_the_explicit_javascript_map` says so.
pub fn to_raw_katakana(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ch > '\u{3040}' && ch < '\u{3097}' {
                char::from_u32(ch as u32 + HIRAGANA_KATAKANA_SHIFT).unwrap_or(ch)
            } else {
                ch
            }
        })
        .collect()
}
