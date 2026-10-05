//! Japanese G2P, without a dictionary.
//!
//! Everything here is a pure function, so these run everywhere — including where
//! the 8.5 MB dictionary asset has not been built. The expectations were copied
//! from the JavaScript chain's `tests/unit/models/phonemize/japanese.test.ts`
//! (deleted in phase 8) and live here now: the same inputs had to produce the
//! same strings on both sides, and a table or range that drifts shows up here as
//! a failure naming the mora.

use std::collections::HashSet;

use phonemize::backends::numbers::{int_to_kanji, numbers_to_kanji};
use phonemize::frontends::ja_ipa::{fix_numeral_sound_changes, kana_to_ipa, KATAKANA_TO_IPA};
use phonemize::kana::{is_kanji, is_katakana, to_raw_katakana};
use phonemize::text::{
    collapse_whitespace, keep_punctuation, normalize_punctuation, segment_text, ScriptRun,
};
use phonemize::vocab::{validate_phonemes, Vocab};

// ---------------------------------------------------------------- the table

#[test]
fn every_table_entry_only_spells_with_characters_kokoro_has() {
    // The tokenizer's normalizer is a `Replace` with an empty string, so a
    // character outside the vocabulary is *deleted*, not approximated — and a
    // deleted character is not an error. ガ came out `a` for exactly this kind
    // of mistake until it was caught.
    //
    // The vocabulary is the model's own, from `src/vocab.rs` — phase 5 replaced
    // the copy this test used to carry, which held the whole ASCII lowercase
    // alphabet and so could not have caught ガ's ASCII `g`. Checking through the
    // production gate rather than against a set built here makes this a proof
    // rather than the floor that copy was: whitespace and the two combining marks
    // the tokenizer strips are allowed for the same reason they are allowed in
    // production.
    assert!(
        Vocab::V1_0.characters().any(|ch| ch == '\u{261}'),
        "the vocabulary should hold U+0261"
    );

    let offenders: Vec<String> = KATAKANA_TO_IPA
        .iter()
        .filter_map(|(kana, ipa)| {
            validate_phonemes(ipa, Vocab::V1_0)
                .err()
                .map(|error| format!("{kana} → {ipa}: {error}"))
        })
        .collect();

    assert_eq!(offenders, Vec::<String>::new());
}

#[test]
fn the_table_has_no_duplicate_keys() {
    // A duplicate in the JavaScript object literal would be silently collapsed
    // (last one wins), while a Rust slice would keep both and a first-match
    // lookup would pick the other one. `scripts/generate/gen-ja-ipa-table.py` rejects
    // them at generation time; this is the check that survives someone editing
    // the generated file.
    let mut seen = HashSet::new();
    let duplicates: Vec<&str> = KATAKANA_TO_IPA
        .iter()
        .map(|(kana, _)| *kana)
        .filter(|kana| !seen.insert(*kana))
        .collect();

    assert_eq!(duplicates, Vec::<&str>::new());
}

#[test]
fn every_table_key_is_one_or_two_characters() {
    // The lookup reads at most two characters ahead, so a longer key could never
    // be found — it would silently do nothing at all.
    let too_long: Vec<&str> = KATAKANA_TO_IPA
        .iter()
        .map(|(kana, _)| *kana)
        .filter(|kana| kana.chars().count() > 2)
        .collect();

    assert_eq!(too_long, Vec::<&str>::new());
}

// ------------------------------------------------------------- kana to IPA

#[test]
fn converts_the_basic_rows() {
    assert_eq!(kana_to_ipa("あいうえお"), "aiueo");
    assert_eq!(kana_to_ipa("アイウエオ"), "aiueo");
    assert_eq!(kana_to_ipa("かきくけこ"), "kakikukeko");
    assert_eq!(kana_to_ipa("さしすせそ"), "saɕisuseso");
    assert_eq!(kana_to_ipa("ざじずぜぞ"), "zaʥizuzezo");
    assert_eq!(kana_to_ipa("たちつてと"), "taʨiʦuteto");
    assert_eq!(kana_to_ipa("だぢづでど"), "daʥizudedo");
    assert_eq!(kana_to_ipa("なにぬねの"), "naninuneno");
    assert_eq!(kana_to_ipa("はひふへほ"), "hahifuheho");
    assert_eq!(kana_to_ipa("ばびぶべぼ"), "babibubebo");
    assert_eq!(kana_to_ipa("ぱぴぷぺぽ"), "papipupepo");
    assert_eq!(kana_to_ipa("まみむめも"), "mamimumemo");
    assert_eq!(kana_to_ipa("やゆよ"), "jajujo");
    assert_eq!(kana_to_ipa("らりるれろ"), "rarirurero");
    assert_eq!(kana_to_ipa("わをん"), "waoɴ");
}

