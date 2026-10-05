//! Chinese readings and the syllable table — the two halves of the Chinese G2P
//! that do not depend on word boundaries.
//!
//! The JavaScript side gets a character's pinyin from `pinyin-pro` and its IPA
//! from a table generated out of misaki. Both are reproduced here, and the port
//! is deliberately literal rather than tidy: `pinyin-pro`'s answer depends on
//! details that look like implementation noise and are not, so the code below
//! follows its steps in its order and the data below is its own data, extracted
//! by `scripts/generate/gen-pinyin-pro-data.mjs`.
//!
//! # Which reading a character gets
//!
//! Not its first one. `pinyin-pro` builds an Aho-Corasick automaton over ~4,200
//! phrase patterns (`DICT2`–`DICT5` plus a numeral rule table), runs a
//! maximum-probability segmentation over the matches, and then reads the chosen
//! phrases out. A character's *first* reading is only the fallback for positions
//! no phrase covers.
//!
//! That is worth stating with a number, because "take the first reading" is the
//! obvious shortcut and it is wrong often enough to be audible: over a corpus of
//! ordinary sentences, 14% of characters differ from what `pinyin-pro` returns.
//! 银行行长 is `yín háng háng zhǎng`, not `yín xíng cháng xíng`; 目的 is `mù dì`,
//! not `mù de`.
//!
//! Three things in the segmentation are easy to get wrong, and all three are
//! reproduced exactly:
//!
//! - **The automaton is not needed, but its *order* is.** A pattern is a suffix
//!   of the text ending at the current position, so looking up the last *n*
//!   characters for *n* from the longest pattern downwards finds exactly the
//!   patterns the automaton's failure links would, in the same order. That order
//!   decides which of two equal-probability segmentations wins.
//! - **Probabilities are compared with a scaled exponent, not as magnitudes.**
//!   `maxProbability` multiplies probabilities along the text, rescales anything
//!   below `1e-300` by `1e300` and counts the rescales in `decimal`, then
//!   compares `(decimal, probability)`. A plain `f64` product would underflow to
//!   zero on a long sentence and every segmentation would tie.
//! - **一, 不, 了 and 々 are read by rule, not from the table.** 一 before a
//!   fourth tone is `yí`; between two of the same character it loses its tone
//!   altogether; 了 with no Chinese character before it is `liǎo`; 々 repeats the
//!   character before it. Those rules live in `pinyin-special.txt`, generated
//!   from `pinyin-pro`'s own table, so that no linguistic constant is restated
//!   in Rust.
//!
//! # Which IPA a syllable gets
//!
//! A table, because that is what misaki — the G2P Kokoro was trained against —
//! does: one syllable at a time, not a phonetic transcription of a word in
//! context. The table stores the IPA with a `0` where the tone goes, and the tone
//! arrives as one of Kokoro's four arrows, which is the only tone encoding its
//! tokenizer has.
//!
//! # What is not here
//!
//! Word boundaries. [`ChinesePinyin::han_to_ipa`] puts one space between
//! syllables, which is what the JavaScript side's `singleSyllableWords` does and
//! what its own tests compare against; [`ChinesePinyin::han_to_ipa_by_words`] is
//! the production spacing and takes the boundaries from jieba as an argument,
//! because the readings and the boundaries come from different places and this
//! module only owns the readings. The punctuation, numeral and Latin-run rules
//! around the Han run are [`super::zh_text`] and [`super::numbers_zh`].

use std::borrow::Cow;
use std::collections::{HashMap, HashSet};
use std::sync::OnceLock;

/// `DICT1`, inverted: one line per character, its readings in priority order.
const CHARACTERS: &str = include_str!("../../data/pinyin-chars.txt");
/// `DICT2`–`DICT5` plus the numeral rule table.
const PHRASES: &str = include_str!("../../data/pinyin-phrases.txt");
/// The 一/不/了/々 rules, precomputed.
const SPECIAL: &str = include_str!("../../data/pinyin-special.txt");
/// Pinyin to IPA, with a `0` where the tone goes.
const SYLLABLES: &str = include_str!("../../data/pinyin-syllables.txt");

/// `Probability.DICT` — what a phrase from `DICT2`–`DICT5` is worth.
const PROBABILITY_DICT: f64 = 2e-8;
/// `Probability.Rule` — what a numeral rule is worth. Lower, so a dictionary
/// phrase wins where both cover the same characters.
const PROBABILITY_RULE: f64 = 1e-12;
/// `Probability.Unknown` — what a character no pattern covers is worth.
const PROBABILITY_UNKNOWN: f64 = 1e-13;

