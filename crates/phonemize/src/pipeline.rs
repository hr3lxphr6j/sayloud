//! The chain: text in, phonemes out.
//!
//! One function per `(frontend, lang)` pair today, because what a language needs
//! is what differs: [`phonemize_ja`] has a dictionary to segment with,
//! [`phonemize_en`] does not, and only [`phonemize_zh`] has word boundaries to
//! respect and a Latin run to hand to another language's engine. The steps around
//! those differences are the same on all three sides, and the order they run in is
//! the same too — see [`phonemize_ja`]. A later phase turns this into a dispatch
//! over the frontends.

use crate::backends::g2p_en::{EnglishError, EnglishG2p};
use crate::backends::numbers::numbers_to_kanji;
use crate::backends::numbers_en::numbers_to_english;
use crate::backends::numbers_zh::numbers_to_han;
use crate::backends::pinyin::{ChinesePinyin, PinyinError};
use crate::backends::segmenter_ja::{SegmenterError, SegmenterJa};
use crate::backends::segmenter_zh::{SegmenterZh, SegmenterZhError};
use crate::backends::zh_text::{self, ZhRun};
use crate::frontends::ja_ipa::{fix_numeral_sound_changes, kana_to_ipa};
use crate::text::{
    collapse_whitespace, keep_punctuation, normalize_punctuation, segment_text, ScriptRun,
};

/// Why text could not be turned into phonemes.
#[derive(Debug)]
pub enum PipelineError {
    /// The Japanese segmenter failed.
    Segmenter(SegmenterError),
    /// The Chinese segmenter failed.
    ZhSegmenter(SegmenterZhError),
    /// The Chinese readings or the word grouping failed.
    Pinyin(PinyinError),
    /// The English backend failed.
    English(EnglishError),
}

impl PipelineError {
    /// A stable code for the JavaScript side.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Segmenter(error) => error.code(),
            Self::ZhSegmenter(error) => error.code(),
            Self::Pinyin(error) => error.code(),
            Self::English(error) => error.code(),
        }
    }
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Segmenter(error) => write!(f, "{error}"),
            Self::ZhSegmenter(error) => write!(f, "{error}"),
            Self::Pinyin(error) => write!(f, "{error}"),
            Self::English(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for PipelineError {}

impl From<SegmenterError> for PipelineError {
    fn from(error: SegmenterError) -> Self {
        Self::Segmenter(error)
    }
}

impl From<SegmenterZhError> for PipelineError {
    fn from(error: SegmenterZhError) -> Self {
        Self::ZhSegmenter(error)
    }
}

impl From<PinyinError> for PipelineError {
    fn from(error: PinyinError) -> Self {
        Self::Pinyin(error)
    }
}

impl From<EnglishError> for PipelineError {
    fn from(error: EnglishError) -> Self {
        Self::English(error)
    }
}

/// Phonemes, and what was left out to get them.
///
/// The warnings are the second half of the answer rather than a log line,
/// because everything they describe is audible: a word the English dictionary
/// does not have is dropped, and a dropped word is the failure mode this
/// pipeline exists to avoid. Nothing here is fatal — a sentence with one word
/// missing still plays — so they travel with the result instead of being
/// returned as an error, and the JavaScript side decides what to do with them.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Phonemized {
    /// Exactly what goes into the tokenizer.
    pub phonemes: String,
    /// One entry per run that produced no phonemes.
    pub warnings: Vec<String>,
}

