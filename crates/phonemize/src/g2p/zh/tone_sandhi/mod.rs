//! Mandarin tone sandhi and the erhua coda, ported from PaddleSpeech.
//!
//! # What this is
//!
//! Mandarin does not read a character's tone as the dictionary gives it. Two
//! third tones in a row turn the first one into a second (`你好` is *ní hǎo*,
//! not *nǐ hǎo*); 一 and 不 take their tone from what follows them; many word
//! endings are neutral; and the 儿 in a word like 玩儿 is not a syllable at all
//! but a coda on the one before it (`wánr`, one syllable, not `wán ér`). None of
//! that is in the readings `pinyin-pro` produces — it is a *rule layer* over
//! them, and this module is that layer.
//!
//! The rules are [`ToneSandhi`] from PaddleSpeech's `tone_sandhi.py` plus
//! [`ZHFrontend::_merge_erhua`] from its `zh_frontend.py` (Apache-2.0; see
//! `NOTICE` beside this file). They port cleanly because they are pure string
//! rules over tones, word shapes and jieba's part-of-speech tags, with no model
//! and no dictionary of their own.
//!
//! [`ToneSandhi`]: https://github.com/PaddlePaddle/PaddleSpeech/blob/develop/paddlespeech/t2s/frontend/tone_sandhi.py
//! [`ZHFrontend::_merge_erhua`]: https://github.com/PaddlePaddle/PaddleSpeech/blob/develop/paddlespeech/t2s/frontend/zh_frontend.py
//!
//! # Where it sits
//!
//! ```text
//!     数字 → 标点 → 分行 → jieba 分词 → pinyin-pro 读音 → **这一层** → 音节表 → 闸门
//! ```
//!
//! It reads the readings one character at a time and writes back one *syllable*
//! per character that still has one, in the spelling
//! [`ChinesePinyin::syllable_to_ipa`](crate::g2p::zh::pinyin::ChinesePinyin::syllable_to_ipa)
//! takes: `ni2`, and `wanr2` when the character carries the erhua coda. So it
//! changes two things and only two: the tone digit, and whether an `r` sits
//! before it. Everything else — which character reads which syllable, and where
//! the words break — is decided elsewhere and passed through.
//!
//! It runs **before** the syllable table, so a syllable no table can read is
//! still reported by the table rather than here; and before the vocabulary gate,
//! because the gate is about characters and this is about digits.
//!
//! # The four rule groups
//!
//! 1. **三声连读** (`_three_sandhi`) — two third tones: the first becomes a
//!    second. Long words are split first (`_split_word`, jieba's search mode) so
//!    that 纸老虎 is 纸/老虎 and 所有/人 is the boundary that changes a tone.
//! 2. **一/不** (`_yi_sandhi`, `_bu_sandhi`) — before a fourth (or, for 一, a
//!    neutral) tone 一 and 不 take the second; before anything else 一 takes the
//!    fourth. `V不V` (`看不懂`, `对不起`) makes the 不 neutral. A run of numerals
//!    is left alone.
//! 3. **轻声** (`_neural_sandhi`) — particles, 的/地/得, the suffixes 们/子 and
//!    the localizers 上/下/来/去, a reduplicated syllable (`妈妈` → *mā ma*), 个
//!    as a measure word, and the 417 words in `tables.rs` whose last syllable is
//!    conventionally neutral.
//! 4. **儿化音** (`_merge_erhua`) — see below.
//!
//! # Merging first, and why it is not optional
//!
//! `tone_sandhi.py` does not apply those rules to jieba's words as they come out:
//! it first runs `pre_merge_for_modify`, which glues words together so that the
//! sandhi sees the unit the sandhi is about — 听说 as one word, a lone 不 onto
//! what follows it, 一 between two copies of a verb, adjacent words that are all
//! third tone, and 儿 onto the word before it. A lone 不 that jieba split off
//! would otherwise be read with no follower and never take the second tone. This
//! port keeps that pass, and keeps the *merged* words as the words whose spacing
//! reaches the tokenizer, because that is what the reference does.
//!
//! # Three deviations from the reference, all deliberate
//!
//! Each is one line of reasoning and one test, and they are the only three places
//! a difference from PaddleSpeech is not the reader's fault. The 466-sentence
//! comparison against PaddleSpeech found no
//! others.
//!
//! 1. **一/不 are applied as written, so `pinyin-pro`'s exception list is lost.**
//!    The G2P runs these same two rules and carries `toneSandhiIgnoreSuffix` —
//!    seven followers it declines on (一的, 一是, 一而, 一之, 一后, 一也, 一还, and
//!    the 不 forms). Re-deriving the tone from the follower overrides them: 一是
//!    becomes *yí shì* where the G2P said *yī shì*. Both readings are attested
//!    (the exception is for the enumerated, stressed 一 of 一是…二是…), the
//!    difference is one tone arrow, and a rule layer that quietly declines on
//!    seven words is a harder thing to find than one that does not.
//!    `a_sandhi_the_g2p_declined_is_still_applied`.
//! 2. **The erhua coda keeps the final it joins.** PaddleSpeech appends `r` to
//!    the pypinyin final and keeps everything before it, so 玩儿 is `w` +
//!    `uanr2` — *wánr*, not `war`. The phonological description of the *sound* is
//!    `an + 儿 → ar` (\[waɻ\], the n lost into the nasalized vowel), and that is
//!    not what the reference does; a port that dropped the coda would be
//!    inventing a rule. The coda is
//!    also not the whole story for v1.1-zh, whose frontend writes a separate `R`
//!    phoneme instead (`misaki/zh_frontend.py`); see the note in
//!    `pinyin.rs::syllable_to_ipa` for what that means for a future port.
//!    `the_erhua_coda_keeps_the_final_it_joins`.
//! 3. **A repeat that straddles a sub-word boundary is not a reduplication.**
//!    `_neural_sandhi` neutralizes the second of two identical characters, and
//!    that is not the same question as whether a syllable was said twice: 银行行长
//!    is one word to jieba, so the 行 of 银行 is followed by the 行 of 行长 and the
//!    reference reads it *yín háng **hang** zhǎng*. See
//!    `neural_sandhi` for the guard, and for the two-character word that has to
//!    stay an exception. `a_repeat_across_a_sub_word_boundary_is_not_a_reduplication`.
//!
//! # What it does not do
//!
//! - **No phrase dictionary.** The reference's readings come from `pypinyin` with
//!   `large_pinyin` (411,957 entries). Ours come from `pinyin-pro`, and this
//!   module never changes *which* syllable a character reads — only its tone. So
//!   where the two engines' dictionaries disagree the tones differ too, and that
//!   is a property of the G2P, not of this layer.
//! - **No reading of a merged word.** The reference recomputes `lazy_pinyin` of
//!   each word while merging, so a merge can change a reading; here the
//!   per-character tones are fixed before the merge, which is the same thing
//!   unless a phrase rule would span the seam.
//! - **No HMM part-of-speech tagging.** See
//!   [`SegmenterZh::tagged_words`](crate::g2p::zh::segmenter::SegmenterZh::tagged_words):
//!   tags come from jieba's dictionary and a word outside it is `x`.
//! - **No tone for a syllable the rules never touch.** An unchanged reading is
//!   echoed back exactly as `pinyin-pro` wrote it, so this layer cannot change the
//!   name a later error message uses.
//!
//! # Verified against the reference
//!
//! Not against a reading of it. `ToneSandhi` was imported from the PaddleSpeech
//! checkout and driven with `pypinyin` and jieba's own `posseg` on the same
//! sentences (`/tmp/oracle/oracle.py`), and the differences were
//! triaged one at a time: every one is either a reading difference between
//! `pypinyin` and `pinyin-pro` or an OOV tag.

