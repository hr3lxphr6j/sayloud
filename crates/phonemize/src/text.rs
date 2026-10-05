//! Text normalization and script segmentation, shared by the language pipelines.
//!
//! Mirrors `lib/models/phonemize/common.ts`. Two things in it are load-bearing
//! and easy to mistake for arbitrary choices:
//!
//! - [`normalize_punctuation`] turns a comma into a **period**. That is not a
//!   typo: it was chosen by listening tests (P5 spec) because Kokoro's pause
//!   behaviour differs between the two, and Japanese inherits the choice.
//! - [`segment_text`] splits into script runs before anything else looks at the
//!   text, because each run takes a different route to phonemes.

use crate::kana::{is_hiragana, is_katakana};

/// One run of text that will be phonemized the same way.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ScriptRun {
    /// CJK ideographs. In Japanese these are read through the dictionary.
    Han(String),
    /// Hiragana and katakana. Read through the dictionary as well, because a run
    /// of kana still has to become katakana.
    Kana(String),
    /// `A-Z`, `a-z`. Spelled out through espeak (phase 4).
    Latin(String),
    /// Everything else, of which only [`keep_punctuation`]'s set survives.
    Other(String),
}

/// Full-width punctuation to ASCII.
///
/// Each replacement is a single distinct character, so applying them in sequence
/// is the same operation as the chained `replaceAll` calls it mirrors — no
/// ordering hazard, even though `、` becomes `, ` while `，` becomes `. `.
pub fn normalize_punctuation(text: &str) -> String {
    let mut out = text.to_string();
    for (from, to) in [
        ("、", ", "),
        // Comma → period: force the pause Kokoro gives a period. See the module
        // comment; this is the listening-tested choice, not an accident.
        ("，", ". "),
        ("。", ". "),
        ("．", ". "),
        ("！", "! "),
        ("：", ": "),
        ("；", "; "),
        ("？", "? "),
        ("«", " \""),
        ("»", "\" "),
        ("《", " \""),
        ("》", "\" "),
        ("「", " \""),
        ("」", "\" "),
        ("【", " \""),
        ("】", "\" "),
        ("（", " ("),
        ("）", ") "),
    ] {
        if out.contains(from) {
            out = out.replace(from, to);
        }
    }
    out.trim().to_string()
}

/// Full-width digits to ASCII.
///
/// Shared by the language front ends because neither is complete without it: a
/// full-width digit is not a digit to `\d`, so it survives every numeral rule
/// untouched and then reaches the segmenter, where `other` keeps only
/// punctuation and the number is dropped without a sound.
pub fn to_half_width(text: &str) -> String {
    text.chars()
        .map(|ch| {
            if ('\u{ff10}'..='\u{ff19}').contains(&ch) {
                char::from_u32(ch as u32 - 0xfee0).unwrap_or(ch)
            } else {
                ch
            }
        })
        .collect()
}

/// Split text into runs of one script each.
///
/// The astral-plane branch is deliberate and mirrors a JavaScript bug rather
/// than the intent behind it. `segmentText` tests `char.charCodeAt(0)` against
/// `0x20000..=0x2ebef`, but `charCodeAt(0)` on a character outside the BMP
/// returns a *surrogate* (`0xd800..=0xdfff`), never a code point — so that
/// branch cannot be taken, and an Extension B kanji is classified `other` and
/// then dropped by [`keep_punctuation`]. Reproducing the reachable behaviour is
/// what parity requires; the fix belongs on the JavaScript side, and phase 8.4
/// removes that side entirely.
pub fn segment_text(text: &str) -> Vec<ScriptRun> {
    let mut runs: Vec<ScriptRun> = Vec::new();

    for ch in text.chars() {
        let kind = classify(ch);
        match runs.last_mut() {
            Some(run) if same_kind(run, kind) => run_push(run, ch),
            _ => {
                let mut run = new_run(kind);
                run_push(&mut run, ch);
                runs.push(run);
            }
        }
    }

    runs
}