/// Japanese text to IPA, for the v1.0 frontend.
///
/// The order of the first four steps is load-bearing:
///
/// 1. **Punctuation first**, because it decides where the pauses are and because
///    the comma-to-period rewrite has to happen before anything reads the text
///    as words.
/// 2. **Numerals before segmentation**, not after: a digit belongs to no script
///    the segmenter knows, so it would land in the `other` run and be dropped as
///    punctuation — unheard, and silently. Reading them as kanji here also keeps
///    a numeral in the same Han run as what it counts, which is what decides how
///    that reads (「年」 alone is とし, 「二十二年」 is ネン).
/// 3. **Then split into script runs**, because each run takes a different route.
/// 4. **Then read each run out as katakana** and map that to IPA.
///
/// # Latin runs go to the English dictionary
///
/// A `Latin` run is one alphabetic word — `segment_text` sends every space and
/// every apostrophe to an `other` run — and it is phonemized by `english`, which
/// spells it out when it is all capitals and looks it up otherwise. Phase 3
/// passed these runs through as characters, which was the right answer only
/// while there was no English engine to hand them to.
///
/// **A word the English dictionary does not have is dropped, and warned about.**
/// That is a deliberate trade and a narrower one than it looks: an initialism
/// cannot be dropped, because it is read from single letters and all 26 letters
/// are in the dictionary, so what is lost is a mixed-case proper noun that CMU
/// Dict has never heard of — `Kokoro`, `OpenAI`, `GitHub`, `ChatGPT`. espeak
/// would have invented a pronunciation for those; inventing one is also how it
/// reads `RAG` as the word "rag". Phase 3 chose the other side of this trade for
/// Latin runs in general (wrong audio is easier to notice than missing audio)
/// and the reason still holds for the words that reach it — so if a dropped word
/// ever turns out to matter, the change is to push `run_text` through instead of
/// warning, not to reach for a rule engine.
///
/// `english` is `None` when the backend could not be built at all, which is a
/// broken build rather than a normal state: the dictionary is compiled in. It is
/// still not fatal here, because one unusable English word must not cost the
/// user the Japanese sentence around it.
pub fn phonemize_ja(
    text: &str,
    segmenter: &SegmenterJa,
    english: Option<&EnglishG2p>,
) -> Result<Phonemized, PipelineError> {
    let normalized = normalize_punctuation(text);
    let with_numerals = numbers_to_kanji(&normalized);
    let runs = segment_text(&with_numerals);

    let mut parts: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for run in &runs {
        match run {
            ScriptRun::Han(run_text) | ScriptRun::Kana(run_text) => {
                // The numeral sound changes are applied to the whole run rather
                // than to each word, because that is where they apply: 三百 is
                // two words to the dictionary and one sound change to the
                // language.
                let katakana = segmenter.read_as_katakana(run_text)?;
                parts.push(kana_to_ipa(&fix_numeral_sound_changes(&katakana)));
            }
            ScriptRun::Latin(run_text) => {
                let phonemes = match english {
                    Some(english) => english.phonemize(run_text)?,
                    None => String::new(),
                };

                if phonemes.is_empty() {
                    warnings.push(no_pronunciation(run_text));
                } else {
                    parts.push(phonemes);
                }
            }
            ScriptRun::Other(run_text) => parts.push(keep_punctuation(run_text)),
        }
    }

    Ok(Phonemized {
        phonemes: collapse_whitespace(&parts.concat()),
        warnings,
    })
}

/// English text to IPA, for the v1.0 frontend.
///
/// The same four steps as [`phonemize_ja`], in the same order and for the same
/// reasons:
///
/// 1. **Normalize punctuation**.
/// 2. **Expand numerals before segmentation.** A digit belongs to no script the
///    segmenter knows, so it would land in the `other` run and be dropped as
///    punctuation — unheard, and silently. [`numbers_to_english`] is the step
///    that keeps `I have 3 cats` from losing the 3, and it is why this function
///    could not be written before it: the CMU dictionary skips a digit rather
///    than reading it, so a whole English sentence used to be a regression
///    against espeak, which reads the number out.
/// 3. **Then split into script runs.**
/// 4. **Then read each run out.** A `Latin` run goes to `english`, and an `other`
///    run keeps only the punctuation Kokoro can use.
///
/// # What is dropped
///
/// A `Han` or `Kana` run is dropped rather than read: this is the English
/// pipeline, so `hello 世界` is English text with a word in a script this
/// frontend has no reading for, and a character Kokoro cannot use is worth less
/// than the sentence around it. Nothing else here is silent — a word the CMU
/// dictionary does not have is spelled out letter by letter rather than dropped
/// (see [`EnglishG2p::phonemize`]).
///
/// # Known gap: an apostrophe splits a word
///
/// `segment_text` sends `'` and `-` to an `other` run, so `don't` reaches the
/// dictionary as `don` and `t`, and the `t` is then read as the letter
/// (`dˈɑn'tˈiː`). A hyphen has the same shape and a benign outcome — `well-known`
/// is read as the two words it is made of — but a contraction is one word and is
/// not. Neither can show up in the Latin runs of a Japanese sentence, where a run
/// is one word by construction, so a whole English sentence is what exposes it.
/// The fix belongs in the shared segmenter and not here: the Japanese side splits
/// on the same rule, and the two have to agree on what a run is before their
/// output can be compared.
///
/// `english` is `None` when the backend could not be built at all, which is a
/// broken build rather than a normal state: the dictionary is compiled in. It is
/// still not fatal here, because one unusable English word must not cost the
/// user the sentence around it.
pub fn phonemize_en(text: &str, english: Option<&EnglishG2p>) -> Result<Phonemized, PipelineError> {
    let normalized = normalize_punctuation(text);
    let with_numerals = numbers_to_english(&normalized);
    let runs = segment_text(&with_numerals);

    let mut parts: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for run in &runs {
        match run {
            ScriptRun::Latin(run_text) => {
                let phonemes = match english {
                    Some(english) => english.phonemize(run_text)?,
                    None => String::new(),
                };

                if phonemes.is_empty() {
                    warnings.push(no_pronunciation(run_text));
                } else {
                    parts.push(phonemes);
                }
            }
            ScriptRun::Other(run_text) => parts.push(keep_punctuation(run_text)),
            ScriptRun::Han(_) | ScriptRun::Kana(_) => {}
        }
    }

    Ok(Phonemized {
        phonemes: collapse_whitespace(&parts.concat()),
        warnings,
    })
}

