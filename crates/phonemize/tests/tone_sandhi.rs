//! The Mandarin tone rules, one case per rule (P6 phase 9D).
//!
//! Every expectation here was checked against PaddleSpeech's own `ToneSandhi`
//! and `_merge_erhua` driven with `pypinyin` and jieba's `posseg` on the same
//! sentence, not derived by reading the Python. The method, and the three places
//! this port deliberately answers differently, are at the top of
//! `src/backends/tone_sandhi/mod.rs` and beside that module's `NOTICE`.
//!
//! What does **not** show up here is the reader. The rules only ever change a
//! tone, so a sentence whose *syllables* differ from the reference's is
//! `pinyin-pro` against `pypinyin` — 瓜子 is *guāzǐ* to one and *guāzi* to the
//! other, 看门 is *kānmén* to one and *kànmén* to the other — and no rule can fix
//! that here. The comparison found 13 such sentences in 466 and no rule
//! differences; the write-up has the list.
//!
//! The harness is the real pipeline: jieba's dictionary, `pinyin-pro`'s tables,
//! and [`tone_sandhi::plan`]. No hand-written tones, because the rules read the
//! words jieba found and the tags it gave them, and a hand-written input would
//! test the arithmetic and not the port.

mod common;

use std::io::Read;

use phonemize::g2p::zh::tone_sandhi::{self, Plan};
use phonemize::g2p::zh::SegmenterZh;
use phonemize::g2p::ChinesePinyin;

/// The real segmenter and the real syllable table, for a test that needs them.
///
/// `None` only when the caller asked to skip the dictionary tests by name; the
/// rule for that is in [`common`], and a missing dictionary without it is a
/// panic there rather than a skip here.
struct Harness {
    segmenter: SegmenterZh,
    chinese: ChinesePinyin,
}

fn harness() -> Option<Harness> {
    let compressed = common::jieba_dictionary_bytes()?;
    let mut decoder =
        ruzstd::decoding::StreamingDecoder::new(&compressed[..]).expect("a zstd frame");
    let mut dictionary = Vec::new();
    decoder
        .read_to_end(&mut dictionary)
        .expect("the frame decompresses");

    Some(Harness {
        segmenter: SegmenterZh::from_dictionary(&dictionary).expect("the dictionary loads"),
        chinese: ChinesePinyin::new(),
    })
}

impl Harness {
    /// Everything the rules decided, including where the words ended up.
    fn planned(&self, text: &str) -> Plan {
        let readings = self
            .chinese
            .complete_readings(text)
            .unwrap_or_else(|error| panic!("{text:?} reads: {error}"));
        let words = self
            .segmenter
            .tagged_words(text)
            .unwrap_or_else(|error| panic!("{text:?} segments: {error}"));

        tone_sandhi::plan(text, &words, &readings, &self.segmenter)
    }

    /// The syllables one run comes out with: `wanr2` for 玩儿.
    fn plan(&self, text: &str) -> Vec<String> {
        self.planned(text).syllables
    }

    /// The syllables of one run, joined, as one string per word.
    ///
    /// `words` is the spacing the tokenizer sees, and the tone rules decide it
    /// too — `_merge_bu` glues a 不 onto what follows it and `_merge_er` glues a
    /// 儿 onto what precedes it.
    fn words(&self, text: &str) -> Vec<String> {
        let plan = self.planned(text);
        let mut out = Vec::with_capacity(plan.word_lengths.len());
        let mut at = 0;
        for length in &plan.word_lengths {
            out.push(plan.syllables[at..at + length].concat());
            at += length;
        }
        out
    }
}

// --------------------------------------------------------- third-tone sandhi

#[test]
fn two_third_tones_make_the_first_a_second() {
    let Some(h) = harness() else { return };
    // The user's report, and the reason this phase exists.
    assert_eq!(h.plan("你好"), ["ni2", "hao3"]);
    assert_eq!(h.plan("你好世界"), ["ni2", "hao3", "shi4", "jie4"]);
}

#[test]
fn a_word_that_is_not_all_third_tones_is_left_alone() {
    let Some(h) = harness() else { return };
    // 小张 is 3 + 1: nothing to sandhi.
    assert_eq!(h.plan("小张"), ["xiao3", "zhang1"]);
}