mod tables;

use tables::{MUST_ERHUA, MUST_NEURAL_TONE_WORDS, MUST_NOT_NEURAL_TONE_WORDS, NOT_ERHUA};

use crate::g2p::zh::pinyin::Syllable;
use crate::g2p::zh::segmenter::{SegmenterZh, TaggedWord};

/// The neutral tone, in the numbering these rules are written against.
///
/// `pinyin-pro` numbers the neutral tone `0` and marks "no tone at all" by
/// leaving the digit off; `tone_sandhi.py` is written against `pypinyin`'s
/// `neutral_tone_with_five=True`, where the neutral tone is `5`. Both spellings
/// mean the same thing here.
const NEUTRAL: u8 = 5;

/// The third tone, which is the one the sandhi is about.
const THIRD: u8 = 3;

/// Word endings that are neutral: the sentence-final particles.
///
/// `tone_sandhi.py`'s `"吧呢啊呐噻嘛吖嗨呐哦哒滴哩哟喽啰耶喔诶"`, in its order.
const PARTICLES: &str = "吧呢啊呐噻嘛吖嗨呐哦哒滴哩哟喽啰耶喔诶";

/// 的/地/得 as a word ending, which are structural rather than lexical.
const STRUCTURAL: &str = "的地得";

/// 了/着/过 as a word of their own, which are aspect markers.
const ASPECT: &str = "了着过";

/// 们/子 as a word ending on a pronoun or a noun.
const NOUN_SUFFIXES: &str = "们子";

/// 上/下 as a word ending on a localizer.
const LOCALIZERS: &str = "上下";

/// 来/去 as a word ending after a directional verb.
const DIRECTIONALS: &str = "来去";

/// The verbs 来/去 are neutral *after*: `上来`, `下去`, `起来`, `回过`.
const DIRECTIONAL_STEMS: &str = "上下进出回过起开";

