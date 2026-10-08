//! The Chinese text rules that sit between the raw string and the G2P: which
//! punctuation survives, and where the Han and Latin runs are.
//!
//! Mirrors the text half of `lib/models/phonemize/chinese.ts` — its
//! `mapPunctuation`, `splitRuns` and `keepPunctuation` — and it is deliberately
//! **not** the shared [`crate::text`] layer, which mirrors `common.ts`. The two
//! JavaScript files differ, so the two Rust modules have to as well:
//!
//! - **Quotation marks.** `chinese.ts` maps `「」《》【】«»` to `“ ”` (U+201C,
//!   U+201D); `common.ts` maps the same characters to the ASCII `"`. Both survive
//!   into the tokenizer — the vocabulary has all three — so this is not a
//!   cosmetic difference, it is a different phoneme string for the same input.
//! - **Whitespace.** `common.ts`'s `keepPunctuation` keeps a fixed set of marks
//!   and drops whitespace that is not a literal space. `chinese.ts`'s keeps
//!   `\s` as well and then collapses runs of it to one space. That difference is
//!   audible: the space in `你好 世界` is the only thing separating the two
//!   words, and dropping it glues them into one.
//! - **Han runs.** `chinese.ts` counts `〇` (U+3007) and the compatibility
//!   ideographs (`U+F900`–`U+FAFF`) as Han, and has no `kana` run at all;
//!   [`crate::text::segment_text`] has the reverse on both counts. `〇` is the
//!   one that is visible in ordinary text — `pinyin-pro` reads it `ling2`, so a
//!   run split that put it in `other` would drop it, and a dropped character is
//!   exactly what the vocabulary gate exists to catch.
//!
//! # What is not here
//!
//! The numeral rules, which are the WeText engine's ([`crate::tn`]; the
//! hand-written reader this comment used to name is deleted), and the syllable and
//! tone tables, which are [`super::pinyin`]. The order they run in is the
//! pipeline's: `map_punctuation(read_numerals(text))`, then the runs — the same
//! order `ChinesePhonemizer.phonemize` uses, and it matters, because the numeral
//! pass introduces Han characters that then belong to a Han run.

use crate::text::is_js_whitespace;

/// One run of text that will be phonemized the same way.
///
/// No `Kana`: `chinese.ts`'s `runPattern` has three alternatives, and kana falls
/// into the third — it is not Han and not `[A-Za-z]`, so it lands in `other` and
/// is then dropped by [`keep_punctuation`], which has no kana in its set. A
/// Japanese character in Chinese text is a character this frontend cannot read,
/// and dropping it is what the JavaScript does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ZhRun {
    /// Han characters, including `〇` and the compatibility ideographs.
    Han(String),
    /// `A-Z`, `a-z`.
    Latin(String),
    /// Everything else, of which only [`keep_punctuation`]'s set survives.
    Other(String),
}

/// Full-width punctuation to ASCII, with `“ ”` for the quotation marks.
///
/// Each replacement is a single distinct character, so applying them in sequence
/// is the same operation as the chained `replaceAll` calls it mirrors — no
/// ordering hazard, even though `、` becomes `, ` while `，` becomes `. `.
///
/// **The comma becomes a period.** That is not a typo: it was chosen by listening
/// tests because Kokoro's pause behaviour differs between the two, and the
/// user picked it from a page of seven treatments. `、` (顿号) is left as a comma:
/// it is a shorter mark, the page never tested it, and turning every separator
/// into a full stop is a larger change than the one that was chosen.
///
/// The quotation marks are the difference from [`crate::text::normalize_punctuation`]
/// that the module comment describes: `“ ”`, not `"`.
pub fn map_punctuation(text: &str) -> String {
    let mut out = text.to_string();
    for (from, to) in [
        ("、", ", "),
        ("，", ". "),
        ("。", ". "),
        ("．", ". "),
        ("！", "! "),
        ("：", ": "),
        ("；", "; "),
        ("？", "? "),
        ("«", " “"),
        ("»", "” "),
        ("《", " “"),
        ("》", "” "),
        ("「", " “"),
        ("」", "” "),
        ("【", " “"),
        ("】", "” "),
        ("（", " ("),
        ("）", ") "),
    ] {
        if out.contains(from) {
            out = out.replace(from, to);
        }
    }
    out.trim().to_string()
}