#[test]
fn a_three_character_word_splits_before_it_is_sandhi_ed() {
    let Some(h) = harness() else { return };
    // 纸/老虎 — one syllable plus two: only the first of the second word's two
    // changes, so 老虎 becomes láohǔ and not *lǎohú*.
    assert_eq!(h.plan("纸老虎"), ["zhi3", "lao2", "hu3"]);
}

#[test]
fn a_three_character_word_splitting_the_other_way_changes_two() {
    let Some(h) = harness() else { return };
    // 蒙古/包 — two plus one: both of the first two change.
    assert_eq!(h.plan("蒙古包"), ["meng2", "gu3", "bao1"]);
}

#[test]
fn two_third_tone_words_are_merged_before_the_rule_runs() {
    let Some(h) = harness() else { return };
    // 我 很 好 is three words to jieba and three third tones, so the merge pass
    // glues all three into one and the three-character rule sees 我/很好.
    assert_eq!(h.plan("我很好"), ["wo3", "hen2", "hao3"]);
    assert_eq!(h.planned("我很好").word_lengths, [3]);
}

#[test]
fn a_third_tone_word_and_a_two_syllable_second_word_split_at_the_word() {
    let Some(h) = harness() else { return };
    // 所有 人: the first half is all third tone, so it loses its first tone —
    // *suóyǒu rén*, and the 人 is untouched.
    assert_eq!(
        h.plan("所有的人都来了"),
        ["suo2", "you3", "de0", "ren2", "dou1", "lai2", "le0"]
    );
}

#[test]
fn a_two_syllable_word_before_a_third_tone_changes_its_last_syllable() {
    let Some(h) = harness() else { return };
    // 好/喜欢: the boundary is two third tones, so 好 changes — *háo xǐhuan*.
    assert_eq!(h.plan("好喜欢"), ["hao2", "xi3", "huan0"]);
}

#[test]
fn a_four_character_word_is_two_halves_and_each_is_checked() {
    let Some(h) = harness() else { return };
    // 甲乙丙丁 is four, split in the middle, and only the first half is all
    // third tones.
    assert_eq!(h.plan("甲乙丙丁"), ["jia2", "yi3", "bing3", "ding1"]);
    // 百鸟朝凤: the first half is all third tones, the second is not.
    assert_eq!(h.plan("百鸟朝凤"), ["bai2", "niao3", "chao2", "feng4"]);
}

#[test]
fn a_three_character_word_of_three_third_tones_changes_the_first_two() {
    let Some(h) = harness() else { return };
    // 展览馆 is one word to jieba, and jieba's search mode splits it 展览/馆
    // (two + one), so the first two change — *zhánlán guǎn*.
    assert_eq!(h.plan("展览馆"), ["zhan2", "lan2", "guan3"]);
    // 小雨伞 splits 小/雨伞 — one plus two — and only the middle changes.
    assert_eq!(h.plan("小雨伞"), ["xiao3", "yu2", "san3"]);
}

// ------------------------------------------------------------------ 一 and 不

#[test]
fn yi_before_a_fourth_tone_takes_the_second() {
    let Some(h) = harness() else { return };
    assert_eq!(h.plan("一个"), ["yi2", "ge5"]);
    assert_eq!(h.plan("一次"), ["yi2", "ci4"]);
    assert_eq!(h.plan("一件"), ["yi2", "jian4"]);
    assert_eq!(h.plan("一样"), ["yi2", "yang4"]);
    assert_eq!(h.plan("一定"), ["yi2", "ding4"]);
}

#[test]
fn yi_before_anything_else_takes_the_fourth() {
    let Some(h) = harness() else { return };
    assert_eq!(h.plan("一天"), ["yi4", "tian1"]);
}

#[test]
fn yi_between_two_copies_of_a_verb_is_neutral() {
    let Some(h) = harness() else { return };
    assert_eq!(h.plan("看一看"), ["kan4", "yi0", "kan4"]);
    assert_eq!(h.plan("听一听"), ["ting1", "yi0", "ting1"]);
    assert_eq!(h.plan("说一说"), ["shuo1", "yi0", "shuo1"]);
}

#[test]
fn a_run_of_numerals_keeps_the_first_tone() {
    let Some(h) = harness() else { return };
    // 一二三: the guard is on every other *character* of the word being a
    // numeral, and 一 is excluded from the test.
    assert_eq!(h.plan("一二三"), ["yi1", "er4", "san1"]);
    // 一百二十三 is a numeral too and takes the guard, which means the G2P's own
    // answer stands: 一 before 百 is the fourth tone, as it is in 一天.
    assert_eq!(h.plan("一百二十三"), ["yi4", "bai3", "er4", "shi2", "san1"]);
}