/// What may precede 个 for it to be a neutral measure word.
const MEASURE_PREFIXES: &str = "几有两半多各整每做是";

/// The punctuation `_yi_sandhi` refuses to change a tone across.
///
/// Dead code in this pipeline — a Han run has no punctuation in it, the runs are
/// split at every mark — and kept because the rule it guards is the reference's.
const PUNCTUATION: &str = "、：，；。？！“”‘’':,;.?!";

/// The Han characters `str.isnumeric()` is true for, which Rust's
/// [`char::is_numeric`] is *not*.
///
/// `_yi_sandhi` leaves 一 alone when every other character of its word is
/// numeric, so that a run of numerals read digit by digit (一零零) keeps the
/// first tone. Python's test is `'一'.isnumeric()`, which is true — CJK
/// ideographs carry `Numeric_Type=Numeric` — while Rust's
/// [`char::is_numeric`] asks the *general category* (Nd, Nl, No) and a Han
/// numeral is `Lo`. So the property is spelled out here: every character in the
/// Han runs of `zh_text` whose `Numeric_Type` is not `None`, in code point order.
const HAN_NUMERALS: &str = "〇㐅㒃㠪㭍一七万三两九二五亖京亿什仟仨伍佰俩倆億兆兩八六十千卄卅卌叁参參叄四壱壹幺廾廿弌弍弎弐拐拾捌柒洞漆玖百皕秭肆萬貮貳贰鈎钩阡陆陌陸零參拾兩零六陸什";

/// What the tone rules decided, in the form the syllable table can read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Plan {
    /// One syllable per character that still has one, in order.
    ///
    /// Spelled the way [`Syllable`] is — `ni2` — with the tone the rules left,
    /// and `r` before the digit when the character carries the erhua coda
    /// (`wanr2`). An 儿 that merged into the syllable before it has no entry of
    /// its own, so this can be shorter than the run it came from.
    pub syllables: Vec<String>,
    /// How many syllables each word has, in order.
    ///
    /// The words are jieba's after the merges the rules need, and one of them is
    /// one syllable shorter when erhua merged two into one. Sums to
    /// `syllables.len()`.
    pub word_lengths: Vec<usize>,
}

/// Decide the tone of every syllable in one Han run.
///
/// `text` is the run, `words` is jieba's segmentation of it with tags
/// ([`SegmenterZh::tagged_words`]), `readings` is one `pinyin-pro` reading per
/// character ([`ChinesePinyin::complete_readings`]), and `segmenter` is the same
/// segmenter the words came from — the rules ask it where jieba's search mode
/// would break a word in two.
///
/// # Preconditions
///
/// `text` has no character without a reading, and `readings.len()` is the number
/// of characters in `text`. The pipeline checks both before calling (a character
/// `pinyin-pro` cannot read is an error there, not a syllable dropped here), and
/// a violation is a programming error rather than a bad sentence — so it is a
/// `debug_assert` and not a `Result`.
///
/// # Order
///
/// The rule groups run in `modified_tone`'s order — 不/一, then the neutral tone,
/// then the third-tone rules — and that order is load-bearing rather than tidy:
/// the third-tone rules read the tones the earlier two left behind.
///
/// [`ChinesePinyin::complete_readings`]: crate::g2p::zh::pinyin::ChinesePinyin::complete_readings
pub fn plan<'a>(
    text: &str,
    words: &[TaggedWord<'a>],
    readings: &[Syllable],
    segmenter: &SegmenterZh,
) -> Plan {
    let characters: Vec<char> = text.chars().collect();
    debug_assert_eq!(
        characters.len(),
        readings.len(),
        "one reading per character of {text:?}"
    );

    let mut tones: Vec<u8> = readings.iter().map(tone_of).collect();
    let spans = pre_merge(&characters, words, &tones);

    for span in &spans {
        modified_tone(&characters, span, &mut tones, segmenter);
    }

    let mut syllables = Vec::with_capacity(characters.len());
    let mut word_lengths = Vec::with_capacity(spans.len());
    for span in &spans {
        let (coda, merged) = merge_erhua(&characters, span, &mut tones, readings);
        for index in span.start..span.start + span.length {
            if Some(index) == merged {
                continue;
            }
            syllables.push(spell(&readings[index], tones[index], Some(index) == coda));
        }
        word_lengths.push(span.length - usize::from(merged.is_some()));
    }

    Plan {
        syllables,
        word_lengths,
    }
}

// --------------------------------------------------------------- the pipeline

/// One word of the segmentation the rules work on: where it starts, how long it
/// is, and jieba's tag.
///
/// A span, rather than the word's text, because every rule that looks at a word
/// is looking at *characters*: the tones are one per character, and the rules
/// index them with the positions they found in the word.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Span<'a> {
    start: usize,
    length: usize,
    tag: &'a str,
}