#[test]
fn writes_the_voiced_velar_with_u0261_not_ascii_g() {
    assert_eq!(kana_to_ipa("がぎぐげご"), "ɡaɡiɡuɡeɡo");

    // Asserted by code point as well, because the two glyphs are near-identical
    // in most fonts and a later "typo fix" would silently undo this.
    let first = kana_to_ipa("が").chars().next().unwrap();
    assert_eq!(first as u32, 0x261);
}

#[test]
fn reads_a_palatalized_pair_as_one_mora() {
    assert_eq!(kana_to_ipa("キャ"), "kja");
    assert_eq!(kana_to_ipa("キュ"), "kju");
    assert_eq!(kana_to_ipa("キョ"), "kjo");
    assert_eq!(kana_to_ipa("リャ"), "rja");
    assert_eq!(kana_to_ipa("ギャ"), "ɡja");
    assert_eq!(kana_to_ipa("ギュ"), "ɡju");
}

#[test]
fn keeps_the_sibilants_palatal_rather_than_adding_a_glide() {
    // ɕ ʥ ʨ are palatal already, so there is no j after them — the shape misaki
    // uses, and the reason キャ and シャ do not look alike in IPA.
    assert_eq!(kana_to_ipa("シャ"), "ɕa");
    assert_eq!(kana_to_ipa("ジュ"), "ʥu");
    assert_eq!(kana_to_ipa("チョ"), "ʨo");
}

#[test]
fn reads_the_foreign_word_pairs() {
    assert_eq!(kana_to_ipa("クァ"), "kwa");
    assert_eq!(kana_to_ipa("ファ"), "fa");
    assert_eq!(kana_to_ipa("ティ"), "ti");
}

#[test]
fn reads_the_special_mora() {
    // Not a doubled consonant: misaki maps ッ to ʔ, and ʔ is what Kokoro has.
    assert_eq!(kana_to_ipa("ロッピャク"), "roʔpjaku");
    assert_eq!(kana_to_ipa("コーヒー"), "koːhiː");
    assert_eq!(kana_to_ipa("ん"), "ɴ");
}

#[test]
fn converts_common_words() {
    assert_eq!(kana_to_ipa("こんにちは"), "koɴniʨiha");
    assert_eq!(kana_to_ipa("ありがとう"), "ariɡatou");
    assert_eq!(kana_to_ipa("さようなら"), "sajounara");
    assert_eq!(kana_to_ipa("ひらがなとカタカナ"), "hiraɡanatokatakana");
}

#[test]
fn passes_punctuation_and_spaces_through() {
    assert_eq!(kana_to_ipa("こんにちは、せかい"), "koɴniʨiha、sekai");
    assert_eq!(kana_to_ipa("あ い う"), "a i u");
}

#[test]
fn reads_a_particle_ha_as_ha() {
    // Grammatical particle detection needs context the table does not have, and
    // the JavaScript does not do it either.
    assert_eq!(kana_to_ipa("わたしは"), "wataɕiha");
}

#[test]
fn keeps_an_unknown_character_rather_than_dropping_it() {
    // A silent drop is the failure mode this whole table exists to avoid, so the
    // unknown path is the one thing that must stay visible. The vocabulary gate
    // (spec §1.3, phase 5) is what turns it into a report.
    assert_eq!(kana_to_ipa("あQい"), "aQi");
}

// ------------------------------------------------------------ kana helpers

#[test]
fn to_raw_katakana_shifts_exactly_kuroshiro_s_range() {
    assert_eq!(to_raw_katakana("ひらがな"), "ヒラガナ");
    assert_eq!(to_raw_katakana("ゔ"), "ヴ");

    // The shift is strict at both ends — `> U+3040 && < U+3097` — which is not
    // the same set as kuroshiro's `isHiragana`. These two characters are inside
    // the predicate and outside the shift, and getting the bound wrong would
    // move them.
    assert_eq!(to_raw_katakana("\u{3040}"), "\u{3040}");
    assert_eq!(to_raw_katakana("\u{3097}"), "\u{3097}");
    // …and this one is the last that does shift.
    assert_eq!(to_raw_katakana("\u{3096}"), "\u{30f6}");

    // Katakana is already katakana.
    assert_eq!(to_raw_katakana("カタカナ"), "カタカナ");
}

