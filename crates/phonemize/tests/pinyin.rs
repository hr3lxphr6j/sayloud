//! The Chinese pinyin backend: `pinyin-pro`'s readings and the syllable table.
//!
//! Two layers live here, and they are tested separately because they fail
//! separately:
//!
//! - **Readings.** Which pinyin a character gets, in context. `pinyin-pro` is
//!   the reference — the JavaScript pipeline calls it and nothing else — so the
//!   expected values below were read off `pinyin(text, { toneType: 'num', type:
//!   'array', nonZh: 'removed' })`, and the corpus in
//!   `tests/fixtures/zh-parity.json` pins the same agreement over sentences
//!   rather than over the handful of interesting words here.
//! - **The syllable table.** Pinyin to IPA, with the tone as one of Kokoro's
//!   four arrows. The expectations are the JavaScript test's
//!   (`tests/unit/models/phonemize.test.ts`), which are the values the model was
//!   trained on.
//!
//! The word boundaries are deliberately not here: `han_to_ipa` puts one space
//! between syllables, which is what the JavaScript side's `singleSyllableWords`
//! does, and grouping them into words needs jieba.

use phonemize::g2p::{ChinesePinyin, PinyinError};

/// The readings of one text, as `pinyin-pro` reports them with `toneType: 'num'`.
fn pinyin(text: &str) -> Vec<&'static str> {
    ChinesePinyin::new().text_to_pinyin(text)
}

// ------------------------------------------------------------------ readings

#[test]
fn reads_a_character_as_its_first_reading() {
    let chinese = ChinesePinyin::new();

    // Toneless, which is what `char_to_pinyin` promises: the tone is a separate
    // question, and the IPA step is the only thing that needs it.
    for (character, expected) in [
        ('你', "ni"),
        ('好', "hao"),
        ('世', "shi"),
        ('界', "jie"),
        ('〇', "ling"),
        // In the CJK extension block, which is a different dictionary key shape
        // on the JavaScript side (astral characters are two code units there).
        ('㑇', "zhou"),
    ] {
        assert_eq!(
            chinese.char_to_pinyin(character),
            Some(expected),
            "{character}"
        );
    }

    // A Han character `pinyin-pro` has no reading for, and a non-Han one, are
    // both `None` — the distinction between them is the caller's, not this
    // layer's.
    assert_eq!(chinese.char_to_pinyin('㐀'), None);
    assert_eq!(chinese.char_to_pinyin('a'), None);
}

#[test]
fn reads_a_sentence_one_syllable_per_character() {
    assert_eq!(pinyin("你好世界"), ["ni3", "hao3", "shi4", "jie4"]);
}

#[test]
fn resolves_a_polyphone_from_the_words_around_it() {
    // The whole reason the phrase tables are ported rather than approximated:
    // 行 and 长 on their own are xíng and cháng, and 银行行长 is háng and zhǎng.
    // Taking each character's first reading would get both wrong, and it is not
    // a rare word — it is 14% of the characters in an ordinary sentence.
    assert_eq!(pinyin("银行行长"), ["yin2", "hang2", "hang2", "zhang3"]);
    assert_eq!(
        pinyin("一行白鹭上青天"),
        ["yi4", "hang2", "bai2", "lu4", "shang4", "qing1", "tian1"]
    );
    assert_eq!(pinyin("长大了"), ["zhang3", "da4", "le0"]);
    assert_eq!(
        pinyin("音乐和快乐"),
        ["yin1", "yue4", "he2", "kuai4", "le4"]
    );
    assert_eq!(pinyin("重复一遍"), ["chong2", "fu4", "yi2", "bian4"]);
    assert_eq!(pinyin("的确"), ["di2", "que4"]);
    assert_eq!(pinyin("目的"), ["mu4", "di4"]);
}

#[test]
fn applies_the_yi_and_bu_tone_sandhi() {
    // `toneSandhi: true` is pinyin-pro's default and `chinese.ts` does not turn
    // it off, so 一 and 不 change tone with what follows: 一个 is yí, not yī.
    assert_eq!(pinyin("一个"), ["yi2", "ge4"]);
    assert_eq!(pinyin("不是"), ["bu2", "shi4"]);

    // Between two of the same character they lose the tone entirely — the rule
    // is applied before the one above, and the result is `yi0`, not `yi`.
    assert_eq!(pinyin("看一看"), ["kan4", "yi0", "kan4"]);
    assert_eq!(pinyin("去不去"), ["qu4", "bu0", "qu4"]);

    // Alone, there is nothing to sandhi against.
    assert_eq!(pinyin("一"), ["yi1"]);
    assert_eq!(pinyin("不"), ["bu4"]);
}