impl Span<'_> {
    /// The characters of this word, as the rules see it.
    fn word<'a>(&self, characters: &'a [char]) -> &'a [char] {
        &characters[self.start..self.start + self.length]
    }

    /// The tones of this word, mutably when a rule is about to change one.
    fn tones<'a>(&self, tones: &'a [u8]) -> &'a [u8] {
        &tones[self.start..self.start + self.length]
    }
}

/// `tone_sandhi.py`'s `pre_merge_for_modify`, in its order.
///
/// Six passes, and the order matters: 不 and 一 are glued on first so that the
/// third-tone passes see the words the sandhi is actually about, and 儿 is glued
/// on last so that a word the earlier passes built is the one erhua inspects.
fn pre_merge<'a>(characters: &[char], words: &[TaggedWord<'a>], tones: &[u8]) -> Vec<Span<'a>> {
    let mut spans: Vec<Span<'a>> = Vec::with_capacity(words.len());
    let mut start = 0;
    for word in words {
        spans.push(Span {
            start,
            length: word.length,
            tag: word.tag,
        });
        start += word.length;
    }

    let spans = merge_bu(characters, &spans);
    let spans = merge_yi(characters, &spans);
    let spans = merge_reduplication(characters, &spans);
    let spans = merge_all_third_tones(characters, &spans, tones);
    let spans = merge_boundary_third_tones(characters, &spans, tones);
    merge_er(characters, &spans)
}

/// `_merge_bu`: 不 belongs to whatever follows it.
///
/// `不` is often its own word to jieba, and a 不 with no follower cannot take the
/// sandhi the follower decides. A trailing 不 has nothing to join, and gets the
/// adverb tag the reference gives it.
fn merge_bu<'a>(characters: &[char], spans: &[Span<'a>]) -> Vec<Span<'a>> {
    let mut out: Vec<Span<'a>> = Vec::with_capacity(spans.len());
    let mut pending: Option<Span<'a>> = None;

    for span in spans {
        if let Some(bu) = pending.take() {
            // The follower's tag, as in the reference: the merged word is read
            // as the word the 不 modifies.
            out.push(Span {
                start: bu.start,
                length: bu.length + span.length,
                tag: span.tag,
            });
            continue;
        }
        if is_word(span, characters, '不') {
            pending = Some(*span);
        } else {
            out.push(*span);
        }
    }

    if let Some(bu) = pending {
        out.push(Span { tag: "d", ..bu });
    }
    out
}

/// `_merge_yi`: the 一 of `听一听` and the 一 of `一看`.
///
/// Two passes. The first glues `V 一 V` into one word — the reference also asks
/// whether the first V is tagged `v`, which this keeps — and the second glues a
/// following word onto a word that is exactly 一.
fn merge_yi<'a>(characters: &[char], spans: &[Span<'a>]) -> Vec<Span<'a>> {
    let mut out: Vec<Span<'a>> = Vec::with_capacity(spans.len());
    let mut skip_next = false;

    for (index, span) in spans.iter().enumerate() {
        if skip_next {
            skip_next = false;
            continue;
        }
        let reduplication = index > 0
            && index + 1 < spans.len()
            && is_word(span, characters, '一')
            && same_word(&spans[index - 1], &spans[index + 1], characters)
            && spans[index - 1].tag == "v";
        if reduplication {
            let merged = out.last_mut().expect("the word before a 一");
            merged.length += 1 + spans[index + 1].length;
            skip_next = true;
        } else {
            out.push(*span);
        }
    }

    let mut glued: Vec<Span<'a>> = Vec::with_capacity(out.len());
    for span in &out {
        if glued
            .last()
            .is_some_and(|last| is_word(last, characters, '一'))
        {
            let merged = glued.last_mut().expect("checked");
            merged.length += span.length;
        } else {
            glued.push(*span);
        }
    }
    glued
}

/// `_merge_reduplication`: `妈妈` written as two words is one word.
fn merge_reduplication<'a>(characters: &[char], spans: &[Span<'a>]) -> Vec<Span<'a>> {
    let mut out: Vec<Span<'a>> = Vec::with_capacity(spans.len());
    for span in spans {
        if out
            .last()
            .is_some_and(|last| last.length == span.length && same_word(last, span, characters))
        {
            let merged = out.last_mut().expect("checked");
            merged.length += span.length;
        } else {
            out.push(*span);
        }
    }
    out
}