#[test]
fn katakana_predicate_excludes_the_phonetic_extensions() {
    // `segment_text` counts U+31F0..=U+31FF as kana, kuroshiro's predicate does
    // not. They are different layers and the difference is deliberate; this pins
    // the one that decides how a token's reading is filled in.
    assert!(is_katakana('カ'));
    assert!(!is_katakana('\u{31f0}'));
}

#[test]
fn kanji_predicate_stops_where_kuroshiro_stops() {
    assert!(is_kanji('経'));
    assert!(is_kanji('\u{9fcf}'));
    // U+9FD0..U+9FFF are inside the Unicode block and outside kuroshiro's range.
    assert!(!is_kanji('\u{9fd0}'));
    assert!(is_kanji('\u{3400}'));
}

// ----------------------------------------------------------------- numerals

#[test]
fn reads_integers_as_japanese_numerals() {
    assert_eq!(int_to_kanji("2022"), "二千二十二");
    assert_eq!(int_to_kanji("7"), "七");
    assert_eq!(int_to_kanji("300"), "三百");
    // 十/百/千 drop a leading 一; 万/億/兆 keep theirs.
    assert_eq!(int_to_kanji("1000"), "千");
    assert_eq!(int_to_kanji("8000"), "八千");
    assert_eq!(int_to_kanji("10000"), "一万");
    // An empty group is skipped rather than written out.
    assert_eq!(int_to_kanji("10001"), "一万一");
    assert_eq!(int_to_kanji("0"), "零");
    assert_eq!(int_to_kanji("000"), "零");
    assert_eq!(int_to_kanji("007"), "七");
}

#[test]
fn skips_an_empty_group_in_the_middle_of_a_number() {
    // The case 10001 does not reach: there the empty groups are all above the
    // highest non-empty one. These have a hole *between* two written groups, and
    // writing the group unit anyway would turn 一億一 into 一億万一 — a wrong
    // number that still reads as a number.
    assert_eq!(int_to_kanji("100000001"), "一億一");
    assert_eq!(int_to_kanji("100000000"), "一億");
    assert_eq!(int_to_kanji("100010000"), "一億一万");
    assert_eq!(int_to_kanji("1000000000001"), "一兆一");
}

#[test]
fn reads_a_number_too_large_for_the_group_arithmetic_digit_by_digit() {
    // Past fifteen digits the group arithmetic would lose digits, so both
    // implementations read them one at a time. Not the natural reading of a huge
    // numeral, but it is the number that was written.
    assert_eq!(
        int_to_kanji("1234567890123456"),
        "一二三四五六七八九零一二三四五六"
    );
}

#[test]
fn reads_percentages_and_decimals() {
    assert_eq!(numbers_to_kanji("15%"), "十五パーセント");
    assert_eq!(numbers_to_kanji("15.6%"), "十五点六パーセント");
    assert_eq!(numbers_to_kanji("15.6"), "十五点六");
}

#[test]
fn leaves_a_point_that_is_not_a_decimal_point_alone() {
    // `(\d+)\.(\d+)` needs a digit on both sides, so a trailing point stays.
    assert_eq!(numbers_to_kanji("15."), "十五.");
}

#[test]
fn reads_full_width_digits_the_same_as_half_width_ones() {
    assert_eq!(numbers_to_kanji("２０２２年"), "二千二十二年");
    assert_eq!(numbers_to_kanji("2022年"), "二千二十二年");
}

#[test]
fn reads_the_numbers_out_of_a_sentence() {
    assert_eq!(
        numbers_to_kanji("資産３２億ドル、約４２００億円"),
        "資産三十二億ドル、約四千二百億円"
    );
}

// ------------------------------------------------------- numeral sound changes

#[test]
fn applies_each_numeral_sound_change() {
    assert_eq!(fix_numeral_sound_changes("サンヒャク"), "サンビャク");
    assert_eq!(fix_numeral_sound_changes("ロクヒャク"), "ロッピャク");
    assert_eq!(fix_numeral_sound_changes("ハチヒャク"), "ハッピャク");
    assert_eq!(fix_numeral_sound_changes("サンセン"), "サンゼン");
    assert_eq!(fix_numeral_sound_changes("ハチセン"), "ハッセン");
}