/// `TONE_MAPPING` from `chinese.ts`, indexed by tone number.
///
/// The table's `0` placeholder is replaced with one of these and `retone` folds
/// it into an arrow. The neutral tone (5) contributes nothing — a *value* rather
/// than a missing entry, and the difference decides whether a neutral-tone
/// syllable is quietly toneless or rejected. Index 0 is unreachable:
/// `pinyin-pro` numbers the neutral tone `0` and this module maps it to 5 first.
const TONE_LETTERS: [&str; 6] = ["", "˥", "˧˥", "˧˩˧", "˥˩", ""];

/// One syllable, as `pinyin-pro` writes it with `toneType: 'num'`: `ni3`.
///
/// A slice of the generated data, so it is `'static` and free to copy — the
/// segmentation walk moves these around and never allocates.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Syllable(&'static str);

impl Syllable {
    /// The syllable and its tone, the way `pinyin-pro` writes it: `ni3`, `le0`.
    ///
    /// A syllable with no tone at all has no digit — see [`Syllable::tone`].
    pub fn as_str(&self) -> &'static str {
        self.0
    }

    /// The syllable without its tone: `ni`, `le`.
    pub fn toneless(&self) -> &'static str {
        split_reading(self.0).0
    }

    /// The tone, as the digit `pinyin-pro` appends.
    ///
    /// `None` means the reading has no tone at all, which is different from the
    /// neutral tone (`Some(0)`). Exactly one reading in the dictionary is like
    /// that: 哼's second reading, `hng`, which has no tone mark and no plain
    /// vowel for `getNumOfTone` to fall back on.
    pub fn tone(&self) -> Option<u8> {
        split_reading(self.0).1
    }
}

/// Split a *reading* into its toneless part and its tone.
///
/// The tone is the last character **if it is a digit**: `pinyin-pro` appends one
/// for every reading it can number, so the absence of a digit is the encoding for
/// "no tone". No pinyin syllable ends in a digit, so this cannot be ambiguous —
/// and the generator refuses to write one that does.
///
/// This is `getNumOfTone`'s rule. It is deliberately *not* the rule
/// [`syllable_to_ipa`](ChinesePinyin::syllable_to_ipa) uses; see
/// [`split_tone_marker`].
fn split_reading(syllable: &str) -> (&str, Option<u8>) {
    match syllable.char_indices().next_back() {
        Some((index, last)) if last.is_ascii_digit() => {
            (&syllable[..index], Some(last as u8 - b'0'))
        }
        _ => (syllable, None),
    }
}

/// Split a syllable the way `syllableToIpa` does: the last character *is* the
/// tone marker, digit or not.
///
/// A separate rule from [`split_reading`], and the difference is load-bearing
/// rather than an accident of two similar functions. `getNumOfTone` reports a
/// tone it cannot find as `''` — "this reading has none" — while `syllableToIpa`
/// does `Number(syllable.slice(-1))` and `syllable.slice(0, -1)` with no such
/// question asked. For a syllable that has a digit the two agree. For one that
/// does not they disagree about which syllable is missing from the table, and
/// the message has to name the same one the JavaScript does: upstream's own
/// `DICT4` spells 枝大于本 as `zh dà yú běn`, so the syllable is `zh`, the key
/// the JavaScript looks up is `z`, and this reports `z` too.
fn split_tone_marker(syllable: &str) -> (&str, Option<u8>) {
    match syllable.char_indices().next_back() {
        // `to_digit` rather than `is_ascii_digit`, because it is `Number`'s rule
        // being reproduced: `Number('٣')` is 3, and so is this.
        Some((index, last)) => (
            &syllable[..index],
            last.to_digit(10).map(|digit| digit as u8),
        ),
        None => (syllable, None),
    }
}

/// Peel the erhua coda off a syllable, if it has one.
///
/// The tone rules write the coda as an `r` before the tone digit — `wanr2` for
/// 玩儿 — because that is where PaddleSpeech puts it: on the *final*, which for
/// 玩 is `uan`, so the reference has `w` + `uanr2`. The syllable table has no
/// erhua entries and should not grow any: misaki's v1.0 frontend never produced
/// one (it reads 玩儿 as two syllables, `wan2` + `er2`), so an erhua entry would
/// be a syllable transcribed from a model that never saw it. The coda it needs is
/// one character wide and the table already knows it — `ɻ` is what 人 starts
/// with — so the `r` is peeled off here and appended to the IPA instead.
///
/// `er` ends in `r` and is not erhua, and no rule writes `err`.
///
/// **v1.1-zh does this differently.** Its frontend writes a separate `R` phoneme
/// (`an` + `R` + tone, `misaki/zh_frontend.py`), because its vocabulary has `R`
/// and no `ɻ`. When that frontend is ported this function is where the two
/// spellings part company.
fn split_erhua_coda(toneless: &str) -> (&str, bool) {
    match toneless.strip_suffix('r') {
        Some(base) if toneless != "er" => (base, true),
        _ => (toneless, false),
    }
}