/// `_merge_continuous_three_tones`: two adjacent all-third-tone words up to three
/// characters long are one word.
///
/// Reduplications are left out because `_neural_sandhi` owns them, and a word
/// longer than three characters is left out because the third-tone rules only
/// have cases for two, three and four characters — merging a fourth character on
/// would move the word past them.
fn merge_all_third_tones<'a>(
    characters: &[char],
    spans: &[Span<'a>],
    tones: &[u8],
) -> Vec<Span<'a>> {
    let all_third: Vec<bool> = spans
        .iter()
        .map(|span| all_third_tones(span.tones(tones)))
        .collect();
    let mut merged_before = vec![false; spans.len()];
    let mut out: Vec<Span<'a>> = Vec::with_capacity(spans.len());

    for (index, span) in spans.iter().enumerate() {
        let joins = index > 0
            && all_third[index - 1]
            && all_third[index]
            && !merged_before[index - 1]
            && !is_reduplication(&spans[index - 1], characters)
            && spans[index - 1].length + span.length <= 3;
        if joins {
            let merged = out.last_mut().expect("the word before this one");
            merged.length += span.length;
            merged_before[index] = true;
        } else {
            out.push(*span);
        }
    }
    out
}

/// `_merge_continuous_three_tones_2`: the same, for the four-character case where
/// only the *boundary* is two third tones (`所有/人`).
///
/// The same guards, and the same reason for the length cap.
fn merge_boundary_third_tones<'a>(
    characters: &[char],
    spans: &[Span<'a>],
    tones: &[u8],
) -> Vec<Span<'a>> {
    let mut merged_before = vec![false; spans.len()];
    let mut out: Vec<Span<'a>> = Vec::with_capacity(spans.len());

    for (index, span) in spans.iter().enumerate() {
        let joins = index > 0
            && spans[index - 1]
                .tones(tones)
                .last()
                .is_some_and(|tone| *tone == THIRD)
            && span.tones(tones).first().is_some_and(|tone| *tone == THIRD)
            && !merged_before[index - 1]
            && !is_reduplication(&spans[index - 1], characters)
            && spans[index - 1].length + span.length <= 3;
        if joins {
            let merged = out.last_mut().expect("the word before this one");
            merged.length += span.length;
            merged_before[index] = true;
        } else {
            out.push(*span);
        }
    }
    out
}

/// `_merge_er`: 儿 belongs to the word before it.
///
/// Last of the six, and that is why 玩儿 reaches `_merge_erhua` as one word: the
/// coda of an 儿 that jieba split off cannot be attached to a word boundary.
fn merge_er<'a>(characters: &[char], spans: &[Span<'a>]) -> Vec<Span<'a>> {
    let mut out: Vec<Span<'a>> = Vec::with_capacity(spans.len());
    for (index, span) in spans.iter().enumerate() {
        if index > 0 && is_word(span, characters, '儿') {
            let merged = out.last_mut().expect("the word before this one");
            merged.length += span.length;
        } else {
            out.push(*span);
        }
    }
    out
}

/// `modified_tone`: the four groups, in the reference's order.
fn modified_tone(characters: &[char], span: &Span<'_>, tones: &mut [u8], segmenter: &SegmenterZh) {
    let word = span.word(characters);
    let tones = &mut tones[span.start..span.start + span.length];

    bu_sandhi(word, tones);
    yi_sandhi(word, tones);
    neural_sandhi(word, span.tag, tones, segmenter);
    three_sandhi(word, tones, segmenter);
}

/// `_bu_sandhi`.
fn bu_sandhi(word: &[char], tones: &mut [u8]) {
    // `看不懂`: the 不 of a V不V compound is neutral, not a fourth tone that
    // happens to sit between two others.
    if word.len() == 3 && word[1] == '不' {
        tones[1] = NEUTRAL;
        return;
    }

    // 不 before a fourth tone takes the second.
    for (index, character) in word.iter().enumerate() {
        if *character == '不' && tones.get(index + 1) == Some(&4) {
            tones[index] = 2;
        }
    }
}

/// `_yi_sandhi`.
fn yi_sandhi(word: &[char], tones: &mut [u8]) {
    // A run of numerals is read digit by digit — 一零零, 二一零 — and the 一 keeps
    // its first tone. The test is on the *characters*, and 一 is excluded from it,
    // which also means a lone 一 takes this branch.
    let numerals = word.iter().filter(|c| **c != '一').all(is_numeric);
    if word.contains(&'一') && numerals {
        return;
    }

    // 看一看: between two copies of a character, 一 is neutral.
    if word.len() == 3 && word[1] == '一' && word[0] == word[2] {
        tones[1] = NEUTRAL;
        return;
    }

    // 第一 is an ordinal and the 一 is a first tone.
    if word.starts_with(&['第', '一']) {
        tones[1] = 1;
        return;
    }

    for (index, character) in word.iter().enumerate() {
        if *character != '一' {
            continue;
        }
        let Some(follower) = word.get(index + 1) else {
            continue;
        };
        match tones[index + 1] {
            // 一段, 一个: a fourth tone (or a neutral one) makes it the second.
            4 | NEUTRAL => tones[index] = 2,
            // 一天: anything else makes it the fourth — except across
            // punctuation, where the 一 is the last thing before a pause and
            // stays a first tone. A Han run has no punctuation in it; the check
            // is the reference's.
            _ if !PUNCTUATION.contains(*follower) => tones[index] = 4,
            _ => {}
        }
    }
}