/// Chinese text to IPA, for the v1.0 frontend.
///
/// The same four steps as [`phonemize_ja`], in the same order and for the same
/// reasons, with one of them doing more work:
///
/// 1. **Numerals first.** [`numbers_to_han`] turns `123` into 一百二十三 before
///    anything looks at the text, because a digit belongs to no script the
///    segmenter knows: it would land in an `other` run and be dropped as
///    punctuation — unheard, and silently. The JavaScript applies it in the same
///    place, inside the punctuation call: `mapPunctuation(numbersToHan(text))`.
/// 2. **Then punctuation**, [`zh_text::map_punctuation`], which is where the
///    pauses come from. It is not [`normalize_punctuation`]: `chinese.ts` maps
///    the quotation marks to `“ ”` where `common.ts` maps them to `"`, and the
///    tokenizer has all three, so this is a different phoneme string and not a
///    cosmetic one.
/// 3. **Then split into runs** — but with [`zh_text::split_runs`], not
///    [`segment_text`]. The two disagree about `〇` and about kana, and the
///    Chinese one is the one the JavaScript uses; see that module for which
///    difference is audible.
/// 4. **Then read each run out.**
///
/// # A Han run is read a word at a time
///
/// The syllables are [`ChinesePinyin`]'s, one per character, and the *boundaries*
/// between them are [`SegmenterZh`]'s. Both are needed: misaki writes one space
/// between words and Kokoro was trained on that, so one space per syllable made
/// the model pause inside words (人设, 曾经). A mismatch between the two — the
/// segmenter dropping a character, or the syllable table missing one — is refused
/// rather than guessed at, because either would move a syllable into the
/// neighbouring word.
///
/// # Latin runs go to the English engine, not to espeak
///
/// This is the one place the Rust pipeline deliberately does not reproduce the
/// JavaScript. `chinese.ts` sends a Latin run to espeak, spelled out letter by
/// letter when it is all capitals; this sends it to [`EnglishG2p`], which is CMU
/// Dict plus a spelling rule, for the reasons phase 4 recorded. The two agree on
/// initialisms and can disagree on a mixed-case word espeak would have invented a
/// pronunciation for — which is the trade phase 4 chose on purpose, and it applies
/// here unchanged because it is the same backend the Japanese pipeline already
/// uses for the same runs. A word the dictionary does not have is dropped and
/// warned about, not silently skipped.
///
/// # Whitespace
///
/// [`zh_text::keep_punctuation`] does **not** trim: the runs are concatenated
/// with nothing between them, so a space that `map_punctuation` put after a comma
/// is the only thing separating it from the next word. The single
/// [`collapse_whitespace`] at the end handles the ends of the sentence — which is
/// also what `ChinesePhonemizer.phonemize` does, in the same order.
///
/// `english` is `None` when the backend could not be built at all, which is a
/// broken build rather than a normal state; see [`phonemize_ja`] for why that is a
/// warning and not a failure.
pub fn phonemize_zh(
    text: &str,
    segmenter: &SegmenterZh,
    english: Option<&EnglishG2p>,
) -> Result<Phonemized, PipelineError> {
    let with_numerals = numbers_to_han(text);
    let mapped = zh_text::map_punctuation(&with_numerals);
    let runs = zh_text::split_runs(&mapped);

    let chinese = ChinesePinyin::new();
    let mut parts: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    for run in &runs {
        match run {
            ZhRun::Han(run_text) => {
                // The boundaries first, so that a segmenter that lost a character
                // is reported as that rather than as the syllable table missing
                // one — the same order the JavaScript checks them in.
                let lengths = segmenter.word_lengths(run_text)?;
                parts.push(chinese.han_to_ipa_by_words(run_text, &lengths)?);
            }
            ZhRun::Latin(run_text) => {
                let phonemes = match english {
                    Some(english) => english.phonemize(run_text)?,
                    None => String::new(),
                };

                if phonemes.is_empty() {
                    warnings.push(no_pronunciation(run_text));
                } else {
                    parts.push(phonemes);
                }
            }
            ZhRun::Other(run_text) => parts.push(zh_text::keep_punctuation(run_text)),
        }
    }

    Ok(Phonemized {
        phonemes: collapse_whitespace(&parts.concat()),
        warnings,
    })
}

/// What the caller is told about a run that produced nothing.
///
/// The word is in the message because that is the only part a reader can act on
/// — it is the word to add to a dictionary, or the word that came out missing.
/// The wording is stable so a test can look for it, and it names the language
/// rather than the mechanism: which engine had no entry is an implementation
/// detail, and the user is looking at an English word in a sentence.
fn no_pronunciation(run: &str) -> String {
    format!("no English pronunciation for {run:?}")
}