/// Why a run of Chinese text could not be turned into IPA.
///
/// Both variants correspond to the JavaScript side's single `UnknownSyllableError`
/// (its "could not read" case is that same class with a sentence in the syllable
/// field). They are separate here because they are separate problems: one is a
/// gap in this table, the other is a character `pinyin-pro` has never seen, and
/// the fix for each is somewhere else.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PinyinError {
    /// A syllable `pinyin-pro` produced that the syllable table has no entry for.
    UnknownSyllable { syllable: String, text: String },
    /// A character `pinyin-pro` has no reading for, so the run lost characters.
    UnreadableCharacters {
        found: usize,
        expected: usize,
        text: String,
    },
    /// The word boundaries and the syllables do not describe the same text.
    ///
    /// The boundaries come from jieba and the syllables from `pinyin-pro`, so
    /// they can disagree — and slicing on a wrong boundary would move a syllable
    /// into the neighbouring word, which is audible and otherwise silent. The
    /// JavaScript's `joinByWords` makes the same check and throws the same way.
    WordBoundaries {
        covered: usize,
        syllables: usize,
        text: String,
    },
}

impl PinyinError {
    /// A stable code for the JavaScript side.
    pub fn code(&self) -> &'static str {
        match self {
            Self::UnknownSyllable { .. } => "unknown-syllable",
            Self::UnreadableCharacters { .. } => "unreadable-characters",
            Self::WordBoundaries { .. } => "word-boundaries",
        }
    }
}

impl std::fmt::Display for PinyinError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnknownSyllable { syllable, text } => {
                write!(f, "no IPA for the syllable {syllable:?} in {text:?}")
            }
            Self::UnreadableCharacters {
                found,
                expected,
                text,
            } => write!(
                f,
                "characters pinyin-pro could not read ({found}/{expected} returned) in {text:?}"
            ),
            Self::WordBoundaries {
                covered,
                syllables,
                text,
            } => write!(
                f,
                "word boundaries cover {covered} of {syllables} syllables in {text:?}"
            ),
        }
    }
}

impl std::error::Error for PinyinError {}

/// Chinese text to pinyin and to IPA.
///
/// Cheap to construct and cheap to copy: it is a handle on tables that are parsed
/// once for the whole process, on the first call that needs them. The tables are
/// ~3 MB of hash maps, so a build that never sees Chinese never pays for them —
/// the same trade the English backend makes with its dictionary.
#[derive(Debug, Default, Clone, Copy)]
pub struct ChinesePinyin;

impl ChinesePinyin {
    pub fn new() -> Self {
        Self
    }