/// `_neural_sandhi`, the neutral tone.
///
/// The longest rule in the reference and the one with the least to go on: the
/// shape of the word, jieba's tag, and a word list. A word in
/// [`MUST_NOT_NEURAL_TONE_WORDS`] is left entirely alone — that list is the
/// exceptions to the reduplication and suffix rules below, and it is why this is
/// not simply "a repeated character is neutral".
fn neural_sandhi(word: &[char], tag: &str, tones: &mut [u8], segmenter: &SegmenterZh) {
    let text: String = word.iter().collect();
    if has(&MUST_NOT_NEURAL_TONE_WORDS, &text) {
        return;
    }

    // The two halves jieba's search mode finds in the word, used twice below.
    let (first, names) = segmenter.split_word(&text);

    // 妈妈, 看看, 好好: the second of two identical syllables is neutral, on a
    // noun, verb or adjective (渐渐 as an adverb is not).
    //
    // **The reference asks only whether two characters are the same and this
    // also asks that the repeat not straddle the boundary jieba's search mode
    // found** — the one place this port refuses its answer. 银行行长 is why:
    // Python jieba calls it one word, jieba's search mode splits it 银行/行长,
    // and the 行 of 银行 followed by the 行 of 行长 makes "two identical
    // characters" fire, so the reference reads it *yín háng hang zhǎng* — a word
    // that is in this project's own corpus. A reduplication is a syllable said
    // twice, and one said twice does not straddle a sub-word boundary. A
    // two-character word is the exception and not a special case: jieba's search
    // mode splits 说说 into 说/说, so the boundary *is* the repeat, and 说说 is a
    // reduplication. Pinned by
    // `a_repeat_across_a_sub_word_boundary_is_not_a_reduplication`.
    let tag_head = tag.chars().next();
    if matches!(tag_head, Some('n' | 'v' | 'a')) {
        for index in 1..word.len() {
            if word[index] == word[index - 1] && (word.len() == 2 || index != first) {
                tones[index] = NEUTRAL;
            }
        }
    }

    let last = word.len() - 1;
    let ge = word.iter().position(|character| *character == '个');
    let measure = match ge {
        // 一个, 两个, 几个, 半个: 个 is a measure word and neutral. The reference
        // asks whether the character before it is a numeral — `'一'.isnumeric()`
        // in Python, which is true — hence [`HAN_NUMERALS`].
        Some(index) if index >= 1 => {
            is_numeric(&word[index - 1]) || MEASURE_PREFIXES.contains(word[index - 1])
        }
        _ => false,
    };

    // 吧呢啊… (a sentence-final particle) and 的/地/得 (structural): two rules in
    // the reference, one condition here, because both do the same thing to the
    // word's last syllable. Written in the reference's order so that a later rule
    // cannot take a branch the reference would not have reached.
    if PARTICLES.contains(word[last]) || STRUCTURAL.contains(word[last]) {
        tones[last] = NEUTRAL;
    } else if word.len() == 1 && ASPECT.contains(word[0]) && matches!(tag, "ul" | "uz" | "ug") {
        // 走了, 看着, 去过 — but only as the aspect marker, which is what the tag
        // says.
        tones[last] = NEUTRAL;
    } else if word.len() > 1 && NOUN_SUFFIXES.contains(word[last]) && matches!(tag, "r" | "n") {
        tones[last] = NEUTRAL;
    } else if word.len() > 1 && LOCALIZERS.contains(word[last]) && matches!(tag, "s" | "l" | "f") {
        // 桌上, 地下.
        tones[last] = NEUTRAL;
    } else if word.len() > 1
        && DIRECTIONALS.contains(word[last])
        && DIRECTIONAL_STEMS.contains(word[word.len() - 2])
    {
        // 上来, 下去, 起来 — the direction is a complement, and it is neutral.
        tones[last] = NEUTRAL;
    } else if measure || text == "个" {
        tones[ge.expect("个 is in the word")] = NEUTRAL;
    } else if listed(&MUST_NEURAL_TONE_WORDS, &text) {
        tones[last] = NEUTRAL;
    }

    // And then the same word list again, against the two halves jieba's search
    // mode finds in the word: 一百二十 is 一百 + 二十, 瓜子儿 is 瓜子 + 儿, and
    // 休息 is neutral because 休息 is in the list whether or not jieba agrees.
    //
    // **The name and the group are not the same characters**, which is the
    // reference's doing and not a slip here: see
    // [`SegmenterZh::split_word`](crate::g2p::zh::segmenter::SegmenterZh::split_word)
    // for 不怎么样, the word where the two disagree. The *name* is what the word
    // list is asked about and the *group* is what loses its last tone.
    let groups = [first, word.len() - first];
    for (index, name) in names.iter().enumerate() {
        // A group the reference would have indexed out of bounds, and cannot
        // reach: the empty group's name is the empty string, which is in no
        // word list. Guarded rather than relied on, because an index that is
        // out of range here would mean the *neighbouring* syllable.
        if groups[index] == 0 {
            continue;
        }
        if listed(&MUST_NEURAL_TONE_WORDS, name) {
            let at = if index == 0 {
                first - 1
            } else {
                word.len() - 1
            };
            tones[at] = NEUTRAL;
        }
    }
}

