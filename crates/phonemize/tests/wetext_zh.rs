//! Chinese text normalization.
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
//! The full-width cases are the reason the vendored copy needed a change **inside**
//! it rather than only around it: `should_normalize` gated on
//! `is_ascii_digit` where the reference gates on `\d`, and `０` is not an ASCII
//! digit — so every full-width numeral skipped the normalizer entirely and came
//! out as the digits it was written with. That is modification 7 in the engine's
//! `NOTICE`; `reads_full_width_text_the_way_the_reference_does` is the test that
//! holds it.

mod common;

use phonemize::dictionary::{
    DictionaryRegistry, JIEBA_ZH, WETEXT_ZH_TN_TAGGER, WETEXT_ZH_TN_TRADITIONAL_TO_SIMPLE,
    WETEXT_ZH_TN_VERBALIZER,
};
use phonemize::tn::wetext::Normalizer;

use common::{chinese_options, chinese_phonemizer, chinese_tn, wetext_compressed, WETEXT_ZH_NAMES};

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
/// each row below is a reading the hand-written reader never produced. Compare
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

/// **Full-width numerals, which the tagger reads itself.**
///
/// `should_normalize` asked `is_ascii_digit` where the reference asks `\d`, and
/// `０` is U+FF10 rather than ASCII, so every full-width numeral in a Chinese or
/// Japanese sentence took the "nothing to normalize here" early return and came out
/// as the digits it was written with — silently, because the fallback reads them the
/// same way, which is what the pipeline did before the engine existed. That is
/// modification 7 in `NOTICE`, and the readings below are what it bought.
///
/// **What is *not* here is the full-width-to-half-width fold.** Chinese's is
/// [`to_half_width`](phonemize::text::to_half_width), called by the pipeline
/// *after* `map_punctuation` — the numeral step has to run before the map, because
/// the grammar reads a full-width `．` as a decimal point and the map turns that same
/// character into a full stop, so a fold in `preprocess` would rewrite `，` and `。`
/// before the map owned them. `engine::chinese` has the measurement. The two rows
/// that show the seam are `１５．６` — read here as 十五．六, with the mark left for the
/// map — and `ＡＢＣ`, which the engine leaves alone and the pipeline folds;
/// `zh_pipeline.rs` pins the fold end to end.
#[test]
fn reads_full_width_text_the_way_the_reference_does() {
    assert_reads(&[
        ("２０２２年", "二零二二年"),
        ("１２３", "一百二十三"),
        // The cost of the fix, and of using the reference's grammar at all: the
        // tagger splits a zero-padded number rather than stripping the pad, so
        // this reads 零一百二十三 where `numbers_to_han` said 一百二十三.
        ("０１２３", "零一百二十三"),
        // A full-width decimal point: the digits on both sides are one number and
        // the mark is what the tagger read, not a full stop — which is exactly why
        // this step cannot be preceded by a fold. The pipeline maps it afterwards,
        // and `zh_pipeline.rs` records what that costs.
        ("１５．６", "十五．六"),
        // And the blind spot the engine has on purpose: full-width *Latin* is not
        // a numeral, so nothing here touches it.
        ("ＡＢＣ", "ＡＢＣ"),
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

// ------------------------------------------------------- traditional script

/// **A traditional spelling is rewritten before the phonemes are looked up.**
///
/// `traditional_to_simple`, off upstream and now on — see
/// `../src/tn/engine.rs` for the phoneme table that decided it. The mechanism:
/// pinyin-pro's polyphone disambiguation is a *phrase* table over simplified
/// spellings, so 銀行 misses its 行→háng entry and falls back to the character's
/// default reading. Both readings are asserted below for that reason — the text
/// this step produces, and the phonemes that come out of it.
///
/// The conservative rows are the half that makes the switch safe to turn on. The
/// FST does not make the lossy classical mappings people fear: 乾 is never
/// rewritten (so 乾燥 is not 干燥 and 乾隆 keeps its qián), and 著, 藉 and 繫 come
/// back unchanged, which is why "the script is rewritten" does not mean "a
/// one-to-many character is guessed at".
#[test]
fn rewrites_traditional_characters_before_chinese_reads_them() {
    assert_reads(&[
        ("銀行", "银行"),
        ("銀行行長", "银行行长"),
        ("音樂", "音乐"),
        ("會計", "会计"),
        ("長大", "长大"),
        ("為了", "为了"),
        ("重複", "重复"),
        ("還是有", "还是有"),
        ("後面有這個", "后面有这个"),
        ("繁體字", "繁体字"),
        // The conservative rows: a character with two simplified targets is left
        // alone rather than guessed at.
        ("乾燥", "乾燥"),
        ("乾隆", "乾隆"),
        ("著作", "著作"),
        ("藉口", "藉口"),
    ]);
}

/// The same step, seen in phonemes.
///
/// The word-level test above says the script moved; this says the reading did.
/// Each row is a traditional word whose polyphone the phrase table can only
/// resolve once the spelling is simplified, with the phonemes the simplified form
/// gets — and the pipeline is asserted to give the same ones either way, which is
/// the property that matters: 繁体 and 简体 text read alike.
///
/// The `before` column is not pinned anywhere and is recorded here because it is
/// what the step buys: 銀行 was `i↗nɕi↗ŋ` (xíng), 音樂 was `i→nlɤ↘` (lè).
#[test]
fn the_phonemes_of_a_traditional_word_are_the_phonemes_of_its_simplified_form() {
    let Some(phonemizer) = chinese_phonemizer() else {
        return;
    };

    for (traditional, simplified, phonemes) in [
        ("銀行", "银行", "i↗nxa↗ŋ"),
        ("音樂", "音乐", "i→nɥe↘"),
        ("會計", "会计", "kʰwai↘ʨi↘"),
        ("長大", "长大", "ꭧa↓ŋta↘"),
        ("為了", "为了", "wei↘lɤ"),
        ("重複", "重复", "ꭧʰʊ↗ŋfu↘"),
        ("還是有", "还是有", "xai↗ʂɻ̩↘ jou↓"),
    ] {
        for text in [traditional, simplified] {
            let ipa = phonemizer
                .phonemize_with(text, &chinese_options())
                .unwrap_or_else(|error| panic!("{text:?}: {error}"))
                .phonemes;
            assert_eq!(ipa, phonemes, "phonemizing {text:?}");
        }
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

/// Every FST a language declares has to arrive, and the registry is where that is
/// decided.
///
/// The same check `wetext_en.rs` makes for English, repeated because the failure
/// it guards is per language — and Chinese is the language whose third FST is
/// *not* the shared one: `traditional_to_simple` is Chinese's alone, and
/// `full_to_half` is declared by the other two instead. Asserted on the registry
/// rather than through `Phonemizer`, because the wasm boundary returns
/// `Result<_, JsValue>` and building a `JsValue` panics off wasm — the same split
/// `tests/dictionary.rs` makes.
#[test]
fn every_fst_chinese_declares_has_to_arrive() {
    let mut registry = DictionaryRegistry::new();
    let declared = registry.declare_required("kokoro-v1", "zh-CN").unwrap();

    // jieba's word list first, then the FSTs: the order the registry lists them
    // in, which the JavaScript wrapper fetches them in.
    assert_eq!(
        declared,
        vec![
            JIEBA_ZH,
            WETEXT_ZH_TN_TAGGER,
            WETEXT_ZH_TN_VERBALIZER,
            WETEXT_ZH_TN_TRADITIONAL_TO_SIMPLE,
        ]
    );

    let Some(assets) = wetext_compressed(WETEXT_ZH_NAMES) else {
        return;
    };
    registry.load(WETEXT_ZH_NAMES[0], &assets[0].1).unwrap();

    let error = registry
        .finish()
        .expect_err("none of the other four arrived");
    assert_eq!(error.code(), "missing-dictionaries");
    for name in [
        JIEBA_ZH,
        WETEXT_ZH_TN_VERBALIZER,
        WETEXT_ZH_TN_TRADITIONAL_TO_SIMPLE,
    ] {
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