#[test]
fn di_yi_is_an_ordinal_and_the_yi_is_a_first_tone() {
    let Some(h) = harness() else { return };
    assert_eq!(h.plan("第一"), ["di4", "yi1"]);
    assert_eq!(h.plan("第一千"), ["di4", "yi1", "qian1"]);
}

#[test]
fn bu_before_a_fourth_tone_takes_the_second() {
    let Some(h) = harness() else { return };
    assert_eq!(h.plan("不对"), ["bu2", "dui4"]);
    assert_eq!(h.plan("不怕"), ["bu2", "pa4"]);
}

#[test]
fn bu_before_anything_else_does_not_move() {
    let Some(h) = harness() else { return };
    assert_eq!(h.plan("不好"), ["bu4", "hao3"]);
}

#[test]
fn bu_inside_a_verb_complement_goes_neutral() {
    let Some(h) = harness() else { return };
    // 看不懂, 对不起, 差不多: the 不 is a V不V infix, and the reference's first
    // branch makes it neutral before the follower's tone is even looked at.
    assert_eq!(h.plan("看不懂"), ["kan4", "bu5", "dong3"]);
    assert_eq!(h.plan("看不见"), ["kan4", "bu5", "jian4"]);
    assert_eq!(h.plan("对不起"), ["dui4", "bu5", "qi3"]);
    assert_eq!(h.plan("差不多"), ["cha4", "bu5", "duo1"]);
}

// --------------------------------------------------------------- neutral tone

#[test]
fn a_reduplicated_syllable_is_neutral() {
    let Some(h) = harness() else { return };
    // 妈妈 and 爸爸 are in the G2P's dictionary already; 说说 is not, and is what
    // the rule is for.
    assert_eq!(h.plan("妈妈"), ["ma1", "ma0"]);
    assert_eq!(h.plan("爸爸"), ["ba4", "ba0"]);
    assert_eq!(h.plan("哥哥"), ["ge1", "ge0"]);
}

#[test]
fn an_adverb_that_looks_reduplicated_is_not() {
    let Some(h) = harness() else { return };
    // 渐渐 jian4 jian4 — the rule asks for a noun, verb or adjective tag, and
    // this one is an adverb. It is the case that would break if the tag were
    // dropped.
    assert_eq!(h.plan("渐渐"), ["jian4", "jian4"]);
}

#[test]
fn the_words_that_look_neutral_and_are_not_are_left_alone() {
    let Some(h) = harness() else { return };
    // 人人 and 想想 are in `must_not_neural_tone_words`, which is the exception
    // list for the reduplication rule above.
    assert_eq!(h.plan("人人"), ["ren2", "ren2"]);
    assert_eq!(h.plan("想想"), ["xiang2", "xiang3"]);
}

#[test]
fn a_word_from_the_neutral_tone_list_loses_its_last_tone() {
    let Some(h) = harness() else { return };
    // The list is ~420 words whose last syllable is conventionally neutral, and
    // this is what it is for: `pinyin-pro` reads 朋友 as péngyǒu and the rule
    // makes it péngyou.
    assert_eq!(h.plan("朋友"), ["peng2", "you5"]);
    assert_eq!(h.plan("眼睛"), ["yan3", "jing5"]);
    assert_eq!(h.plan("明白"), ["ming2", "bai5"]);
    assert_eq!(h.plan("东西"), ["dong1", "xi5"]);
    assert_eq!(h.plan("太阳"), ["tai4", "yang5"]);
    assert_eq!(h.plan("姑娘"), ["gu1", "niang5"]);
    // 休息 is in the list and needs no rule: `pinyin-pro` has 息 neutral already,
    // so it arrives as `xi0` and is echoed back unchanged.
    assert_eq!(h.plan("休息"), ["xiu1", "xi0"]);
}

#[test]
fn a_neutral_tone_that_the_g2p_already_knew_is_echoed_unchanged() {
    let Some(h) = harness() else { return };
    // 我们, 孩子, 什么: `pinyin-pro` writes the neutral tone `0` and this module
    // numbers it `5`, and a reading no rule touched comes back in the spelling it
    // arrived in — which is why the digit here is `0` and not `5`. A changed one
    // is written with `5`. Both are the same syllable to the table.
    assert_eq!(h.plan("我们"), ["wo3", "men0"]);
    assert_eq!(h.plan("孩子"), ["hai2", "zi0"]);
    assert_eq!(h.plan("什么"), ["shen2", "me0"]);
}