/// `_three_sandhi`, for words of two, three and four characters.
///
/// Words of five characters and up are left alone, which is the reference's
/// behaviour and not an omission to fix here: the rules it has are for two
/// adjacent syllables, a syllable plus a word, and two words, and a longer word
/// has no rule that applies.
fn three_sandhi(word: &[char], tones: &mut [u8], segmenter: &SegmenterZh) {
    match word.len() {
        2 if all_third_tones(tones) => tones[0] = 2,
        3 => three_sandhi_word_of_three(word, tones, segmenter),
        4 => {
            // 美好/理想: two words of two, and either half that is all third tone
            // loses its first tone.
            for half in [0, 2] {
                if all_third_tones(&tones[half..half + 2]) {
                    tones[half] = 2;
                }
            }
        }
        _ => {}
    }
}

/// The three-character case of `_three_sandhi`, which is two cases: all three
/// tones, or a split into a syllable and a word.
fn three_sandhi_word_of_three(word: &[char], tones: &mut [u8], segmenter: &SegmenterZh) {
    let text: String = word.iter().collect();
    let (first, _names) = segmenter.split_word(&text);

    if all_third_tones(tones) {
        if first == 2 {
            // 蒙古/包: both of the first two change.
            tones[0] = 2;
            tones[1] = 2;
        } else if first == 1 {
            // 纸/老虎: only the first of the second word's two.
            tones[1] = 2;
        }
        return;
    }

    for (index, (start, length)) in [(0, first), (first, word.len() - first)].iter().enumerate() {
        let group = &tones[*start..start + length];
        if *length == 2 && all_third_tones(group) {
            // 所有/人: the first half is all third tone and loses its first.
            tones[*start] = 2;
        } else if index == 1
            && !all_third_tones(group)
            && tones[first] == THIRD
            && tones[first - 1] == THIRD
        {
            // 好/喜欢: the boundary is two third tones and the first word is one
            // syllable, so the syllable it ends on is the one that changes.
            tones[first - 1] = 2;
        }
    }
}

/// `_merge_erhua`.
///
/// Two things happen here and they are independent: 儿 read with the first tone
/// is really a second tone (the reference's "fix er1"), and an 儿 that is a
/// word's last character and reads `er2`/`er5` stops being a syllable and becomes
/// an `r` coda on the one before it.
///
/// Returns which character carries the coda and which character's syllable is
/// gone, if either.
fn merge_erhua(
    characters: &[char],
    span: &Span<'_>,
    tones: &mut [u8],
    readings: &[Syllable],
) -> (Option<usize>, Option<usize>) {
    let last = span.start + span.length - 1;

    // 儿 is not usually a first tone, and the reference corrects it before
    // asking whether the word erhuas — so the correction applies either way.
    if characters[last] == '儿' && readings[last].toneless() == "er" && tones[last] == 1 {
        tones[last] = 2;
    }

    let word: String = span.word(characters).iter().collect();
    if !has(&MUST_ERHUA, &word) && (has(&NOT_ERHUA, &word) || matches!(span.tag, "a" | "j" | "nr"))
    {
        // 女儿 and 花儿 keep their 儿; an adjective, an abbreviation or a name
        // with an 儿 in it is not erhua.
        return (None, None);
    }

    let Some(coda) = last.checked_sub(1).filter(|_| span.length > 1) else {
        return (None, None);
    };
    if characters[last] != '儿' || readings[last].toneless() != "er" {
        return (None, None);
    }
    if !matches!(tones[last], 2 | NEUTRAL) {
        return (None, None);
    }
    if has(&NOT_ERHUA, &last_two(span.word(characters))) {
        return (None, None);
    }

    (Some(coda), Some(last))
}

// ------------------------------------------------------------------- helpers

/// The tone a reading carries, in this module's numbering.
///
/// The one reading in the syllable table with no tone digit at all (`hng`) is
/// planned as neutral; it has no entry in the table either, so
/// `syllable_to_ipa` reports it later rather than this failing to plan it.
fn tone_of(reading: &Syllable) -> u8 {
    match reading.tone() {
        Some(0) | None => NEUTRAL,
        Some(tone) => tone,
    }
}