    /// A character's first reading, without its tone: `你` → `ni`.
    ///
    /// "First" is `pinyin-pro`'s priority order, which is the reading a character
    /// gets when nothing around it says otherwise — see [`ChinesePinyin::readings`]
    /// for the ones that do.
    ///
    /// `None` for a character `pinyin-pro` does not know, which includes every
    /// non-Chinese character.
    pub fn char_to_pinyin(&self, character: char) -> Option<&'static str> {
        self.first_reading(character)
            .map(|reading| reading.toneless())
    }

    /// Every character's reading, in order, with the phrase and tone rules
    /// applied — `pinyin-pro`'s `toneType: 'num'` with `nonZh: 'removed'`.
    ///
    /// One entry per character of `text`; `None` where `pinyin-pro` has no
    /// reading, which is why the result is an `Option` per position rather than a
    /// shorter list. `pinyin-pro` itself drops those positions, and the caller is
    /// then left comparing a length against a character count to find out whether
    /// anything was lost — see [`ChinesePinyin::han_to_ipa`], which does exactly
    /// that check and refuses.
    pub fn readings(&self, text: &str) -> Vec<Option<Syllable>> {
        let characters: Vec<(usize, char)> = text.char_indices().collect();
        let selected = self.segment(text, &characters);

        let mut readings: Vec<Option<Syllable>> = vec![None; characters.len()];
        let mut selected_index = 0;
        let mut at = 0;

        while at < characters.len() {
            // A pattern the segmentation chose starts here, or this character is
            // read on its own. The chosen patterns do not overlap and come in
            // order, so one index into them is enough.
            let matched = selected
                .get(selected_index)
                .filter(|pattern| pattern.start == at)
                .copied();

            if let Some(pattern) = matched {
                let length = pattern.readings.split(' ').count();
                for (offset, reading) in pattern.readings.split(' ').enumerate() {
                    if let Some(slot) = readings.get_mut(at + offset) {
                        *slot = Some(Syllable(reading));
                    }
                }
                at += length;
                selected_index += 1;
                continue;
            }

            let character = characters[at].1;
            let previous = at.checked_sub(1).map(|index| characters[index].1);
            let next = characters.get(at + 1).map(|(_, character)| *character);
            readings[at] = self.special_reading(character, previous, next);
            at += 1;
        }

        readings
    }

    /// The readings of every character that has one, in order.
    ///
    /// The convenience form, and the one to compare against `pinyin-pro`'s
    /// `type: 'array'` output. A character with no reading is dropped rather than
    /// reported — use [`ChinesePinyin::readings`] to tell "dropped" from "not
    /// Chinese".
    pub fn text_to_pinyin(&self, text: &str) -> Vec<&'static str> {
        self.readings(text)
            .into_iter()
            .flatten()
            .map(|reading| reading.as_str())
            .collect()
    }

    /// One syllable's IPA, with its tone folded into one of Kokoro's arrows.
    ///
    /// `context` is only used for the error message, and is the text the syllable
    /// came from — the same thing the JavaScript side passes as its `context`.
    ///
    /// Accepts both spellings of the neutral tone: `pinyin-pro` writes it `0` and
    /// the tone rules write it `5`. And accepts an **erhua syllable**, which is
    /// spelled with an `r` before the tone digit — `wanr2` for 玩儿 — and read as
    /// the syllable without it plus `ɻ`; see `split_erhua_coda`.
    pub fn syllable_to_ipa(&self, syllable: &str, context: &str) -> Result<String, PinyinError> {
        let (toneless, reported) = split_tone_marker(syllable);
        // `pinyin-pro` numbers the neutral tone `0`; the table and the tone
        // letters use `5`. Skipping this leaves the `0` placeholder in the IPA,
        // where the tokenizer has no digits at all — so the syllable would be
        // read as a digit *and* lose its tone.
        let tone = match reported {
            Some(0) => Some(5),
            other => other,
        };

        let (toneless, coda) = split_erhua_coda(toneless);

        // The table spells `ü` as `v` (pypinyin's toneless form) and `pinyin-pro`
        // spells it `ü`. The translation is required, not cosmetic: without it
        // every syllable with an `ü` after `n` or `l` misses the table, and the
        // characters that need one — 女, 绿, 略, 虐 — are dropped from the audio
        // with no error at all.
        let key = if toneless.contains('ü') {
            Cow::Owned(toneless.replace('ü', "v"))
        } else {
            Cow::Borrowed(toneless)
        };

        // The table first, then the tone — the same order as the JavaScript, and
        // it decides which of the two is reported for a syllable that is wrong in
        // both ways.
        let template = self.tables().syllables.get(key.as_ref()).ok_or_else(|| {
            PinyinError::UnknownSyllable {
                syllable: key.into_owned(),
                text: context.to_string(),
            }
        })?;

        let tone_letter = match tone {
            Some(tone) if (1..TONE_LETTERS.len() as u8).contains(&tone) => {
                TONE_LETTERS[tone as usize]
            }
            _ => {
                return Err(PinyinError::UnknownSyllable {
                    syllable: syllable.to_string(),
                    text: context.to_string(),
                })
            }
        };

        // misaki deletes U+032F (COMBINING INVERTED BREVE BELOW) in Python
        // (`replace(chr(815), '')`), and the tokenizer's normalizer would drop it
        // anyway — it keeps neither combining mark. Doing it here keeps the IPA
        // identical to the training target's rather than merely equivalent after
        // tokenisation. U+0329, in ʂɻ̩, is *not* deleted: it is a different mark
        // and the vocabulary has it.
        let ipa = retone(&template.replace('0', tone_letter)).replace('\u{032F}', "");

        // The erhua coda goes on last, after the tone letter, because it is a
        // coda on the syllable and not part of the vowel the tone marks.
        Ok(if coda { ipa + "ɻ" } else { ipa })
    }

    /// Every character's reading, refusing when any of them has none.
    ///
    /// [`ChinesePinyin::readings`] answers `None` for a character `pinyin-pro`
    /// does not know, and the caller is then left comparing a length against a
    /// character count to find out. This does that comparison and reports it, so
    /// the two callers that want all of them — [`han_to_ipa`] and the tone rules
    /// — say so once.
    ///
    /// [`han_to_ipa`]: ChinesePinyin::han_to_ipa
    pub fn complete_readings(&self, text: &str) -> Result<Vec<Syllable>, PinyinError> {
        let readings = self.readings(text);
        let expected = readings.len();
        let found = readings.iter().filter(|reading| reading.is_some()).count();

        // Checked before any syllable is looked up, which is what the JavaScript
        // does and what makes the message about the characters rather than about
        // whichever syllable happened to come first.
        if found != expected {
            return Err(PinyinError::UnreadableCharacters {
                found,
                expected,
                text: text.to_string(),
            });
        }

        Ok(readings.into_iter().flatten().collect())
    }

    /// A run of Chinese characters to IPA, one space per syllable.
    ///
    /// One space per syllable is what the JavaScript side's `singleSyllableWords`
    /// produces, and it is the shape its own tests pin. The production spacing is
    /// one space per *word* with no separator inside one, and the words come from
    /// jieba — phase 6.
    ///
    /// Refuses rather than returning nothing when a character has no reading. The
    /// alternative — returning the empty string, as the verification script did —
    /// drops the character from the audio without a trace, and a sentence that is
    /// missing a word sounds like a sentence.
    pub fn han_to_ipa(&self, text: &str) -> Result<String, PinyinError> {
        let readings = self.complete_readings(text)?;

        let mut syllables = Vec::with_capacity(readings.len());
        for reading in readings {
            syllables.push(self.syllable_to_ipa(reading.as_str(), text)?);
        }
        Ok(syllables.join(" "))
    }

    /// A run of Chinese characters to IPA, grouped into words.
    ///
    /// `lengths` is how many characters each word has, in order — jieba's answer,
    /// from [`SegmenterZh::word_lengths`](crate::backends::SegmenterZh::word_lengths).
    /// One space goes between words and none inside one, which is misaki's
    /// spacing and the shape Kokoro was trained on: one space per *syllable*
    /// instead made the model pause inside words (人设, 曾经).
    ///
    /// [`ChinesePinyin::han_to_ipa`] is the same reading with one space per
    /// syllable, which is what `chinese.ts`'s `singleSyllableWords` produces and
    /// what its own tests pin; this is the production spacing.
    ///
    /// The three refusals happen in the JavaScript's order, so the error a caller
    /// sees is the one the JavaScript would have thrown: characters `pinyin-pro`
    /// could not read, then a syllable the table is missing, then boundaries that
    /// do not cover the syllables.
    pub fn han_to_ipa_by_words(
        &self,
        text: &str,
        lengths: &[usize],
    ) -> Result<String, PinyinError> {
        let readings = self.complete_readings(text)?;

        let mut syllables = Vec::with_capacity(readings.len());
        for reading in readings {
            syllables.push(self.syllable_to_ipa(reading.as_str(), text)?);
        }

        join_by_words(&syllables, lengths, text)
    }

    /// A run's syllables to IPA, grouped into words.
    ///
    /// The same spacing as [`ChinesePinyin::han_to_ipa_by_words`], for a caller
    /// that already has the syllables: the tone rules rewrite them (phase 9D),
    /// and a syllable they produced is one the syllable table can read —
    /// `wanr2` — but not one [`ChinesePinyin::readings`] produced.
    ///
    /// The two refusals are the last two of the three above, in the same order:
    /// a syllable the table is missing, then boundaries that do not cover the
    /// syllables.
    pub fn syllables_to_ipa_by_words(
        &self,
        syllables: &[String],
        lengths: &[usize],
        text: &str,
    ) -> Result<String, PinyinError> {
        let mut ipa = Vec::with_capacity(syllables.len());
        for syllable in syllables {
            ipa.push(self.syllable_to_ipa(syllable, text)?);
        }
        join_by_words(&ipa, lengths, text)
    }

    // ------------------------------------------------------------- internals

    /// The tables, parsed on first use.
    fn tables(&self) -> &'static Tables {
        TABLES.get_or_init(Tables::load)
    }

    /// The reading `pinyin-pro` gives a character on its own.
    fn first_reading(&self, character: char) -> Option<Syllable> {
        self.tables()
            .characters
            .get(&character)
            .and_then(|readings| readings.split(' ').next())
            .map(Syllable)
    }

    /// A character no chosen phrase covers.
    ///
    /// The order is `pinyin-pro`'s `getProcessFuncs`: 々, then 了, then 一/不, then
    /// the table. Each rule returns early, so 々 never reaches the sandhi rules
    /// even though it is in neither list.
    fn special_reading(
        &self,
        character: char,
        previous: Option<char>,
        next: Option<char>,
    ) -> Option<Syllable> {
        let special = &self.tables().special;

        // 々 is the reduplication mark: it is read as the character before it.
        if character == '々' {
            return previous
                .and_then(|before| self.first_reading(before))
                .or_else(|| special.default.get(&character).copied());
        }

        // 了 with no Chinese character before it is liǎo rather than the neutral
        // `le` the table gives it first. The check is on the *character*, not on
        // the reading: `pinyin-pro` asks whether the previous position is in the
        // dictionary at all.
        if character == '了' && previous.is_none_or(|before| self.first_reading(before).is_none())
        {
            return special.default.get(&character).copied();
        }

        if let Some(rules) = special.sandhi.get(&character) {
            // 看一看, 去不去: between two of the same character, no tone at all.
            // Checked before the tone rule, and the middle character has to be one
            // the dictionary knows — otherwise 一 and 不 would change tone on the
            // strength of a repeated non-Chinese character.
            let repeated = previous.is_some()
                && previous == next
                && previous.is_some_and(|before| self.first_reading(before).is_some());
            if repeated {
                return special.neutral.get(&character).copied();
            }

            // Otherwise the tone comes from the *next* character's own first
            // reading — not from the reading it ends up with in context, which is
            // what makes this a local rule in `pinyin-pro` too.
            if let Some(follower) = next {
                if !special.ignored.contains(&(character, follower)) {
                    let tone = self
                        .first_reading(follower)
                        .and_then(|reading| reading.tone());
                    if let Some(tone) = tone {
                        if let Some((_, reading)) = rules.iter().find(|(value, _)| *value == tone) {
                            return Some(*reading);
                        }
                    }
                }
            }
        }

        self.first_reading(character)
    }

    /// The phrases `pinyin-pro`'s automaton would match, in its order.
    ///
    /// A pattern is a suffix of the text ending at `end`, so for each end this
    /// walks the possible lengths from the longest pattern down and looks each
    /// one up. That is the automaton's failure chain — longest match first, then
    /// each shorter suffix that is also a pattern — with a hash lookup instead of
    /// a trie. The order matters: the segmentation below breaks ties in favour of
    /// whichever candidate it is offered later.
    fn matches(&self, text: &str, characters: &[(usize, char)]) -> Vec<Match> {
        let tables = self.tables();
        let mut matches = Vec::new();

        for end in 0..characters.len() {
            let longest = tables.max_phrase_chars.min(end + 1);
            for length in (1..=longest).rev() {
                let start = end + 1 - length;
                let (offset, character) = characters[end];
                let phrase = &text[characters[start].0..offset + character.len_utf8()];
                if let Some(pattern) = tables.phrases.get(phrase) {
                    matches.push(Match {
                        start,
                        end,
                        readings: pattern.readings,
                        probability: pattern.probability,
                    });
                }
            }
        }

        matches
    }

    /// `pinyin-pro`'s `maxProbability`: which non-overlapping phrases to read.
    ///
    /// A dynamic program over the text, from the end backwards, keeping for each
    /// position the best segmentation of the text from there on. The state is
    /// `(decimal, probability)` rather than a bare probability because the
    /// products underflow: on a long sentence every candidate would be zero and
    /// every segmentation would tie. `decimal` counts the times the probability
    /// has been rescaled by `1e300`, so a *smaller* `decimal` means a larger
    /// probability, and it is compared first.
    fn segment(&self, text: &str, characters: &[(usize, char)]) -> Vec<Match> {
        let matches = self.matches(text, characters);
        let length = characters.len();
        if length == 0 {
            return Vec::new();
        }

        // The end of the text, and the only state with a probability of 1.
        let terminal = State {
            probability: 1.0,
            decimal: 0,
            pattern: None,
            next_index: length,
        };
        let mut states: Vec<Option<State>> = vec![None; length];

        // Consumed from the back, because the loop below visits end positions
        // from the end of the text and `maxProbability` matches a pattern by its
        // end.
        let mut pattern_index = matches.len() as isize - 1;
        let mut candidate = (pattern_index >= 0).then(|| matches[pattern_index as usize]);

        for at in (0..length).rev() {
            let suffix = if at + 1 >= length {
                terminal
            } else {
                // Assigned on the previous turn of this loop, which is why the
                // loop runs backwards.
                states[at + 1].expect("every position below the current one is set")
            };
            // Where the walk resumes if this position has no pattern of its own:
            // the next position that does.
            let next_index = if suffix.pattern.is_some() {
                at + 1
            } else {
                suffix.next_index
            };

            while let Some(pattern) = candidate {
                if pattern.end != at {
                    break;
                }
                // `getPatternDecimal` is 0 for every pattern that ships: it is
                // non-zero only for the custom and surname priorities, and the
                // surname table is not in the data (see the generator).
                let state = check_decimal(State {
                    probability: pattern.probability * suffix.probability,
                    decimal: suffix.decimal,
                    pattern: Some(pattern),
                    next_index,
                });
                states[pattern.start] = Some(better(states[pattern.start], state));

                pattern_index -= 1;
                candidate = (pattern_index >= 0).then(|| matches[pattern_index as usize]);
            }

            let unknown = check_decimal(State {
                probability: PROBABILITY_UNKNOWN * suffix.probability,
                decimal: 0,
                pattern: None,
                next_index,
            });
            states[at] = Some(better(states[at], unknown));
        }

        let mut selected = Vec::new();
        let mut at = 0;
        while at < length {
            let state = states[at].expect("every position is set");
            if let Some(pattern) = state.pattern {
                selected.push(pattern);
            }
            // `next_index` is always past `at` — it is either `at + 1` or the next
            // position that has a pattern — so this terminates. The guard is here
            // because a loop inside the wasm takes the worker with it.
            if state.next_index <= at {
                break;
            }
            at = state.next_index;
        }

        selected
    }
}