#[test]
fn a_measure_word_ge_is_neutral() {
    let Some(h) = harness() else { return };
    // 一个, 两个, 一个个 — the character before 个 has to be a numeral or one of
    // a short list, which is why 这个 does not qualify.
    assert_eq!(h.plan("两个"), ["liang3", "ge5"]);
    assert_eq!(h.plan("一个个"), ["yi2", "ge5", "ge4"]);
}

#[test]
fn directional_complements_are_neutral() {
    let Some(h) = harness() else { return };
    // 上来, 下去, 起来: 来/去 after 上/下/进/出/回/过/起/开 is a complement.
    assert_eq!(h.plan("上来"), ["shang4", "lai5"]);
    assert_eq!(h.plan("下去"), ["xia4", "qu5"]);
    assert_eq!(h.plan("起来"), ["qi3", "lai5"]);
    // And 去过 is not: 过 after 去 is an aspect marker with its own rule, which
    // wants the tag `ug` and not the `vq` jieba gives it.
    assert_eq!(h.plan("去过"), ["qu4", "guo4"]);
}

#[test]
fn a_localizer_is_neutral() {
    let Some(h) = harness() else { return };
    assert_eq!(h.plan("桌上"), ["zhuo1", "shang5"]);
    assert_eq!(h.plan("地下"), ["di4", "xia5"]);
}

#[test]
fn an_aspect_marker_that_is_its_own_word_is_neutral() {
    let Some(h) = harness() else { return };
    // 走了 is two words, not one: 了 is its own word and its own tag.
    assert_eq!(h.plan("走了"), ["zou3", "le0"]);
    assert_eq!(h.planned("走了").word_lengths, [1, 1]);
}

#[test]
fn a_word_list_entry_matches_the_end_of_a_longer_word() {
    let Some(h) = harness() else { return };
    // The list is asked about the word and about its last two characters, and
    // `_split_word`'s halves are asked about separately: 高高兴兴 is two
    // reduplications and both halves go neutral.
    assert_eq!(h.plan("高高兴兴"), ["gao1", "gao5", "xing4", "xing5"]);
}

// ---------------------------------------------------------------- erhua coda

#[test]
fn an_er_at_the_end_of_a_word_is_a_coda() {
    let Some(h) = harness() else { return };
    // 玩儿 — the user's second report. One syllable, and the reference spells it
    // `w` + `uanr2`, so the syllable keeps its final and gains the coda.
    assert_eq!(h.plan("玩儿"), ["wanr2"]);
    assert_eq!(h.planned("玩儿").word_lengths, [1]);
}

#[test]
fn the_er_that_becomes_a_coda_need_not_be_its_own_word() {
    let Some(h) = harness() else { return };
    // 门儿 is one word to jieba and 玩儿一会儿 is two: the merge pass is what
    // makes them the same case.
    assert_eq!(h.plan("门儿"), ["menr2"]);
    assert_eq!(h.plan("玩儿一会儿"), ["wanr2", "yi2", "huir4"]);
    assert_eq!(h.planned("玩儿一会儿").word_lengths, [1, 2]);
}

#[test]
fn the_coda_sits_before_the_tone_of_the_syllable_it_joins() {
    let Some(h) = harness() else { return };
    // 一点儿: the 一 is a fourth tone before 点 (third), and the coda carries
    // 点's own tone — which the third-tone rule has not raised, because 点 is
    // followed by 儿 and the word is two syllables of 4 + 3.
    assert_eq!(h.plan("一点儿"), ["yi4", "dianr3"]);
    assert_eq!(h.plan("一会儿"), ["yi2", "huir4"]);
}

#[test]
fn the_coda_keeps_the_final_it_was_added_to() {
    let Some(h) = harness() else { return };
    // 没事儿 is shì + r, so the coda goes on the final `iii` and comes out as the
    // syllable `shir`; the same for 瓜子儿 and 慢慢儿. What the tables say about
    // which syllable each of those characters reads is the G2P's business —
    // 瓜子 is *guāzǐ* here and *guāzi* to `pypinyin` — and the coda is this
    // module's.
    assert_eq!(h.plan("没事儿"), ["mei2", "shir4"]);
    assert_eq!(h.plan("慢慢儿"), ["man4", "manr4"]);
    assert_eq!(h.plan("一块儿"), ["yi2", "kuair4"]);
}