/// Write a reading back out with its planned tone and erhua coda.
///
/// An unchanged reading is echoed exactly as `pinyin-pro` wrote it — the `0` it
/// uses for the neutral tone and the missing digit of `hng` included — so that
/// this layer cannot change which syllable a later error message names. A changed
/// one is spelled with the tone as this module numbers it, and
/// `syllable_to_ipa` accepts both spellings of the neutral tone.
fn spell(reading: &Syllable, tone: u8, erhua: bool) -> String {
    if !erhua && tone == tone_of(reading) {
        return reading.as_str().to_string();
    }
    format!(
        "{}{}{}",
        reading.toneless(),
        if erhua { "r" } else { "" },
        tone
    )
}

/// Whether a span is exactly this one character.
fn is_word(span: &Span<'_>, characters: &[char], character: char) -> bool {
    span.length == 1 && span.word(characters)[0] == character
}

/// Whether two spans hold the same text.
fn same_word(a: &Span<'_>, b: &Span<'_>, characters: &[char]) -> bool {
    a.length == b.length && a.word(characters) == b.word(characters)
}

/// `_is_reduplication`: a word of two identical characters.
fn is_reduplication(span: &Span<'_>, characters: &[char]) -> bool {
    let word = span.word(characters);
    word.len() == 2 && word[0] == word[1]
}

/// `_all_tone_three`.
///
/// **True for no tones at all**, which is Python's `all([])` and not a slip:
/// the three-character case splits a word into two groups and asks whether
/// either is all third tone, and a group that came out empty has to answer yes so
/// that the branch after it is not reached. See [`three_sandhi_word_of_three`].
fn all_third_tones(tones: &[u8]) -> bool {
    tones.iter().all(|tone| *tone == THIRD)
}

/// `word in list`, by binary search.
fn has(list: &[&str], word: &str) -> bool {
    list.binary_search(&word).is_ok()
}

/// `word in list or word[-2:] in list`.
fn listed(list: &[&str], word: &str) -> bool {
    has(list, word) || has(list, last_two_slice(word))
}

/// Python's `word[-2:]` over a `&str`: the last two characters, or the whole
/// word when it is shorter.
fn last_two_slice(word: &str) -> &str {
    let count = word.chars().count();
    if count <= 2 {
        return word;
    }
    let start = word
        .char_indices()
        .nth(count - 2)
        .map(|(index, _)| index)
        .expect("count > 2");
    &word[start..]
}

/// Python's `word[-2:]` over a slice of characters.
fn last_two(word: &[char]) -> String {
    let start = word.len().saturating_sub(2);
    word[start..].iter().collect()
}

/// `str.isnumeric()`, which is not [`char::is_numeric`] for a Han numeral.
fn is_numeric(character: &char) -> bool {
    character.is_numeric() || HAN_NUMERALS.contains(*character)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_han_numerals_are_the_ones_python_calls_numeric() {
        // The property the constant exists for, over the numerals a number
        // reader can produce (一百二十三) and the ones it cannot (廿, 卅).
        for character in "一二三四五六七八九十百千万亿两零廿卅兆".chars() {
            assert!(is_numeric(&character), "{character}");
            // And the reason it exists rather than being `is_numeric`: a Han
            // numeral is a letter to the general category, not a number.
            assert!(!character.is_numeric(), "{character} is not L*");
        }
        // 〇 is `Nl` and the full-width digits are `Nd`, so Rust's own test
        // already has them; the constant does not have to repeat them.
        for character in "〇０１".chars() {
            assert!(is_numeric(&character), "{character}");
            assert!(character.is_numeric(), "{character} is N*");
        }
        // And the characters that must not be, or 一 would never sandhi.
        for character in "个的不次天点".chars() {
            assert!(!is_numeric(&character), "{character}");
        }
    }

    #[test]
    fn the_word_lists_are_sorted_for_binary_search() {
        for list in [
            &MUST_NEURAL_TONE_WORDS[..],
            &MUST_NOT_NEURAL_TONE_WORDS[..],
            &MUST_ERHUA[..],
            &NOT_ERHUA[..],
        ] {
            assert!(
                list.windows(2).all(|pair| pair[0] < pair[1]),
                "the list is not sorted"
            );
        }
    }

    #[test]
    fn last_two_is_pythons_slice() {
        assert_eq!(last_two_slice("瓜子儿"), "子儿");
        assert_eq!(last_two_slice("花儿"), "花儿");
        assert_eq!(last_two_slice("儿"), "儿");
        assert_eq!(last_two_slice(""), "");
        assert_eq!(last_two(&['瓜', '子', '儿']), "子儿");
        assert_eq!(last_two(&['儿']), "儿");
    }
}
