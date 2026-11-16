//! The shapes a reader sees as shapes rather than as quantities.
//!
//! Three grammars, one per language, all of them convinced by the same thing: a
//! number in a *written form* is not a number in prose, and the rule that reads
//! the prose reading gets it wrong.
//!
//! - **English.** `v1.2.3` was `v one.two point three`, `1.2.3` was `one.two point
//!   three`, `24/7` was `twenty four sevenths`, and `§3.2` had no path at all —
//!   the tagger could not join a `whitelist` token for `§` to a token for `3.2`,
//!   because two tokens are separated by a space or punctuation and here they are
//!   written against each other. `.` inside an address is the exception and is
//!   pinned: `1.2.3.4` keeps upstream's digit-by-digit `dot` reading.
//! - **Japanese.** The telephone branch upstream has only covers `090-1234-5678`
//!   and reads the hyphens as の; everything else fell through to arithmetic, so
//!   `0120-123-456` was three numbers subtracted and `〒100-0001` was a cardinal
//!   minus a cardinal. The new reading is katakana, one digit at a time, with
//!   `、` between the groups.
//! - **Chinese.** `1,234` was `一,两百三十四`: no rule claimed the comma, so
//!   `Cardinal` read the two digit groups and `Char` read the separator out loud.
//!   The separators are now stripped and the digit string read by upstream's own
//!   cardinal graph.
//!
//! The assertions are on the normalized **text**, not on phonemes, for Japanese
//! and Chinese because the text is what these rules decide, and because the
//! Japanese text has to survive `segment_japanese` as katakana and kanji runs
//! rather than be re-read as numbers. English gets the same treatment so a
//! reading that lost a word in the pipeline cannot hide behind the IPA.

mod common;

use common::{chinese_tn, japanese_tn, wetext_fsts, WETEXT_EN_NAMES};
use phonemize::tn;
use phonemize::tn::wetext::Normalizer;

/// The English engine, built straight from the shipped grammars.
fn english() -> Option<tn::Normalizer> {
    let fsts = wetext_fsts(WETEXT_EN_NAMES)?;
    let borrowed: Vec<&[u8]> = fsts.iter().map(|bytes| bytes.as_slice()).collect();
    Some(tn::english(borrowed[0], borrowed[1], borrowed[2]).expect("the FSTs parse"))
}

fn read(normalizer: Option<&Normalizer>, text: &str) -> Option<String> {
    let normalizer = normalizer?;
    Some(
        normalizer
            .normalize(text)
            .unwrap_or_else(|error| panic!("{text:?} normalizes: {error}")),
    )
}

fn assert_reads(normalizer: Option<&Normalizer>, table: &[(&str, &str)]) {
    for (text, expected) in table {
        assert_eq!(
            read(normalizer, text).as_deref(),
            Some(*expected),
            "{text:?}"
        );
    }
}

#[test]
fn english_shapes_are_read_as_they_are_written() {
    let engine = english();
    assert_reads(
        engine.as_ref(),
        &[
            // A version, with and without the `v` the writer used.
            ("v1.2.3", "version one point two point three"),
            ("V1.2.3", "version one point two point three"),
            // `0` is a component, and the common one: without it the token
            // missed and upstream split it (`v one.zero point oh`).
            ("v1.0.0", "version one point zero point zero"),
            ("1.0.0", "one point zero point zero"),
            ("v2.0.1", "version two point zero point one"),
            ("1.2.3", "one point two point three"),
            ("Version 1.2.3", "Version one point two point three"),
            ("v1.2", "version one point two"),
            // The idiom, and the hyphen that is a range.
            ("24/7", "twenty four seven"),
            ("24-7", "twenty four to seven"),
            // `§` against its number, which upstream's token join cannot express.
            ("§3.2", "section three point two"),
            ("§3", "section three"),
            ("§ 3.2", "section three point two"),
            // Unchanged, and each for a different reason: two components is a
            // decimal, four is an address that `Telephone` reads digit by digit.
            ("1.2", "one point two"),
            ("1.2.3.4", "one dot two dot three dot four"),
            (
                "192.168.1.1",
                "one nine two dot one six eight dot one dot one",
            ),
            ("10.0.0.1", "one zero dot zero dot zero dot one"),
            // A fraction is still a fraction: `24/7` is the one pair of numbers
            // written with a slash in ordinary English.
            ("3/4", "three quarters"),
        ],
    );
}

#[test]
fn japanese_telephone_and_postal_codes_are_digit_by_digit() {
    let engine = japanese_tn();
    assert_reads(
        engine.as_ref(),
        &[
            (
                "090-1234-5678",
                "ゼロきゅうゼロ、いちにさんよん、ごろくななはち",
            ),
            ("03-1234-5678", "ゼロさん、いちにさんよん、ごろくななはち"),
            ("0120-123-456", "ゼロいちにゼロ、いちにさん、よんごろく"),
            // `〒` is written, not said.
            ("〒100-0001", "いちゼロゼロ、ゼロゼロゼロいち"),
            // Without the mark the shape is a range, not a postal code: the
            // tagger can start mid-number (`2020-0101` matched `020-0101`), so
            // the bare `3-4` shape is not a rule at all.
            ("100-0001", "百マイナス〇〇〇一"),
            // The word in front is part of the match: without it upstream's
            // ordinal branch (`番号は` + digits) claims the first group and the
            // rest falls back to マイナス.
            (
                "電話番号は090-1234-5678です。",
                "電話番号はゼロきゅうゼロ、いちにさんよん、ごろくななはちです.",
            ),
            ("電話は555-1234", "電話は五百五十五マイナス千二百三十四"),
        ],
    );
}

#[test]
fn chinese_thousands_separators_are_read_as_one_number() {
    let engine = chinese_tn();
    assert_reads(
        engine.as_ref(),
        &[
            ("1,234", "一千二百三十四"),
            ("12,345", "一万二千三百四十五"),
            ("1,234,567", "一百二十三万四千五百六十七"),
            // Full width: `build_zh` runs with `full_to_half=False`, and the
            // pipeline's fold leaves `，` alone.
            ("1，234", "一千二百三十四"),
            // Four-digit groups, which is how Chinese groups its numbers.
            ("1,0000", "一万"),
            ("1,0000,0000", "一亿"),
            // Unchanged: a measure reads the grouped number on its own, and a
            // dot is a decimal point.
            ("2024年1,234元", "二零二四年一千二百三十四元"),
            ("1.234", "一点二三四"),
            // The currency symbol is part of the match, or it is left unread
            // and the 元 is lost. A trailing 元 is not said twice.
            ("¥1,234", "一千二百三十四元"),
            ("¥1,234元", "一千二百三十四元"),
            ("¥1,234.50", "一千二百三十四点五零元"),
            ("$1,234", "一千二百三十四美元"),
        ],
    );
}