#[test]
fn a_word_jieba_sees_as_one_word_erhuas_the_same_way() {
    let Some(h) = harness() else { return };
    // 胡同儿 and 小院儿 are dictionary words and one of them is a name to jieba —
    // which does not matter, because the reference's own list overrides the part
    // of speech.
    assert_eq!(h.plan("胡同儿"), ["hu2", "tongr5"]);
    assert_eq!(h.plan("小院儿"), ["xiao3", "yuanr4"]);
}

#[test]
fn an_er_that_is_a_syllable_is_not_a_coda() {
    let Some(h) = harness() else { return };
    // 女儿, 花儿, 鸟儿: the 儿 is the word's own syllable, and the reference has
    // a list of words that say so. 女儿国 is the same 儿 in a longer word.
    assert_eq!(h.plan("女儿"), ["nü3", "er2"]);
    assert_eq!(h.plan("花儿"), ["hua1", "er2"]);
    assert_eq!(h.plan("鸟儿"), ["niao3", "er2"]);
    assert_eq!(h.plan("女儿国"), ["nü3", "er2", "guo2"]);
}

#[test]
fn a_name_is_not_erhua() {
    let Some(h) = harness() else { return };
    // 小雨儿 is tagged `nr` — a name — and the reference declines to erhua a
    // name. The 儿 stays a syllable, so this is one syllable longer than 玩儿.
    assert_eq!(h.plan("小雨儿"), ["xiao2", "yu3", "er2"]);
    assert_eq!(h.planned("小雨儿").word_lengths, [3]);
}

#[test]
fn an_er_inside_a_word_is_untouched() {
    let Some(h) = harness() else { return };
    // 正儿八经: the coda rule is about a word's *last* character.
    assert_eq!(h.plan("正儿八经"), ["zheng4", "er0", "ba1", "jing1"]);
}

#[test]
fn an_er_read_with_the_first_tone_becomes_a_second_tone() {
    let Some(h) = harness() else { return };
    // The reference corrects `er1` to `er2` before it decides anything else, so a
    // word whose 儿 `pypinyin` reads first-tone erhuas anyway. `pinyin-pro` reads
    // 儿 with the second tone, so the correction never fires on this side — this
    // pins that it is a no-op here and not a missing branch.
    assert_eq!(h.plan("儿子"), ["er2", "zi0"]);
}

// ------------------------------------------------------- merging and spacing

#[test]
fn a_lone_bu_is_glued_onto_what_follows_it() {
    let Some(h) = harness() else { return };
    // 不 often comes out of jieba as its own word, and a 不 with no follower can
    // never take the sandhi the follower decides. The merge is why 不怕 works,
    // and it is also why 不做 is one word in the spacing.
    assert_eq!(h.words("不怕"), ["bu2pa4"]);
    assert_eq!(h.words("不做"), ["bu2zuo4"]);
}

#[test]
fn a_lone_yi_is_glued_onto_what_follows_it() {
    let Some(h) = harness() else { return };
    // The reference's second 一 merge. It changes the spacing and not the tone:
    // 一四 is still a first tone, because the word is all numerals and takes the
    // numeric guard.
    assert_eq!(h.words("一四"), ["yi1si4"]);
    assert_eq!(h.plan("一四"), ["yi1", "si4"]);
}

#[test]
fn yi_between_two_copies_of_a_verb_joins_them() {
    let Some(h) = harness() else { return };
    // 听 一 听 is three words to jieba, and the reference glues all three so that
    // the 一 can be neutral.
    assert_eq!(h.words("看一看"), ["kan4yi0kan4"]);
    assert_eq!(h.planned("看一看").word_lengths, [3]);
}

#[test]
fn repeated_words_are_glued_before_the_rules_run() {
    let Some(h) = harness() else { return };
    // 说 说 is two words, and a one-character word is not a reduplication until
    // the merge pass has made it one.
    assert_eq!(h.words("说说"), ["shuo1shuo5"]);
}

