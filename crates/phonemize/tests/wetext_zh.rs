//! Chinese text normalization (phase 9E).
//!
//! Two halves, the same as `wetext_en.rs`: what the grammars *say*, asserted on
//! the words rather than on the phonemes those words become, and what the
//! registry promises about them.
//!
//! **Every reading below was checked against the Python reference** —
//! `pip install wetext==0.1.8`, the distribution these FSTs are extracted from —
//! on a probe set of 48 Chinese inputs. Our copy agrees on 47. The one exception
//! is `1.2.3%`, a malformed number that the reference's chained-regex front end
//! and this FST composition fragment differently; both answers are arbitrary and
//! ours happens to be the one the hand-written reader gave, so it is pinned as a
//! known difference rather than treated as a defect. That probe is not committed,
//! so what is *pinned* is the tables below.
//!
//! The full-width cases are the reason this phase needed a change **inside** the
//! vendored copy rather than only around it: `should_normalize` gated on
//! `is_ascii_digit` where the reference gates on `\d`, and `０` is not an ASCII
//! digit — so every full-width numeral skipped the normalizer entirely and came
//! out as the digits it was written with. That is modification 7 in the engine's
//! `NOTICE`; `reads_full_width_text_the_way_the_reference_does` is the test that
//! holds it.

mod common;

use phonemize::dictionary::{DictionaryRegistry, JIEBA_ZH};
use phonemize::tn::wetext::Normalizer;

use common::{chinese_tn, wetext_compressed, WETEXT_ZH_NAMES};

/// One reading, from an engine the caller already built.
///
/// The engine is a parameter rather than built per row: parsing the two
/// grammars costs 1.6 MB of FST, and a table of rows each paying that would be
/// most of this test's running time.
fn read(tn: &Normalizer, text: &str) -> String {
    tn.normalize(text)
        .unwrap_or_else(|error| panic!("{text:?} normalizes: {error}"))
}

/// A table of `(input, reading)`, asserted row by row.
fn assert_reads(table: &[(&str, &str)]) {
    let Some(tn) = chinese_tn() else {
        return;
    };
    for (input, expected) in table {
        assert_eq!(read(&tn, input), *expected, "{input:?}");
    }
}

// ------------------------------------------------------- the entity classes

/// The classes the hand-written reader cannot read, one per class.
///
/// This is what the engine is here for. `numbers_to_han` reads four digit shapes
/// and nothing else — no date, no clock time, no money, no fraction, no unit — so
/// each row below is a reading that did not exist before phase 9E. Compare
/// `tests/zh_pipeline.rs`'s tables for what each one does to the phonemes.
#[test]
fn reads_the_entity_classes_the_hand_written_reader_could_not() {
    assert_reads(&[
        // A year is read digit by digit, which the hand-written reader cannot do
        // because it has no context: it says 二千零二十四 for `2024` wherever it
        // appears, and that is right for a quantity and wrong for a year.
        ("2024年", "二零二四年"),
        // A clock time, where the old pipeline left the colon in the output and
        // the punctuation filter kept it.
        ("下午3:30", "下午三点三十分"),
        ("18:30", "十八点三十分"),
        // Money: the sign used to be dropped by the punctuation filter, so
        // `$20.50` was 二十点五零 and nothing said dollars.
        ("$20.50", "二十点五零美元"),
        // A fraction, which the old reader read as two cardinals: 一二.
        ("1/2", "二分之一"),
        // A date.
        ("3月5日", "三月五日"),
        // Percentages, which the old reader *also* read — kept as the control
        // rows that prove the engine is not simply different everywhere.
        ("50%", "百分之五十"),
        ("15.6%", "百分之十五点六"),
    ]);
}

/// A grouped number, which is the one class where the old reader and the new one
/// are both wrong and the grammar is only differently wrong.
///
/// `numbers_to_han` stops at a thousands separator because a comma is *also* a
/// sentence pause and cannot be removed globally, so a bare `1,234` loses its
/// leading digit. The tagger fragments it too, for a different reason. What the
/// grammar adds is the *measure* case: given something to count, it reads the
/// whole number, and separately it switches 二 to 两.
#[test]
fn reads_a_grouped_number_when_there_is_something_to_count() {
    assert_reads(&[
        ("1,234个", "一千二百三十四个"),
        ("1,234", "一,两百三十四"),
        ("2,000", "二,零零零"),
        ("200元", "两百元"),
    ]);
}

/// The numerals both readers agree on.
///
/// A change in any of these is a change in the grammar rather than in the wiring,
/// which is exactly what a pinned table is for — and `123` and `3.14` are also
/// corpus samples, so the JavaScript pins them independently.
#[test]
fn reads_a_bare_cardinal_the_way_the_hand_written_reader_did() {
    assert_reads(&[
        ("123", "一百二十三"),
        ("0", "零"),
        ("10", "十"),
        ("100015", "十万零一十五"),
        ("我有3只猫", "我有三只猫"),
        ("两千", "两千"),
    ]);
}

// ------------------------------------------------------------ full width