/// Group IPA syllables into words: nothing inside a word, one space between.
///
/// This is misaki's spacing, reproduced from `chinese.ts`'s `joinByWords`.
///
/// The slicing is clamped the way JavaScript's `Array.prototype.slice` is, so a
/// length that overruns the syllables produces a short word and then trips the
/// check below, rather than panicking on an out-of-range index. A panic inside
/// the wasm takes the worker with it, and the answer — "these boundaries are
/// wrong" — is available either way.
fn join_by_words(
    syllables: &[String],
    lengths: &[usize],
    context: &str,
) -> Result<String, PinyinError> {
    let mut words: Vec<String> = Vec::with_capacity(lengths.len());
    let mut at = 0;

    for length in lengths {
        let start = at.min(syllables.len());
        let end = (at + length).min(syllables.len());
        words.push(syllables[start..end].concat());
        at += length;
    }

    // The boundaries and the syllables come from different sources — jieba and
    // pinyin-pro — so they can disagree. Slicing on a wrong boundary would move a
    // syllable into the neighbouring word, which is audible and silent.
    if at != syllables.len() {
        return Err(PinyinError::WordBoundaries {
            covered: at,
            syllables: syllables.len(),
            text: context.to_string(),
        });
    }

    Ok(words.join(" "))
}