#[test]
fn the_merged_words_still_cover_the_run() {
    let Some(h) = harness() else { return };
    // The spans the rules carry are offsets into the run, and a merge that did
    // not land on an adjacent word would produce a word that is not a slice of
    // anything. Checked on sentences with the merges in them.
    for text in [
        "听一听才知道他来了没有",
        "银行行长不知道",
        "玩儿一会儿再说",
        "我们中出了一个叛徒",
    ] {
        let plan = h.planned(text);
        assert_eq!(
            plan.word_lengths.iter().sum::<usize>(),
            plan.syllables.len(),
            "{text:?}: the words do not cover the syllables"
        );
        assert!(
            plan.word_lengths.iter().all(|length| *length > 0),
            "{text:?}: an empty word"
        );
        assert!(
            plan.syllables.len() <= text.chars().count(),
            "{text:?}: erhua can only remove syllables"
        );
    }
}

// ------------------------------------------- where this port answers differently

#[test]
fn a_sandhi_the_g2p_declined_is_still_applied() {
    let Some(h) = harness() else { return };
    // **Deviation 1.** `pinyin-pro` runs these same two rules inside its G2P and
    // carries `toneSandhiIgnoreSuffix`, a list of followers it declines on —
    // 一的, 一是, 一而, 一之, 一后, 一也, 一还. This port applies `_yi_sandhi` as
    // written, so the tone is re-derived from the follower and those seven
    // exceptions are lost: *yí shì* where the G2P says *yī shì*.
    assert_eq!(h.plan("一的"), ["yi2", "de0"]);
    assert_eq!(h.plan("一是"), ["yi2", "shi4"]);
    assert_eq!(h.plan("一也"), ["yi4", "ye3"]);
}

#[test]
fn the_erhua_coda_keeps_the_final_it_joins() {
    let Some(h) = harness() else { return };
    // **Deviation 2**, and it is the reference that this keeps: PaddleSpeech
    // appends `r` to the pypinyin final and keeps everything before it, so 玩儿
    // is `wanr` and not `war`. The task that asked for this phase described the
    // rule as `an + 儿 → ar`, which is how the sound comes out ([waɻ]) and not
    // what the reference does. See the module docs.
    assert_eq!(h.plan("玩儿"), ["wanr2"]);
    assert_ne!(h.plan("玩儿")[0], "war2");
}

#[test]
fn a_repeat_across_a_sub_word_boundary_is_not_a_reduplication() {
    let Some(h) = harness() else { return };
    // **Deviation 3.** 银行行长 is one word to jieba and 银行/行长 to jieba's
    // search mode, so the 行 of 银行 is followed by the 行 of 行长 and the
    // reference's "two identical characters" test fires: it reads the word
    // *yín háng hang zhǎng*. A repeat that straddles a sub-word boundary is not a
    // syllable said twice, so this port declines. The syllables are the same
    // either way — only the arrow differs — which is why the case is worth a test
    // rather than a panic: it is a wrong reading, not a lost word.
    assert_eq!(h.plan("银行行长"), ["yin2", "hang2", "hang2", "zhang3"]);
    // And a repeat that does not straddle a boundary still fires.
    assert_eq!(h.plan("妈妈"), ["ma1", "ma0"]);
    assert_eq!(h.plan("高高兴兴"), ["gao1", "gao5", "xing4", "xing5"]);
}

#[test]
fn a_word_the_dictionary_does_not_have_is_tagged_other() {
    let Some(h) = harness() else { return };
    // The tags come from jieba's word list, and the HMM that would guess one for
    // a word outside it is not in this build (`Cargo.toml`), so 人设 is `x` here
    // and `n` to Python jieba's `posseg`. Nothing is read wrong — a rule that
    // checks the tag declines — and the tones are the ones the G2P gave.
    let words = h.segmenter.tagged_words("人设曾经").expect("segments");
    assert_eq!(words[0].tag, "x");
    assert_eq!(h.plan("人设"), ["ren2", "she4"]);
}

#[test]
fn an_erhua_coda_on_a_diaeresis_final_resolves() {
    let Some(h) = harness() else { return };
    // The syllable table spells `ü` as `v` (pypinyin's toneless form) and the coda
    // is written *after* the syllable, so the `r` has to come off before the
    // translation or the key would be `lyr`. 驴儿 and 绿叶儿 are the two shapes a
    // coda on a `ü` can take, and neither is a name to jieba — which is what
    // keeps 小鱼儿 (tagged `nr`) and 小曲儿 out of this test: a name is not erhua
    // at all. `tests/pinyin.rs` pins the IPA that `lür2` resolves to.
    assert_eq!(h.plan("驴儿"), ["lür2"]);
    assert_eq!(h.plan("绿叶儿"), ["lü4", "yer4"]);
}