#[test]
fn does_not_sandhi_before_a_blocking_suffix() {
    // `toneSandhiIgnoreSuffix`: these followers leave 一/不 alone. The list is
    // in the generated data, so a change to it is a change to the data file.
    assert_eq!(pinyin("一的"), ["yi1", "de0"]);
}

#[test]
fn reads_liao_when_nothing_chinese_comes_before_the_le() {
    // `了` alone is liǎo — `pinyin-pro`'s `processToneSandhiLiao`. After a Han
    // character it is the neutral `le`, which is the reading the table gives it.
    assert_eq!(pinyin("了"), ["liao3"]);
    assert_eq!(pinyin("长大了"), ["zhang3", "da4", "le0"]);
}

#[test]
fn reads_the_reduplication_mark_as_the_character_before_it() {
    assert_eq!(pinyin("人々"), ["ren2", "ren2"]);
    // With nothing before it, `handle.mjs` falls back to 同.
    assert_eq!(pinyin("々"), ["tong2"]);
}

#[test]
fn drops_characters_pinyin_pro_cannot_read_from_the_readings() {
    // `nonZh: 'removed'`: a Latin character and a Han character outside the
    // dictionary both leave the array, which is why the caller has to check the
    // count rather than the contents.
    assert_eq!(pinyin("你好abc"), ["ni3", "hao3"]);
    assert_eq!(pinyin("你好㐀"), ["ni3", "hao3"]);

    // One slot per character, with `None` where there is no reading — the shape
    // `han_to_ipa` uses to tell "unreadable" from "not Chinese".
    let readings = ChinesePinyin::new().readings("你好abc");
    assert_eq!(readings.len(), 5);
    assert_eq!(readings[0].map(|s| s.as_str()), Some("ni3"));
    assert_eq!(readings[2], None);
}

// ---------------------------------------------------------------------- IPA

/// The Han run's IPA, one space per syllable (`singleSyllableWords`).
fn ipa(han: &str) -> String {
    ChinesePinyin::new()
        .han_to_ipa(han)
        .unwrap_or_else(|error| panic!("{han} phonemizes: {error}"))
}

#[test]
fn produces_the_verified_ipa_for_a_sentence() {
    // The same string as `tests/unit/models/phonemize.test.ts`, which is the
    // value the model was trained on.
    assert_eq!(ipa("你好世界"), "ni↓ xau↓ ʂɻ̩↘ ʨje↘");
}

#[test]
fn gives_the_four_tones_four_different_shapes() {
    // Kokoro's tokenizer has the four arrows and no tone digits at all, which is
    // why the table stores a `0` placeholder and the tone is folded in here.
    let shapes: Vec<String> = ['妈', '麻', '马', '骂']
        .iter()
        .map(|c| ipa(&c.to_string()))
        .collect();
    assert_eq!(shapes, ["ma→", "ma↗", "ma↓", "ma↘"]);
}

#[test]
fn leaves_the_neutral_tone_toneless() {
    // `pinyin-pro` numbers the neutral tone `0` and the table uses `5`; skipping
    // that mapping would leave the `0` in the IPA, where the tokenizer has no
    // digits — and would drop the tone with it.
    let neutral = ipa("吗");
    assert_eq!(neutral, "ma");
    assert!(!neutral.contains('0'));
}

#[test]
fn resolves_a_syllable_spelled_with_u_diaeresis() {
    // The table spells it `v` (pypinyin's toneless form) and `pinyin-pro` spells
    // it `ü`, so the lookup has to translate. Without that these characters
    // disappear from the audio with no error at all.
    assert_eq!(ipa("女"), "ny↓");
    assert_eq!(ipa("绿"), "ly↘");
    assert_eq!(ipa("略"), "lɥe↘");
    assert_eq!(ipa("虐"), "nɥe↘");
}

#[test]
fn deletes_the_combining_inverted_breve_that_misaki_deletes() {
    // misaki's legacy path ends with `replace(chr(815), '')`. The tokenizer's
    // normalizer would drop it anyway, but matching the training target exactly
    // is what lets the two be compared strictly. 好 has the mark, 你 does not.
    assert_eq!(ipa("好"), "xau↓");
    assert!(!ipa("好").contains('\u{032F}'));
}