/// One segmentation candidate.
#[derive(Debug, Clone, Copy)]
struct State {
    probability: f64,
    /// How many times `probability` has been rescaled by `1e300`. Smaller is
    /// larger.
    decimal: i32,
    /// The pattern that starts here, if one was chosen.
    pattern: Option<Match>,
    /// Where the walk goes next.
    next_index: usize,
}

/// A phrase pattern the automaton matched.
#[derive(Debug, Clone, Copy)]
struct Match {
    /// The character index it starts at.
    start: usize,
    /// The character index it ends at, inclusive. `pinyin-pro` compares on this.
    end: usize,
    /// The readings, space-separated, in tone-number form.
    readings: &'static str,
    probability: f64,
}

/// `checkDecimal`: keep the probability out of the subnormal range.
///
/// Once, not in a loop, because that is what the original does — and it is
/// enough: every multiplication is by a value at least `1e-13`, so a single
/// rescale brings the result back above `1e-300`.
fn check_decimal(mut state: State) -> State {
    if state.probability < 1e-300 {
        state.probability *= 1e300;
        state.decimal += 1;
    }
    state
}

/// `getMaxProbability`: the better of two states.
///
/// Ties go to the candidate, and that is not a detail to tidy away: it decides
/// which of two equal-probability segmentations is read out, and the candidate
/// order is fixed by the loop above.
fn better(existing: Option<State>, candidate: State) -> State {
    match existing {
        None => candidate,
        Some(existing) => {
            if existing.decimal < candidate.decimal {
                existing
            } else if existing.decimal == candidate.decimal {
                if existing.probability > candidate.probability {
                    existing
                } else {
                    candidate
                }
            } else {
                candidate
            }
        }
    }
}