/// The script a character belongs to, by the ranges `runPattern` uses.
///
/// Written as the ranges rather than as a name lookup so that a reader comparing
/// the two files can see they are the same set. Note what is deliberately absent:
/// a CJK Extension B branch. `chinese.ts` has none either — its comment says
/// those characters are dropped silently, and that a run boundary is the wrong
/// place to discover it.
fn classify(character: char) -> u8 {
    const HAN: u8 = 0;
    const LATIN: u8 = 1;
    const OTHER: u8 = 2;

    let code = character as u32;
    if code == 0x3007
        || (0x3400..=0x4dbf).contains(&code)
        || (0x4e00..=0x9fff).contains(&code)
        || (0xf900..=0xfaff).contains(&code)
    {
        HAN
    } else if character.is_ascii_alphabetic() {
        LATIN
    } else {
        OTHER
    }
}

/// Split text into the three run kinds, in order.
///
/// The three alternatives of `chinese.ts`'s `runPattern`, applied by hand: a
/// maximal Han run, a maximal `[A-Za-z]` run, or a maximal run of everything
/// else. `matchAll` cannot overlap and cannot skip, so a single left-to-right
/// pass over the characters is the same partition.
pub fn split_runs(text: &str) -> Vec<ZhRun> {
    let mut runs: Vec<ZhRun> = Vec::new();

    for character in text.chars() {
        let kind = classify(character);
        match runs.last_mut() {
            Some(ZhRun::Han(run)) if kind == 0 => run.push(character),
            Some(ZhRun::Latin(run)) if kind == 1 => run.push(character),
            Some(ZhRun::Other(run)) if kind == 2 => run.push(character),
            _ => {
                let mut run = match kind {
                    0 => ZhRun::Han(String::new()),
                    1 => ZhRun::Latin(String::new()),
                    _ => ZhRun::Other(String::new()),
                };
                match &mut run {
                    ZhRun::Han(text) | ZhRun::Latin(text) | ZhRun::Other(text) => {
                        text.push(character)
                    }
                }
                runs.push(run);
            }
        }
    }

    runs
}

/// The punctuation Kokoro's tokenizer actually has.
///
/// Measured against `tokenizer.json`'s vocabulary — the
/// same measurement `KEPT_PUNCTUATION` in `chinese.ts` came from, and the same
/// one [`crate::text`]'s `KOKORO_PUNCTUATION` records. Everything else,
/// including `-`, `/`, `%` and `'`, is not in it and is dropped rather than
/// turned into a token the tokenizer would discard anyway.
const KEPT_PUNCTUATION: &[char] = &[
    '$', ';', ':', ',', '.', '!', '?', '—', '…', '"', '(', ')', '“', '”',
];