/// The script a character belongs to, by the same ranges `segmentText` uses.
///
/// Note what is *not* here: a CJK Extension B branch. `segmentText` has one,
/// testing `char.charCodeAt(0)` against `0x20000..=0x2ebef` — but `charCodeAt(0)`
/// on a character outside the BMP returns a surrogate (`0xd800..=0xdfff`), never
/// a code point, so that branch cannot be taken and an Extension B kanji falls
/// through to `other` and is then dropped by [`keep_punctuation`].
///
/// Reproducing the reachable behaviour is what parity requires, so an astral
/// character matches none of the ranges below and lands in `other` on its own —
/// no special case needed. `classifies_an_astral_kanji_as_other` is the test that
/// keeps it that way, and it is the one that would fail if someone added the
/// branch back.
fn classify(ch: char) -> u8 {
    const HAN: u8 = 0;
    const KANA: u8 = 1;
    const LATIN: u8 = 2;
    const OTHER: u8 = 3;

    let code = ch as u32;
    if (0x4e00..=0x9fff).contains(&code) || (0x3400..=0x4dbf).contains(&code) {
        HAN
    } else if is_hiragana(ch) || is_katakana(ch) || (0x31f0..=0x31ff).contains(&code) {
        KANA
    } else if (65..=90).contains(&code) || (97..=122).contains(&code) {
        LATIN
    } else {
        OTHER
    }
}

fn same_kind(run: &ScriptRun, kind: u8) -> bool {
    matches!(
        (run, kind),
        (ScriptRun::Han(_), 0)
            | (ScriptRun::Kana(_), 1)
            | (ScriptRun::Latin(_), 2)
            | (ScriptRun::Other(_), 3)
    )
}

fn new_run(kind: u8) -> ScriptRun {
    match kind {
        0 => ScriptRun::Han(String::new()),
        1 => ScriptRun::Kana(String::new()),
        2 => ScriptRun::Latin(String::new()),
        _ => ScriptRun::Other(String::new()),
    }
}

fn run_push(run: &mut ScriptRun, ch: char) {
    match run {
        ScriptRun::Han(text)
        | ScriptRun::Kana(text)
        | ScriptRun::Latin(text)
        | ScriptRun::Other(text) => text.push(ch),
    }
}

/// The punctuation marks Kokoro's tokenizer recognises.
///
/// Measured against `tokenizer.json`'s vocabulary during P5 verification — the
/// same measurement `KEPT_PUNCTUATION` in `lib/models/phonemize/chinese.ts` came
/// from, and the same one `tests/unit/models/kokoro-vocab.ts` keeps a copy of.
/// Anything else is dropped, since Kokoro can do nothing with it anyway.
///
/// **`-` and `'` used to be in this list, and neither is in the vocabulary.**
/// The vocabulary has `—` (U+2014, EM DASH) and no hyphen-minus, and no
/// apostrophe at all; the JavaScript side's comment says so in as many words.
/// Both were reaching the output and being deleted by the tokenizer's normaliser
/// — which is why nothing noticed until the vocabulary gate started
/// checking the output against the vocabulary and refused `don't stop`. The
/// audible result is unchanged either way, because the tokenizer was already
/// dropping them; what changes is that `PhonemizeResult::phonemes` now really is
/// "exactly what goes into the tokenizer", as its doc comment claims.
///
/// `tests/vocab.rs` asserts every character here is in both vocabularies, so this
/// list cannot drift from the measurement again.
const KOKORO_PUNCTUATION: &[char] = &[
    ' ', '$', ';', ':', ',', '.', '!', '?', '—', '…', '"', '(', ')', '“', '”',
];

/// Keep only the punctuation Kokoro understands.
pub fn keep_punctuation(text: &str) -> String {
    text.chars()
        .filter(|ch| KOKORO_PUNCTUATION.contains(ch))
        .collect()
}

/// Collapse runs of whitespace to a single space, and trim.
///
/// The whitespace set is JavaScript's `\s` rather than Rust's
/// [`char::is_whitespace`], which differs at both ends: Rust counts `U+0085`
/// (NEL) and not `U+FEFF`, JavaScript the other way round. Unreachable today,
/// since [`keep_punctuation`] drops both — but the two functions are the pair
/// that would have to change together, and this is the cheaper half to get
/// right.
pub fn collapse_whitespace(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;

    for ch in text.chars() {
        if is_js_whitespace(ch) {
            in_space = true;
            continue;
        }
        if in_space && !out.is_empty() {
            out.push(' ');
        }
        in_space = false;
        out.push(ch);
    }

    out
}

/// JavaScript's `\s`, which is a fixed set rather than a Unicode property.
///
/// Public because the Chinese punctuation filter needs it and the two have to
/// agree: `chinese.ts`'s `keepPunctuation` keeps `\s`, so a whitespace set that
/// differed between the filter and the final collapse would be two answers to
/// one question. `text.rs` is where the JavaScript's definition lives, and a
/// second copy elsewhere would be the thing that drifts.
pub fn is_js_whitespace(ch: char) -> bool {
    matches!(
        ch,
        '\t' | '\n' | '\u{0b}' | '\u{0c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}
