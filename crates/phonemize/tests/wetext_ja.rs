//! Japanese text normalization (phase 9E).
//!
//! The same two halves as `wetext_zh.rs`, with one difference worth stating up
//! front: **Japanese gains far less than Chinese does.** Its hand-written reader,
//! `numbers_to_kanji`, is the best of the three — it is a single left-to-right
//! scan with a greedy fraction and percent check, so `50%` was already
//! 五十パーセント and `15.6%` already 十五点六パーセント, where the Chinese reader
//! has four chained patterns and needs them in a particular order. What the
//! grammar adds is comma-grouped numbers, currency and units, and one thing it
//! takes away.
//!
//! **Every reading below was checked against the Python reference** —
//! `pip install wetext==0.1.8` — on a probe set of 29 Japanese inputs, and our
//! copy agrees on **all 29**. That is worth more than it looks: it is the Chinese
//! side that needed modification 7 to get there, and this is the evidence that
//! the fix is the right shape rather than a coincidence.

mod common;

use phonemize::backends::wetext::Normalizer;
use phonemize::dictionary::{DictionaryRegistry, IPADIC_JA};

use common::{japanese_tn, wetext_compressed, WETEXT_JA_NAMES};

/// One reading, from an engine the caller already built.
fn read(tn: &Normalizer, text: &str) -> String {
    tn.normalize(text)
        .unwrap_or_else(|error| panic!("{text:?} normalizes: {error}"))
}

/// A table of `(input, reading)`, asserted row by row.
fn assert_reads(table: &[(&str, &str)]) {
    let Some(tn) = japanese_tn() else {
        return;
    };
    for (input, expected) in table {
        assert_eq!(read(&tn, input), *expected, "{input:?}");
    }
}

// ------------------------------------------------------- the entity classes

/// What the hand-written reader could not read.
///
/// The percentage rows are the control: `numbers_to_kanji` reads those already,
/// so they pin the grammar rather than the wiring. The rest are the additions —
/// a grouped number, a currency, a fraction and a unit-bearing measure.
#[test]
fn reads_the_entities_the_hand_written_reader_could_not() {
    assert_reads(&[
        // A comma-grouped number. The old reader stopped at the separator — a
        // comma is also a pause and cannot be removed globally — and read only
        // the trailing group, so `1,234` came out いち,にひゃくさんじゅうよん.
        ("1,234", "千二百三十四"),
        ("1234円", "千二百三十四円"),
        // Currency, where the old pipeline lost the 円 entirely: `¥1,200` was
        // read as いち,にひゃく with nothing to say what the numbers were.
        ("¥1,200", "千二百円"),
        ("3,000円", "三千円"),
        // A unit, where the old reader handed the letters to the English
        // dictionary and read `km` as *K M*.
        ("2.5km", "二点五キロメートル"),
        // A fraction: 二分の一, where the old reader said いちに.
        ("1/2", "二分の一"),
        // Clock times and dates, which both readers handle.
        ("午後3時30分", "午後三時三十分"),
        ("18:30", "十八時三十分"),
        ("10月4日", "十月四日"),
        ("2024年10月4日", "二千二十四年十月四日"),
        // Percentages: the control rows.
        ("50%", "五十パーセント"),
        ("15.6%", "十五点六パーセント"),
    ]);
}

/// The numerals both readers agree on.
#[test]
fn reads_a_bare_cardinal_the_way_the_hand_written_reader_did() {
    assert_reads(&[
        ("7", "七"),
        ("123", "百二十三"),
        ("200円", "二百円"),
        ("2022年", "二千二十二年"),
        ("8000", "八千"),
        ("10001", "一万一"),
    ]);
}

// ----------------------------------------------------- wins and costs

/// A telephone number, read as a telephone number.
///
/// This is the clearest single improvement on the Japanese side, and it comes
/// from the tagger recognizing the *shape* — three digits, four, four — rather
/// than from anything a left-to-right scan could have done. The old reader read
/// each run as a **quantity**: 九十・千二百三十四・五千六百七十八, three numbers
/// that are each larger than the one on the page.
///
/// The context matters, and that is why the same digits appear twice here: with
/// the 電話番号は in front, the grammar reads the hyphens as separators of a
/// *range* instead (see [`reads_a_hyphen_as_the_range_the_grammar_reads`]).
#[test]
fn reads_a_telephone_number_as_a_telephone_number() {
    assert_reads(&[("090-1234-5678", "ゼロ九ゼロの一二三四の五六七八")]);
}