/// Fold a tone letter into the arrow Kokoro's tokenizer knows.
///
/// The order is forced: `˥` is a prefix of `˥˩`, so replacing it before `˥˩`
/// would turn every fourth tone into a first tone.
fn retone(ipa: &str) -> String {
    ipa.replace("˧˩˧", "↓")
        .replace("˧˥", "↗")
        .replace("˥˩", "↘")
        .replace("˥", "→")
}

/// The 一/不/了/々 rules, as data.
#[derive(Debug, Default)]
struct Special {
    /// `toneSandhiMap`: the reading 一/不 takes before each tone.
    sandhi: HashMap<char, Vec<(u8, Syllable)>>,
    /// The 叠词 reading, which has no tone at all.
    neutral: HashMap<char, Syllable>,
    /// The reading when no Chinese character comes before.
    default: HashMap<char, Syllable>,
    /// Followers that block the sandhi rules.
    ignored: HashSet<(char, char)>,
}

/// Every table, parsed once.
#[derive(Debug)]
struct Tables {
    /// `DICT1` inverted: a character's readings, space-separated.
    characters: HashMap<char, &'static str>,
    phrases: HashMap<&'static str, Pattern>,
    syllables: HashMap<&'static str, &'static str>,
    special: Special,
    /// The longest phrase, in characters. Bounds the suffix walk.
    max_phrase_chars: usize,
}