#[test]
fn leaves_the_regular_readings_alone() {
    // The other seven hundreds and thousands do not change, and a rule that
    // rewrote them all would be wrong in a way that still sounds like counting.
    for unchanged in [
        "ヒャク",
        "ヨンヒャク",
        "ゴヒャク",
        "セン",
        "ヨンセン",
        "キュウセン",
    ] {
        assert_eq!(fix_numeral_sound_changes(unchanged), unchanged);
    }
}

// -------------------------------------------------------------- punctuation

#[test]
fn normalizes_full_width_punctuation() {
    assert_eq!(normalize_punctuation("こんにちは。"), "こんにちは.");
    assert_eq!(normalize_punctuation("「はい」"), "\"はい\"");
    assert_eq!(normalize_punctuation("ほんとう？"), "ほんとう?");
    assert_eq!(normalize_punctuation("  あ  "), "あ");
}

#[test]
fn turns_a_comma_into_a_period_and_an_enumeration_comma_into_a_comma() {
    // Not a typo: the comma-to-period rewrite was chosen by listening tests,
    // because Kokoro pauses differently after each.
    assert_eq!(
        normalize_punctuation("こんにちは，世界"),
        "こんにちは. 世界"
    );
    assert_eq!(normalize_punctuation("りんご、バナナ"), "りんご, バナナ");
}

#[test]
fn keeps_only_the_punctuation_kokoro_knows() {
    assert_eq!(keep_punctuation("!?,"), "!?,");
    assert_eq!(keep_punctuation("a, b"), ", ");
    assert_eq!(keep_punctuation("«»"), "");

    // Full-width marks are *not* in the set — `！` and `？` are U+FF01 and
    // U+FF1F, and Kokoro's vocabulary has the ASCII ones. They survive only
    // because `normalize_punctuation` rewrites them first, which is the order
    // `phonemize_ja` relies on.
    assert_eq!(keep_punctuation("、。！？"), "");
    assert_eq!(keep_punctuation("！"), "");
}

// ------------------------------------------------------------ script runs

#[test]
fn splits_text_into_script_runs() {
    let runs = segment_text("ひらがなとカタカナ");
    assert_eq!(runs.len(), 1);
    assert_eq!(runs[0], ScriptRun::Kana("ひらがなとカタカナ".to_string()));

    let runs = segment_text("こんにちは、せかい。");
    assert_eq!(
        runs,
        vec![
            ScriptRun::Kana("こんにちは".to_string()),
            ScriptRun::Other("、".to_string()),
            ScriptRun::Kana("せかい".to_string()),
            ScriptRun::Other("。".to_string()),
        ]
    );
}

#[test]
fn splits_latin_and_kanji_apart() {
    let runs = segment_text("APIを使う");
    let kinds: Vec<&ScriptRun> = runs.iter().collect();
    assert_eq!(kinds.len(), 4);
    assert_eq!(runs[0], ScriptRun::Latin("API".to_string()));
    assert_eq!(runs[1], ScriptRun::Kana("を".to_string()));
    assert_eq!(runs[2], ScriptRun::Han("使".to_string()));
    assert_eq!(runs[3], ScriptRun::Kana("う".to_string()));
}

#[test]
fn classifies_an_astral_kanji_as_other() {
    // `segmentText` tests `char.charCodeAt(0)` against `0x20000..=0x2ebef`, but
    // `charCodeAt(0)` on a character outside the BMP returns a surrogate — so
    // that branch is unreachable and an Extension B kanji falls through to
    // `other`. This pins the reachable behaviour, which is what parity requires;
    // the fix belongs on the JavaScript side, and phase 8.4 removes that side.
    let runs = segment_text("\u{20000}");
    assert_eq!(runs, vec![ScriptRun::Other("\u{20000}".to_string())]);
}

#[test]
fn collapses_whitespace_the_way_the_javascript_does() {
    assert_eq!(collapse_whitespace("a  b"), "a b");
    assert_eq!(collapse_whitespace("  a  "), "a");
    assert_eq!(collapse_whitespace("   "), "");
    assert_eq!(collapse_whitespace("a\n\tb"), "a b");
}
