//! The chain: text in, phonemes out.
//!
//! One function per `(frontend, lang)` pair today, because what a language needs
//! is what differs: [`phonemize_ja`] has a dictionary to segment with,
//! [`phonemize_en`] does not, and only [`phonemize_zh`] has word boundaries to
//! respect and a Latin run to hand to another language's engine. The steps around
//! those differences are the same on all three sides, and the order they run in is
//! the same too — see [`phonemize_ja`]. A later phase turns this into a dispatch
//! over the frontends.
//!
//! Since phase 9E all three share one step that used to be three: the numeral
//! reader is [`numerals`], which runs the vendored WeText engine when one was
//! built and the language's hand-written reader when one was not. What is left
//! language-specific about it is *where* in the sequence it runs and what the
//! fallback is.

use std::borrow::Cow;

use crate::backends::g2p_en::{EnglishError, EnglishG2p};
use crate::backends::numbers::numbers_to_kanji;
use crate::backends::numbers_en::numbers_to_english;
use crate::backends::numbers_zh::numbers_to_han;
use crate::backends::pinyin::{ChinesePinyin, PinyinError};
use crate::backends::segmenter_ja::{SegmenterError, SegmenterJa};
use crate::backends::segmenter_zh::{SegmenterZh, SegmenterZhError};
use crate::backends::tn_gate;
use crate::backends::tone_sandhi;
use crate::backends::wetext::Normalizer as WeTextNormalizer;
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
/// because everything they describe is audible: a run that produced no phonemes
/// contributes nothing to the sentence, and a missing word is the failure mode
/// this pipeline exists to avoid. Nothing here is fatal — a sentence with one
/// word missing still plays — so they travel with the result instead of being
/// returned as an error, and the JavaScript side decides what to do with them.
///
/// **An English warning is all but unreachable, and that is phase 9A's doing.**
/// A Latin run now has three chances — the CMU dictionary, the NRL 7948 rules, and
/// the letters, all 26 of which are in the dictionary — so producing nothing takes
/// a run whose every letter is absent from all three. The channel is kept because
/// that is the honest answer for one, and because the other two languages drop
/// runs routinely (a `Han` run in an English sentence).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Phonemized {
    /// Exactly what goes into the tokenizer.
    pub phonemes: String,
    /// One entry per run that produced no phonemes.
    pub warnings: Vec<String>,
}

/// Whether the numeral step consults [`tn_gate`] before the engine.
///
/// Two values, and the difference between them is not a preference. English's
/// `should_normalize` is deliberately **not** gated on digits (modification 5 in
/// `crate::backends::wetext::NOTICE`), so the engine is entered for every English
/// sentence whatever it contains — the gate is what keeps 4.6 ms per 100
/// characters off the sentences that have nothing for it. Chinese's and
/// Japanese's `should_normalize` *is* the digit test, so an outer gate could only
/// be a second opinion about a question the engine already answers, and the two
/// disagreeing would either cost time or lose a reading. The reasoning is
/// [`crate::backends::wetext_tn`]'s; this is how it reaches the pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gate {
    /// Ask [`tn_gate::needs_normalization`] first, and skip the engine on a
    /// `false`. English only.
    CheapSkip,
    /// Go straight to the engine; its own `should_normalize` decides.
    EngineDecides,
}