/// A phrase's readings and what it is worth.
#[derive(Debug)]
struct Pattern {
    readings: &'static str,
    probability: f64,
}

impl Tables {
    /// Parse the embedded data.
    ///
    /// **Panics on malformed data, deliberately.** The files are generated by
    /// `scripts/generate/gen-pinyin-pro-data.mjs` and its `--check` mode is what verifies
    /// them, so a broken one is a build error rather than a runtime condition;
    /// returning a `Result` would push a case that cannot happen through every
    /// caller. The tests construct these tables, so a malformed file fails there
    /// rather than in the wasm.
    fn load() -> Self {
        let characters = CHARACTERS
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| {
                let (character, readings) = line
                    .split_once(' ')
                    .unwrap_or_else(|| panic!("pinyin-chars.txt: no readings on {line:?}"));
                let mut characters = character.chars();
                let character = characters.next().expect("a character per line");
                assert!(
                    characters.next().is_none(),
                    "pinyin-chars.txt: {character:?} is more than one character"
                );
                (character, readings)
            })
            .collect::<HashMap<_, _>>();

        let phrases = PHRASES
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| {
                let (phrase, rest) = line
                    .split_once(' ')
                    .unwrap_or_else(|| panic!("pinyin-phrases.txt: no readings on {line:?}"));
                let (tag, readings) = rest
                    .split_once(' ')
                    .unwrap_or_else(|| panic!("pinyin-phrases.txt: no tag on {line:?}"));
                let probability = match tag {
                    "d" => PROBABILITY_DICT,
                    "r" => PROBABILITY_RULE,
                    other => panic!("pinyin-phrases.txt: unknown tag {other:?}"),
                };
                (
                    phrase,
                    Pattern {
                        readings,
                        probability,
                    },
                )
            })
            .collect::<HashMap<_, _>>();

        let syllables = SYLLABLES
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
            .map(|line| {
                let (syllable, ipa) = line
                    .split_once(' ')
                    .unwrap_or_else(|| panic!("pinyin-syllables.txt: no IPA on {line:?}"));
                (syllable, ipa)
            })
            .collect::<HashMap<_, _>>();

        let mut special = Special::default();
        for line in SPECIAL
            .lines()
            .filter(|line| !line.is_empty() && !line.starts_with('#'))
        {
            let fields: Vec<&str> = line.split(' ').collect();
            match fields.as_slice() {
                ["s", character, tone, reading] => special
                    .sandhi
                    .entry(only(character))
                    .or_default()
                    .push((tone.parse().expect("a tone number"), Syllable(reading))),
                ["n", character, reading] => {
                    special.neutral.insert(only(character), Syllable(reading));
                }
                ["d", character, reading] => {
                    special.default.insert(only(character), Syllable(reading));
                }
                ["x", character, follower] => {
                    special.ignored.insert((only(character), only(follower)));
                }
                other => panic!("pinyin-special.txt: cannot read {other:?}"),
            }
        }

        let max_phrase_chars = phrases
            .keys()
            .map(|phrase| phrase.chars().count())
            .max()
            .expect("the phrase table is not empty");

        Self {
            characters,
            phrases,
            syllables,
            special,
            max_phrase_chars,
        }
    }
}

/// The single character of a one-character field.
fn only(field: &str) -> char {
    let mut characters = field.chars();
    let character = characters.next().unwrap_or_else(|| panic!("empty field"));
    assert!(
        characters.next().is_none(),
        "{field:?} is more than one character"
    );
    character
}

/// The tables, shared by every `ChinesePinyin` in the process.
static TABLES: OnceLock<Tables> = OnceLock::new();