/// Keep only the punctuation Kokoro understands, with whitespace collapsed.
///
/// Whitespace counts as kept, and that is the difference from
/// [`crate::text::keep_punctuation`]: `chinese.ts` filters on `/\s/.test(c) ||
/// KEPT_PUNCTUATION.has(c)`. It matters because the runs are concatenated with
/// nothing between them, so a space that `map_punctuation` put after a comma is
/// the only thing separating it from the next word.
///
/// **Deliberately not trimmed**, which is `chinese.ts`'s comment and a real
/// behaviour rather than an oversight. A run of nothing but spaces becomes a
/// single space and stays one: trimming it here would glue the word before it to
/// the word after it. The pipeline's final collapse handles the ends of the
/// sentence.
///
/// A run of whitespace with no kept mark after it still emits its single space,
/// which is why the pending flag is flushed at the end rather than only before
/// the next kept character — the JavaScript filters first and collapses second,
/// so `" "` survives as `" "`.
pub fn keep_punctuation(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut in_space = false;

    for character in text.chars() {
        if is_js_whitespace(character) {
            in_space = true;
            continue;
        }
        if !KEPT_PUNCTUATION.contains(&character) {
            continue;
        }
        if in_space {
            out.push(' ');
            in_space = false;
        }
        out.push(character);
    }

    if in_space {
        out.push(' ');
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn han(text: &str) -> ZhRun {
        ZhRun::Han(text.to_string())
    }

    fn latin(text: &str) -> ZhRun {
        ZhRun::Latin(text.to_string())
    }

    fn other(text: &str) -> ZhRun {
        ZhRun::Other(text.to_string())
    }

    #[test]
    fn maps_the_punctuation_that_has_to_become_a_pause() {
        assert_eq!(map_punctuation("你好，世界。"), "你好. 世界.");
        assert_eq!(map_punctuation("一、二"), "一, 二");
        assert_eq!(map_punctuation("真的吗？是的！"), "真的吗? 是的!");
        assert_eq!(map_punctuation("注意：安全；第一"), "注意: 安全; 第一");
    }

    #[test]
    fn maps_quotation_marks_to_curly_ones() {
        // The difference from `common.ts`, and observable in the output: the
        // vocabulary has `“ ”` and `"` as three different tokens.
        assert_eq!(map_punctuation("「你好」"), "“你好”");
        assert_eq!(map_punctuation("《书》"), "“书”");
        assert_eq!(map_punctuation("【标题】"), "“标题”");
        assert_eq!(map_punctuation("«引用»"), "“引用”");
    }

    #[test]
    fn trims_the_ends_but_not_the_middle() {
        assert_eq!(map_punctuation("  你好  "), "你好");
        assert_eq!(map_punctuation("你好，世界"), "你好. 世界");
    }

    #[test]
    fn splits_into_han_latin_and_other() {
        assert_eq!(split_runs("你好"), vec![han("你好")]);
        assert_eq!(split_runs("abc"), vec![latin("abc")]);
        assert_eq!(
            split_runs("你好ABC世界"),
            vec![han("你好"), latin("ABC"), han("世界")]
        );
        assert_eq!(
            split_runs("你好. 世界"),
            vec![han("你好"), other(". "), han("世界")]
        );
    }

    #[test]
    fn counts_the_ideographic_zero_as_han() {
        // `〇` is U+3007, outside every CJK ideograph block, and `pinyin-pro`
        // reads it `ling2`. A run split that put it in `other` would drop it —
        // the character would be missing from the audio with nothing thrown.
        assert_eq!(split_runs("〇一"), vec![han("〇一")]);
        assert_eq!(split_runs("一〇〇"), vec![han("一〇〇")]);
    }

    #[test]
    fn counts_the_compatibility_ideographs_as_han() {
        // U+F900-U+FAFF, which `common.ts`'s `segmentText` does not.
        assert_eq!(split_runs("豈"), vec![han("豈")]);
    }

    #[test]
    fn leaves_kana_out_of_the_han_run() {
        // `chinese.ts` has no kana alternative, so a kana character is `other`
        // and then dropped. Keeping it out of the Han run is what makes the
        // Chinese pipeline refuse to read Japanese rather than read it wrong.
        assert_eq!(split_runs("あ"), vec![other("あ")]);
        assert_eq!(
            split_runs("你好あ世界"),
            vec![han("你好"), other("あ"), han("世界")]
        );
    }

    #[test]
    fn leaves_an_astral_ideograph_out_of_the_han_run() {
        // Extension B is outside the pattern in both implementations, and a run
        // boundary is not where that should be discovered — the character is
        // dropped either way. Pinned so that adding a branch back is a decision
        // and not an accident.
        assert_eq!(split_runs("𠀀"), vec![other("𠀀")]);
    }

    #[test]
    fn keeps_only_the_punctuation_the_tokenizer_has() {
        assert_eq!(keep_punctuation("，。！？"), "");
        assert_eq!(keep_punctuation(".,!?"), ".,!?");
        assert_eq!(keep_punctuation("—…"), "—…");
        // Han characters are not punctuation, so a run of them contributes
        // nothing but the marks around it. The Han goes through the syllable
        // table instead — a run is either Han, Latin or `other`, never mixed.
        assert_eq!(keep_punctuation("“引号”"), "“”");
        // Not in the vocabulary, so dropped rather than tokenised and discarded.
        assert_eq!(keep_punctuation("a-b/c%'"), "");
    }

    #[test]
    fn keeps_a_space_and_does_not_trim_it() {
        // The space between two Han runs is the only word boundary there is, so
        // this function has to hand it on. Trimming would glue 你好 to 世界.
        assert_eq!(keep_punctuation(" "), " ");
        assert_eq!(keep_punctuation("   "), " ");
        assert_eq!(keep_punctuation(" , "), " , ");
        assert_eq!(keep_punctuation("\t\n"), " ");
        assert_eq!(keep_punctuation("\u{3000}"), " ");
    }

    #[test]
    fn collapses_a_run_of_whitespace_to_one_space() {
        assert_eq!(keep_punctuation("a  \t  b"), " ");
        assert_eq!(keep_punctuation("  ,  ,  "), " , , ");
    }
}