/// The numeral step: WeText when it was built, `fallback` when it was not.
///
/// `text` is the text as the step's caller wants the engine to see it — for
/// Chinese that is the raw sentence, for Japanese the punctuation-mapped one,
/// because that is the order each pipeline has always run its steps in.
///
/// Three ways the engine is not used, and none of them is a silent wrong answer:
///
/// - it was never built (`None`), which is the caller that never called
///   `prepare` and the build whose assets were not fetched;
/// - the gate says there is nothing here for it, which is only reachable when
///   [`Gate::CheapSkip`] was asked for;
/// - it failed on this sentence. The engine can fail — a composition that will
///   not build, a grammar that cannot produce a path — and one unreadable
///   sentence is not worth the sentence around it. `fallback` is what the
///   pipeline did before the engine arrived: a worse reading of a date, not a
///   missing one.
fn numerals<'a>(
    text: &'a str,
    tn: Option<&WeTextNormalizer>,
    gate: Gate,
    fallback: impl Fn(&str) -> String,
) -> Cow<'a, str> {
    match tn {
        Some(tn) if gate == Gate::EngineDecides || tn_gate::needs_normalization(text) => {
            let normalized = tn.normalize(text).unwrap_or_else(|_| fallback(text));
            Cow::Owned(fix_one_thousand_bug(&normalized))
        }
        // The engine is there and the gate says there is nothing here for it.
        // Skipping is then the same as running it, because `fallback` is a no-op
        // on text with no digit in it and `tn_gate` only returns `false` for text
        // whose digits the tagger would have passed through. `tests/tn_gate.rs`
        // asserts that rather than assuming it.
        Some(_) => Cow::Borrowed(text),
        // No engine was built at all.
        None => Cow::Owned(fallback(text)),
    }
}