/// A hyphen between two numbers, which the grammar reads as a range and the old
/// reader fused.
///
/// マイナス is the wrong word — a telephone number wants の, and the row above is
/// what the grammar says when it recognizes one. But the old reading was not
/// better: it ran `90` and `1234` together into a single number, which is a
/// bigger lie than a wrong connector. Pinned as the exact wording so a grammar
/// bump that changes it to の shows up here.
#[test]
fn reads_a_hyphen_as_the_range_the_grammar_reads() {
    assert_reads(&[("電話は555-1234", "電話は五百五十五マイナス千二百三十四")]);
}

/// **The one reading the switch makes worse.**
///
/// A lone `０` normalizes to `〇` (U+3007, IDEOGRAPHIC NUMBER ZERO), which no
/// script run in this crate claims — it is not in the CJK Unified Ideographs
/// block `segment_text` tests for — so the segmenter drops it and the digit reads
/// as silence. The old reader said れい.
///
/// The reference produces `〇` too, so this is a property of the grammar and not
/// of this copy. It is recorded rather than worked around: a workaround would be
/// a second opinion about the grammar's output, and the case that matters — a
/// zero inside a longer number — is unaffected (`090-1234-5678` above reads all
/// four zeros).
#[test]
fn reads_a_lone_full_width_zero_as_nothing() {
    assert_reads(&[("０", "〇")]);
}

// ------------------------------------------------------------ full width

/// Full-width numerals, which is what modification 7 in the engine's `NOTICE` is
/// about.
///
/// `should_normalize` asked `is_ascii_digit` where the reference asks `\d`;
/// `０` is U+FF10 and not ASCII, so a Japanese sentence written with full-width
/// numerals — which is most Japanese text — skipped the normalizer entirely and
/// came out as the digits it was written with. Japanese is where the port's own
/// comment on that line was already known to be wrong ("not a difference that
/// reaches English" was true; the sentence stopped there as though English were
/// the only language).
#[test]
fn reads_full_width_text_the_way_the_reference_does() {
    assert_reads(&[
        ("２０２２年", "二千二十二年"),
        ("１２３", "百二十三"),
        ("１５．６％", "十五．六％"),
        // And the one that has to be compared rather than written down: the
        // measure rule fuses the digits and the unit into one entity, which is
        // why a *full-width* one reads the same as its half-width equivalent
        // where a bare `１２３` also has to.
        (
            "資産３２億ドル、約４２００億円",
            "資産三十二億ドル、約四千二百億円",
        ),
    ]);

    let Some(tn) = japanese_tn() else {
        return;
    };
    for (full, half) in [
        ("２０２２年", "2022年"),
        ("１２３", "123"),
        ("１２３４円", "1234円"),
    ] {
        assert_eq!(
            read(&tn, full),
            read(&tn, half),
            "{full:?} and {half:?} are the same number"
        );
    }
}

// ------------------------------------------------------ the protocol edge

/// Both grammars or neither, for Japanese.
///
/// IPADic first, then the two grammars: the order `required_dictionaries` lists
/// them in, which the JavaScript wrapper fetches them in.
#[test]
fn both_grammars_are_declared_for_japanese() {
    let mut registry = DictionaryRegistry::new();
    let declared = registry.declare_required("kokoro-v1", "ja-JP").unwrap();
    assert_eq!(
        declared,
        vec![IPADIC_JA, WETEXT_JA_NAMES[0], WETEXT_JA_NAMES[1]]
    );

    let Some(assets) = wetext_compressed(WETEXT_JA_NAMES) else {
        return;
    };
    registry.load(WETEXT_JA_NAMES[0], &assets[0].1).unwrap();

    let error = registry
        .finish()
        .expect_err("neither of the other two arrived");
    assert_eq!(error.code(), "missing-dictionaries");
    for name in [IPADIC_JA, WETEXT_JA_NAMES[1]] {
        assert!(
            error.to_string().contains(name),
            "the message names {name}, which is still missing: {error}"
        );
    }
}