#[test]
fn keeps_the_combining_vertical_line_the_tokenizer_needs() {
    // ʂɻ̩ carries U+0329, and unlike U+032F it is *not* deleted: it is in the
    // model's vocabulary as a combining mark, and dropping it would change the
    // syllable. The vocab gate allows it for the same reason.
    assert!(ipa("世").contains('\u{0329}'));
}

#[test]
fn refuses_a_character_it_cannot_read() {
    let chinese = ChinesePinyin::new();

    // U+3400 is in the Han range and absent from the dictionary. Returning an
    // empty string — as the verification script did — drops the character from
    // the audio without a trace, and a sentence missing a word sounds like a
    // sentence.
    let error = chinese.han_to_ipa("你好㐀").expect_err("㐀 has no reading");
    assert!(matches!(error, PinyinError::UnreadableCharacters { .. }));
    assert_eq!(error.code(), "unreadable-characters");
    assert!(error.to_string().contains("could not read"), "{error}");

    let error = chinese.han_to_ipa("㐀").expect_err("㐀 has no reading");
    assert!(error.to_string().contains("0/1"), "{error}");
}

#[test]
fn reports_a_syllable_the_table_does_not_have() {
    // Upstream's own data has one: `DICT4` spells 枝大于本 as `zh dà yú běn`, so
    // 枝 comes out as `zh`. The JavaScript side then does `Number('h')`, takes
    // the syllable `z`, misses the table and throws — and so does this, with the
    // same syllable in the message.
    let chinese = ChinesePinyin::new();
    assert_eq!(
        chinese.text_to_pinyin("枝大于本"),
        ["zh", "da4", "yu2", "ben3"]
    );

    let error = chinese
        .han_to_ipa("枝大于本")
        .expect_err("`zh` is not a syllable");
    assert!(matches!(error, PinyinError::UnknownSyllable { .. }));
    assert_eq!(error.code(), "unknown-syllable");
    assert!(error.to_string().contains("\"z\""), "{error}");
}

#[test]
fn a_reading_with_no_tone_is_not_given_one() {
    // 哼's second reading is `hng`, which has no tone mark and no plain vowel,
    // so `getNumOfTone` returns `''` and `pinyin-pro` emits `hng` with nothing
    // after it. No text selects it — the first reading is `hēng` and no phrase
    // pattern contains 哼 — but the data carries it, so the parser has to read
    // it back as "no tone" rather than as the tone `g`.
    let chinese = ChinesePinyin::new();
    assert_eq!(chinese.char_to_pinyin('哼'), Some("heng"));

    let readings = chinese.readings("哼");
    assert_eq!(readings[0].map(|s| s.as_str()), Some("heng1"));

    // And the one syllable in the data with no tone at all parses as such.
    let syllable = ChinesePinyin::new();
    assert_eq!(syllable.text_to_pinyin("哼哼"), ["heng1", "heng1"]);
}

#[test]
fn an_erhua_syllable_is_its_final_plus_the_coda() {
    // The tone rules write the erhua coda as an `r` before the tone digit
    // — `wanr2` for 玩儿 — because that is where PaddleSpeech puts it: on the
    // final, which for 玩 is `uan`, so the reference has `w` + `uanr2`. The
    // syllable table has no erhua entries and should not grow any: misaki's v1.0
    // frontend reads 玩儿 as two syllables, so an entry would be a syllable
    // transcribed from a model that never saw one. The coda is peeled off here
    // and appended to the IPA instead.
    let chinese = ChinesePinyin::new();
    assert_eq!(chinese.syllable_to_ipa("wanr2", "玩儿").unwrap(), "wa↗nɻ");
    assert_eq!(
        chinese.syllable_to_ipa("huir4", "一会儿").unwrap(),
        "xwei↘ɻ"
    );

    // `er` ends in `r` and is a syllable, not a coda, so it is read whole.
    assert_eq!(chinese.syllable_to_ipa("er2", "儿").unwrap(), "ɚ↗");

    // The `ü` translation happens *after* the coda comes off, or the key would be
    // `lyr`: 驴儿 is `lü` + coda, and the table spells that `lv`.
    assert_eq!(chinese.syllable_to_ipa("lür2", "驴儿").unwrap(), "ly↗ɻ");

    // And a coda on a syllable the table does not have is that syllable's error
    // and not a second, erhua-shaped one.
    let error = chinese
        .syllable_to_ipa("warr2", "玩儿")
        .expect_err("there is no syllable under the coda");
    assert!(matches!(error, PinyinError::UnknownSyllable { .. }));
}