/// Fix WeText 0.1.8 bug where 1,000-1,999 lose the leading "one".
///
/// WeText's English verbalizer has a bug in the 1,000-1,999 range: it produces
/// "thousand two hundred and thirty four" instead of "one thousand two hundred
/// and thirty four". This is documented in
/// `docs/superpowers/plans/p6-1nnn-bug-research.md` and affects only this range.
///
/// Examples:
/// - "thousand" → "one thousand"
/// - "thousand two hundred" → "one thousand two hundred"
/// - "two thousand" → "two thousand" (unchanged)
/// - "a thousand people" → "a thousand people" (unchanged)
///
/// The fix is applied as post-processing after normalization to avoid forking
/// the upstream FST grammars.
fn fix_one_thousand_bug(text: &str) -> String {
    // Case 1: exactly "thousand" (e.g., "1,000")
    if text == "thousand" {
        return "one thousand".to_string();
    }

    // Case 2: starts with "thousand " (most common)
    if text.starts_with("thousand ") {
        return format!("one {}", text);
    }

    // Case 3: "thousand " or " thousand" appears in the middle
    if let Some(idx) = text.find(" thousand") {
        let (before, after) = text.split_at(idx);
        let prev_word = before.split_whitespace().last().unwrap_or("");

        // Don't fix if preceded by a number word or "a"
        let number_words = [
            "one",
            "two",
            "three",
            "four",
            "five",
            "six",
            "seven",
            "eight",
            "nine",
            "ten",
            "eleven",
            "twelve",
            "thirteen",
            "fourteen",
            "fifteen",
            "sixteen",
            "seventeen",
            "eighteen",
            "nineteen",
            "twenty",
            "thirty",
            "forty",
            "fifty",
            "sixty",
            "seventy",
            "eighty",
            "ninety",
            "hundred",
            "a",
        ];

        if !number_words.contains(&prev_word) {
            return format!("{} one{}", before, after);
        }
    }

    text.to_string()
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
///
///    Since phase 9E the reading is usually [`wetext_tn::japanese`]'s rather than
///    [`numbers_to_kanji`]'s, and it is applied to the punctuation-mapped text —
///    the order above is what it has always been, so the grammar sees `,` where
///    the source had `、`. That is not the Python reference's input, and it is
///    the one place this pipeline departs from it; the readings are pinned in
///    `tests/wetext_ja.rs` and the whole-pipeline effect in `tests/ja_pipeline.rs`.
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
/// **A mixed-case word the English dictionary does not have is read by rule.**
/// Phase 4 spelled those out (`Kokoro` → K-O-K-O-R-O) and that was the trade then:
/// espeak would have invented a pronunciation, and inventing one is how it reads
/// `RAG` as the word "rag". Phase 9A takes the middle road — the letter-to-sound
/// rules of NRL Report 7948, which HeadTTS uses for the same job
/// ([`headtts_en`](crate::backends::headtts_en)) — so the run is neither dropped
/// nor spelled. An initialism is still spelled and still cannot be dropped: it is
/// read from single letters, and all 26 of them are in the dictionary.
///
/// `english` is `None` when the backend could not be built at all, which is a
/// broken build rather than a normal state: the dictionary is compiled in. It is
/// still not fatal here, because one unusable English word must not cost the
/// user the Japanese sentence around it.
///
/// `tn` is the vendored WeText engine, built by `finish_loading` from the two
/// grammars the dictionary protocol fetched ([`wetext_tn::japanese`]). It is
/// optional for the reason [`crate::backends::wetext_tn`] gives, and its absence
/// falls back to [`numbers_to_kanji`].
pub fn phonemize_ja(
    text: &str,
    segmenter: &SegmenterJa,
    english: Option<&EnglishG2p>,
    tn: Option<&WeTextNormalizer>,
) -> Result<Phonemized, PipelineError> {
    let normalized = normalize_punctuation(text);
    let with_numerals = numerals(&normalized, tn, Gate::EngineDecides, numbers_to_kanji);
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
/// reasons, with the numeral step done by a weighted-FST engine when one is
/// available:
///
/// 1. **Normalize punctuation**.
/// 2. **Expand numerals before segmentation.** A digit belongs to no script the
///    segmenter knows, so it would land in the `other` run and be dropped as
///    punctuation — unheard, and silently. This is the step that keeps `I have 3
///    cats` from losing the 3, and it is why this function could not be written
///    before it: the CMU dictionary skips a digit rather than reading it, so a
///    whole English sentence used to be a regression against espeak, which reads
///    the number out.
/// 3. **Then split into script runs.**
/// 4. **Then read each run out.** A `Latin` run goes to `english`, and an `other`
///    run keeps only the punctuation Kokoro can use.
///
/// # Numerals: WeText when it is there, `numbers_to_english` when it is not
///
/// `tn` is the vendored WeText engine, built by `finish_loading` from the two
/// grammars the dictionary protocol fetched ([`crate::backends::wetext_tn`]).
/// Phase 9B added it because the hand-written reader is not a reader of
/// anything but a number: it produced the letters `T H I R T Y P M` for `3:30pm`,
/// dropped the `%` of `50%` entirely, and turned `1st` into an "onest". The
/// engine reads all of those — and dates, money and abbreviations with them — as
/// the entities they are.
///
/// **It read bare integers wrong until phase 9B.4, and that was this copy's
/// bug, not the grammar's.** An unqualified `123` came out `one two three`,
/// which was written up as the engine choosing between equal-cost readings. It
/// was not: the grammar's cheapest reading is `one hundred and twenty three`,
/// and `rustfst::shortest_path` — which assumes non-negative arc weights and
/// these grammars have `-0.0001` ones — was returning a more expensive path.
/// `src/backends/wetext/text_normalizer.rs` now computes the true minimum, and
/// `docs/superpowers/plans/p6-9b4-shortest-path-bug.md` is the write-up.
/// `1000` is still `ten hundred`, and that one *is* the grammar: the tagger reads
/// it as a year, where `ten hundred` and `one thousand` cost the same and the
/// Python reference picks `ten hundred` too. `tests/wetext_en.rs` pins the
/// readings, and `src/backends/wetext/README.md` has the tables.
///
/// It is **optional** on purpose. English is the one language whose phonemes
/// need no dictionary, so `phonemize_with` deliberately does not require
/// `prepare` for it; making the numeral step fatal without one would turn that
/// into an error for a caller that never had to care. Three cases reach the
/// fallback and none of them is a silent wrong answer: no engine was built
/// (nothing was prepared), the engine could not be built, or it failed on this
/// sentence. `numbers_to_english` is what this pipeline did before phase 9B —
/// a worse reading of a date, not a missing one.
///
/// # The gate, and why it is in front of the engine
///
/// [`tn_gate::needs_normalization`] decides whether the engine is consulted at
/// all, and a `false` means the text goes on unchanged. The reason is speed and
/// only speed: the tagger FST is 92% of the engine's cost and upstream's English
/// TN runs it on every sentence whatever the sentence contains
/// (`should_normalize` applies its digit test only to the other two languages).
/// Measured, the gate is 2.8 µs for 950 characters against 43 ms for the
/// composition it skips.
///
/// **It is a filter, not a second opinion about what needs normalizing**, and
/// `tests/tn_gate.rs` is what keeps it from becoming one: a skip has to imply
/// that the tagger found nothing but its two pass-through classes, that the whole
/// engine would have returned the text unchanged, and that the phonemes do not
/// depend on whether the engine was asked. Where it is still wrong — the
/// grammar's whitelist is 3,050 strings with no shape to recognise — the plan
/// measures it (`docs/superpowers/plans/p6-9b6-tn-gate.md` §四).
///
/// # What is dropped
///
/// A `Han` or `Kana` run is dropped rather than read: this is the English
/// pipeline, so `hello 世界` is English text with a word in a script this
/// frontend has no reading for, and a character Kokoro cannot use is worth less
/// than the sentence around it. Nothing else here is silent: a word the CMU
/// dictionary does not have is read by the NRL 7948 rules, and spelled out letter
/// by letter only if those read it as a consonant cluster with no vowel
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
pub fn phonemize_en(
    text: &str,
    english: Option<&EnglishG2p>,
    tn: Option<&WeTextNormalizer>,
) -> Result<Phonemized, PipelineError> {
    let normalized = normalize_punctuation(text);
    let with_numerals = numerals(&normalized, tn, Gate::CheapSkip, numbers_to_english);
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

/// Whether the Mandarin tone rules run, for [`phonemize_zh`].
///
/// # Why this is a parameter and not a constant
///
/// The rules are phase 9D and they move the Chinese output away from what the
/// JavaScript frontend produced, on purpose. That old output is what the P5
/// listening tests were run against, and the parity corpus in
/// `crates/phonemize/tests/fixtures/zh-frontend-parity.json` is the JavaScript
/// string for 47 sentences — so there has to be a way to produce it again, or
/// the corpus stops being a test of anything and the change stops being
/// reversible. [`ToneRules::Off`] is that way, and it is the phase 6 pipeline
/// exactly.
///
/// **P5 §1.5 argues for `Off` on the v1.0 voices and against it on v1.1-zh**, and
/// the choice is the caller's because only the caller knows which voice is
/// playing:
///
/// > 我们用的是 v1.0 的 IPA tokenizer … v1.0 的 8 个中文音色在官方 `VOICES.md` 里
/// > 评级 D，训练时用的 G2P 就是 misaki 的 legacy 路径——那条路径本身不做变调、
/// > 不做儿化。模型学到的映射是「原调音素序列 → 实际变调的音频」。我们加变调/儿化
/// > 等于偏离训练分布。
///
/// The counter-evidence is in the same spec: §1.6 measured that changing a tone
/// arrow changes pitch by a few Hz, and §1.2 C left the 一/不 sandhi the G2P
/// already applies switched on. `lib.rs` passes `On` today — the user asked for
/// these rules in production — and the A/B is a one-word change there.
///
/// **No `Default`.** There is no default: `On` for the v1.0 voices is a decision
/// with an argument against it, and `#[derive(Default)]` is how that argument
/// gets lost. Every caller names one of the two.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ToneRules {
    /// Apply the third-tone, 一/不, neutral-tone and erhua rules.
    On,
    /// Read the tones `pinyin-pro` gives, one tone per character.
    Off,
}

impl ToneRules {
    /// Whether these are the rules that run.
    pub fn are_on(self) -> bool {
        matches!(self, Self::On)
    }
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
///
///    Since phase 9E the reading is usually [`wetext_tn::chinese`]'s instead,
///    applied to the same raw text — so a *year* is read digit by digit
///    (`2024年` is 二零二四年, which is how it is said) where `numbers_to_han`
///    reads it as a quantity (二千零二十四年). The engine trims, which
///    `numbers_to_han` deliberately does not; that is invisible here, because
///    [`zh_text::keep_punctuation`] keeps whitespace and
///    [`collapse_whitespace`] is what removes it, at the end either way.
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
/// # A Han run is read a word at a time, and its tones are decided twice
///
/// The syllables are [`ChinesePinyin`]'s, one per character, and the *boundaries*
/// between them are [`SegmenterZh`]'s. Both are needed: misaki writes one space
/// between words and Kokoro was trained on that, so one space per syllable made
/// the model pause inside words (人设, 曾经). A mismatch between the two — the
/// segmenter dropping a character, or the syllable table missing one — is refused
/// rather than guessed at, because either would move a syllable into the
/// neighbouring word.
///
/// `tone_rules` is phase 9D, and it is the second decision about a tone: the
/// first is one per character from `pinyin-pro`, and the second is
/// [`tone_sandhi`], which reads the words and the tags jieba gave them and
/// rewrites the tones that Mandarin does not pronounce as written (`你好` is
/// *ní hǎo*) and drops the 儿 of 玩儿 into the syllable before it. It also decides
/// the *words*, because the reference merges words first and a merged word is a
/// merged word in the spacing too. `ToneRules::Off` is the pipeline before that
/// layer and nothing else; see [`ToneRules`] for why both exist.
///
/// # Latin runs go to the English engine, not to espeak
///
/// This is the one place the Rust pipeline deliberately does not reproduce the
/// JavaScript. `chinese.ts` sends a Latin run to espeak, spelled out letter by
/// letter when it is all capitals; this sends it to [`EnglishG2p`], which is CMU
/// Dict plus a reading rule, for the reasons phase 4 recorded. The two agree on
/// initialisms and can disagree on a mixed-case word — which is the trade phase 4
/// chose on purpose, and phase 9A narrowed rather than removed, because both sides
/// are now reading a word the dictionary does not have instead of one of them
/// spelling it. A run that produces nothing at all is warned about, not silently
/// skipped.
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
/// warning and not a failure. `tn` is the vendored WeText engine
/// ([`wetext_tn::chinese`]), optional for the reason that module gives — and
/// `None` is what makes this function the phase 6 pipeline, which is what the
/// JavaScript parity corpus in `tests/zh_pipeline.rs` is asserted against.
pub fn phonemize_zh(
    text: &str,
    segmenter: &SegmenterZh,
    english: Option<&EnglishG2p>,
    tone_rules: ToneRules,
    tn: Option<&WeTextNormalizer>,
) -> Result<Phonemized, PipelineError> {
    let with_numerals = numerals(text, tn, Gate::EngineDecides, numbers_to_han);
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
                // one — the same order the JavaScript checks them in. The
                // unreadable characters are the second question and are asked by
                // `complete_readings`, which is where the phase 6 pipeline asked
                // it too; the tone rules need the readings in hand, so on that
                // path it cannot be asked from inside the syllable lookup.
                //
                // The two branches ask different segmenter methods, and that is
                // deliberate rather than incidental: `Off` must be the phase 6
                // pipeline byte for byte, and that pipeline took its boundaries
                // from `word_lengths`. `On` needs the tags, and takes them from
                // the same call. `SegmenterZh` asserts the two agree.
                let phonemes = if tone_rules.are_on() {
                    let words = segmenter.tagged_words(run_text)?;
                    let readings = chinese.complete_readings(run_text)?;
                    let plan = tone_sandhi::plan(run_text, &words, &readings, segmenter);
                    chinese.syllables_to_ipa_by_words(
                        &plan.syllables,
                        &plan.word_lengths,
                        run_text,
                    )?
                } else {
                    let lengths = segmenter.word_lengths(run_text)?;
                    chinese.han_to_ipa_by_words(run_text, &lengths)?
                };
                parts.push(phonemes);
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
