//! The Japanese frontend: kana to IPA (spec §2.2, frontend `Ja Ipa`).
//!
//! This is the half of the Japanese pipeline that does not need a dictionary:
//! once text has been read out as katakana — by [`crate::backends::segmenter_ja`]
//! for text with kanji in it, or directly for text that is already kana — the
//! mapping to phonemes is a table lookup.
//!
//! It is a port of `kanaToIPA` and `fixNumeralSoundChanges` from the JavaScript
//! chain's `japanese.ts`, and it was ported *exactly*: the output is compared
//! character for character against the corpus that pipeline produced
//! (`tests/ja_pipeline.rs`), so "close enough" is a failing test. The JavaScript
//! file itself was deleted in phase 8, so it is cited as the provenance of the
//! behaviour rather than as something to read.

use std::collections::HashMap;
use std::sync::OnceLock;

use crate::kana::to_raw_katakana;

/// Re-exported so the table is reachable from the frontend it belongs to.
pub use crate::frontends::ja_ipa_table::KATAKANA_TO_IPA;

/// The numeral sound changes the dictionary does not make.
///
/// IPADic reads numerals one character at a time, so 「三百」 comes back
/// サンヒャク where the language says サンビャク. Five cases, each unambiguous in
/// practice: ヒャク and セン only follow サン, ロク or ハチ inside a numeral, so
/// there is no other word these patterns could belong to.
///
/// The patterns are literal — no metacharacters — so plain replacement is the
/// same operation as the JavaScript `String.replaceAll` with a `/g` regex, and
/// this stays free of a regex dependency.
const NUMERAL_SOUND_CHANGES: &[(&str, &str)] = &[
    ("サンヒャク", "サンビャク"),
    ("ロクヒャク", "ロッピャク"),
    ("ハチヒャク", "ハッピャク"),
    ("サンセン", "サンゼン"),
    ("ハチセン", "ハッセン"),
];

/// Apply the numeral sound changes, in order.
pub fn fix_numeral_sound_changes(katakana: &str) -> String {
    let mut out = katakana.to_string();
    for (pattern, replacement) in NUMERAL_SOUND_CHANGES {
        if out.contains(pattern) {
            out = out.replace(pattern, replacement);
        }
    }
    out
}

/// Katakana (or hiragana) to IPA.
///
/// Hiragana is shifted to katakana first, which is what the JavaScript does —
/// the table is keyed in katakana and the conversion is applied on every call
/// rather than only to hiragana input, so mixed text needs no special case.
///
/// Lookup is longest-match-first with a two-character lookahead, so キャ is
/// `kja` and not `ki` + `ja`. A character with no entry is passed through
/// unchanged, which is also what the JavaScript did; the vocabulary gate
/// (spec §1.3, phase 5) is what turns that from a silent passthrough into a
/// checkable property.
pub fn kana_to_ipa(kana: &str) -> String {
    let katakana: Vec<char> = to_raw_katakana(kana).chars().collect();
    let mut out = String::with_capacity(katakana.len());

    let mut index = 0;
    while index < katakana.len() {
        // Two characters first: every palatalized and foreign mora is a pair,
        // and the pair's own entry is the one that is correct.
        if index + 1 < katakana.len() {
            if let Some(ipa) = lookup(katakana[index], Some(katakana[index + 1])) {
                out.push_str(ipa);
                index += 2;
                continue;
            }
        }

        match lookup(katakana[index], None) {
            Some(ipa) => out.push_str(ipa),
            // Unknown character: keep it. The JavaScript keeps it too, and the
            // vocabulary gate is where an unexpected character becomes visible.
            None => out.push(katakana[index]),
        }
        index += 1;
    }

    out
}

/// The table, keyed by the one or two characters it is looked up with.
///
/// A map rather than a scan of the slice: the lookup runs twice per input
/// character, and 193 string comparisons each time is work that buys nothing.
/// The key is `(first, Some(second))` for a pair and `(first, None)` for a
/// single character, which is unambiguous and needs no allocation to build.
fn table() -> &'static HashMap<(char, Option<char>), &'static str> {
    static TABLE: OnceLock<HashMap<(char, Option<char>), &'static str>> = OnceLock::new();

    TABLE.get_or_init(|| {
        KATAKANA_TO_IPA
            .iter()
            .map(|(kana, ipa)| {
                let mut chars = kana.chars();
                let first = chars.next().expect("a table key is never empty");
                ((first, chars.next()), *ipa)
            })
            .collect()
    })
}

/// The table's entry for one or two characters, if it has one.
fn lookup(first: char, second: Option<char>) -> Option<&'static str> {
    table().get(&(first, second)).copied()
}