/// **The bug this phase found in the vendored copy.**
///
/// `should_normalize` asked `is_ascii_digit` where the reference asks `\d`, and
/// over a Python `str` that is every character in Unicode general category `Nd`.
/// `０` is U+FF10 and not ASCII, so every full-width numeral in a Chinese or
/// Japanese sentence took the "nothing to normalize here" early return and came
/// out as the digits it was written with — silently, because the fallback reads
/// them the same way, which is what the pipeline did before the engine existed.
///
/// English could not see it: `should_normalize` is not consulted for English,
/// which normalizes whatever it is given (modification 5 in `NOTICE`). That is
/// why this survived from phase 9B to 9E.
///
/// The fix is modification 7. Both readings below are the reference's.
#[test]
fn reads_full_width_text_the_way_the_reference_does() {
    assert_reads(&[
        // The full stop inside a number is full-width in the source and stays
        // that way: the grammar reads the digits either side of it.
        ("１５．６", "十五．六"),
        ("２０２２年", "二零二二年"),
        // The cost of the fix, and of using the reference's grammar at all: the
        // tagger splits a zero-padded number rather than stripping the pad, so
        // this reads 零一百二十三 where `numbers_to_han` said 一百二十三.
        ("０１２３", "零一百二十三"),
    ]);

    let Some(tn) = chinese_tn() else {
        return;
    };
    // The property a reader would expect, and the one the bug broke: full-width
    // and half-width text read the same. It holds for the year and, deliberately,
    // *not* for the padded number — `0123` fragments the same way, so the two
    // agree on the wrong answer rather than on the right one.
    for (full, half) in [
        ("２０２２年", "2022年"),
        ("０１２３", "0123"),
        ("１２３", "123"),
    ] {
        assert_eq!(
            read(&tn, full),
            read(&tn, half),
            "{full:?} and {half:?} are the same number"
        );
    }
}

/// The one input our copy and the reference disagree about.
///
/// `1.2.3%` is not a number. The reference's front end applies four chained
/// regexes and finds the `2.3%` that the first rule had already walked past,
/// giving 一点二.百分之三; this copy composes the whole string with the tagger,
/// which fragments it at the first dot and gives 一.百分之二点三 — which is what
/// `numbers_to_han` gives for the same input, so wiring the engine did not change
/// the reading of this input at all. Pinned so a grammar bump surfaces here
/// rather than in a corpus.
#[test]
fn fragments_a_malformed_number_the_way_this_engine_does() {
    assert_reads(&[("1.2.3%", "一.百分之二点三"), ("1.2.3", "一.二点三")]);
}

// ------------------------------------------------------ the protocol edge

/// Both grammars or neither, and the registry is where that is decided.
///
/// The same check `wetext_en.rs` makes for English, repeated because the failure
/// it guards is per language: a Chinese voice whose tagger arrived and whose
/// verbalizer did not would otherwise fail in the middle of a sentence. Asserted
/// on the registry rather than through `Phonemizer`, because the wasm boundary
/// returns `Result<_, JsValue>` and building a `JsValue` panics off wasm — the
/// same split `tests/dictionary.rs` makes.
#[test]
fn both_grammars_are_declared_for_chinese() {
    let mut registry = DictionaryRegistry::new();
    let declared = registry.declare_required("kokoro-v1", "zh-CN").unwrap();

    // jieba's word list first, then the two grammars: the order the registry
    // lists them in, which the JavaScript wrapper fetches them in.
    assert_eq!(
        declared,
        vec![JIEBA_ZH, WETEXT_ZH_NAMES[0], WETEXT_ZH_NAMES[1]]
    );

    let Some(assets) = wetext_compressed(WETEXT_ZH_NAMES) else {
        return;
    };
    registry.load(WETEXT_ZH_NAMES[0], &assets[0].1).unwrap();

    let error = registry
        .finish()
        .expect_err("neither of the other two arrived");
    assert_eq!(error.code(), "missing-dictionaries");
    for name in [JIEBA_ZH, WETEXT_ZH_NAMES[1]] {
        assert!(
            error.to_string().contains(name),
            "the message names {name}, which is still missing: {error}"
        );
    }
}

// ------------------------------------------------ the English-only fix

/// **The `1,NNN` fix is English-only, and this is what says so.**
///
/// `fix_one_thousand_bug` inserts an `one` in front of the word `thousand`
/// wherever the *shared* numeral step produced one. While it sat on that shared
/// path it was one English word away from rewriting a Chinese sentence — every
/// input below contains the letters.
#[test]
fn the_english_thousand_fix_does_not_reach_chinese() {
    let Some(tn) = chinese_tn() else {
        return;
    };

    let mut saw_the_trigger = false;
    for input in [
        "我有 thousand 只猫",
        "thousand two hundred",
        "这是 1,234 和 thousand",
    ] {
        let engine = read(&tn, input);
        saw_the_trigger |= engine.contains("thousand");
        let stepped = phonemize::tn::normalize(input, phonemize::tn::Lang::Zh, Some(&tn));
        assert_eq!(
            stepped.as_ref(),
            engine.as_str(),
            "{input:?} keeps the engine's answer, unrevised"
        );
    }
    assert!(
        saw_the_trigger,
        "none of the probes reached the fix it is guarding against"
    );
}
