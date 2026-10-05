//! Text normalization: text in, text out.
//!
//! The first stage of the pipeline, and the only one that is not per language:
//! the numeral step is the vendored WeText engine ([`wetext`]) for every language
//! that has one, and the hand-written readers in [`readers`] are what a caller
//! that never called `prepare` gets instead. What differs per language is only
//! *which* reader stands in, *whether* the engine is asked about a sentence at
//! all, and *what* the language does to the engine's answer afterwards — so all
//! three are properties of [`Lang`] rather than parameters a caller supplies.
//!
//! Nothing here knows what a phoneme is: the stage after this one is the one that
//! turns this text into phonemes.

pub mod engine;
pub mod gate;
pub mod readers;
pub mod wetext;

pub use engine::{chinese, english, japanese};
pub use gate::needs_normalization;
pub use readers::{
    en::numbers_to_english,
    ja::{int_to_kanji, numbers_to_kanji},
    zh::numbers_to_han,
};
pub use wetext::{FstTextNormalizer, Normalizer, WeTextError};

use std::borrow::Cow;

/// Which language's numerals are being read.
///
/// The three things that differ per language are methods here rather than
/// arguments to [`normalize`], because they are correlated and a caller that has
/// the language in hand has no business choosing them separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ja,
    Zh,
    En,
}

impl Lang {
    /// The hand-written reader this language used before the engine arrived.
    ///
    /// Not a fallback in the "something went wrong" sense: it is what a caller
    /// that never called `prepare` gets, and it is the phase 6 pipeline that the
    /// JavaScript parity corpora are pinned against. A worse reading of a date,
    /// not a missing one.
    fn fallback(self, text: &str) -> String {
        match self {
            Self::Ja => numbers_to_kanji(text),
            Self::Zh => numbers_to_han(text),
            Self::En => numbers_to_english(text),
        }
    }

    /// Whether the engine's own digit test is enough, or a gate has to look first.
    ///
    /// English's `should_normalize` is deliberately **not** gated on digits
    /// (modification 5 in `wetext::NOTICE`), so the engine is entered for every
    /// English sentence whatever it contains — the gate is what keeps 4.6 ms per
    /// 100 characters off the sentences that have nothing for it. Chinese's and
    /// Japanese's `should_normalize` *is* the digit test, so an outer gate there
    /// could only be a second opinion about a question the engine already
    /// answers, and the two disagreeing would either cost time or lose a reading.
    /// See [`crate::tn::engine`] for the reasoning.
    fn gate(self) -> Gate {
        match self {
            Self::En => Gate::CheapSkip,
            Self::Ja | Self::Zh => Gate::EngineDecides,
        }
    }

    /// What this language does to the engine's answer before the text moves on.
    ///
    /// Only English has something to do; see [`fix_one_thousand_bug`].
    fn postprocess(self, normalized: String) -> String {
        match self {
            Self::En => fix_one_thousand_bug(&normalized),
            Self::Ja | Self::Zh => normalized,
        }
    }
}

/// Whether [`normalize`] consults [`gate`] before the engine.
///
/// Two values, and the difference between them is not a preference — it is
/// [`Lang::gate`]'s answer about the grammar in question.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Gate {
    /// Ask [`gate::needs_normalization`] first, and skip the engine on a `false`.
    /// English only.
    CheapSkip,
    /// Go straight to the engine; its own `should_normalize` decides.
    EngineDecides,
}

/// The numeral step: WeText when it was built, the language's reader when it was not.
///
/// `text` is the text as the stage's caller wants the engine to see it — for
/// Chinese that is the raw sentence, for Japanese the punctuation-mapped one,
/// because that is the order each pipeline has always run its steps in.
///
/// Three ways the engine is not used, and none of them is a silent wrong answer:
///
/// - it was never built (`None`), which is the caller that never called
///   `prepare` and the build whose assets were not fetched;
/// - the gate says there is nothing here for it, which is only reachable for
///   English;
/// - it failed on this sentence. The engine can fail — a composition that will
///   not build, a grammar that cannot produce a path — and one unreadable
///   sentence is not worth the sentence around it. The language's reader is what
///   the pipeline did before the engine arrived.
pub fn normalize<'a>(text: &'a str, lang: Lang, engine: Option<&Normalizer>) -> Cow<'a, str> {
    match engine {
        Some(engine) if lang.gate() == Gate::EngineDecides || gate::needs_normalization(text) => {
            let normalized = engine
                .normalize(text)
                .unwrap_or_else(|_| lang.fallback(text));
            Cow::Owned(lang.postprocess(normalized))
        }
        // The engine is there and the gate says there is nothing here for it.
        // Skipping is then the same as running it, because the reader is a no-op
        // on text with no digit in it and `gate` only returns `false` for text
        // whose digits the tagger would have passed through. `tests/tn_gate.rs`
        // asserts that rather than assuming it.
        Some(_) => Cow::Borrowed(text),
        // No engine was built at all.
        None => Cow::Owned(lang.fallback(text)),
    }
}

/// Fix WeText 0.1.8's bug where 1,000-1,999 lose the leading "one".
///
/// WeText's English verbalizer has a bug in the 1,000-1,999 range: it produces
/// "thousand two hundred and thirty four" instead of "one thousand two hundred
/// and thirty four". It affects only this range.
///
/// Examples:
/// - "thousand" → "one thousand"
/// - "thousand two hundred" → "one thousand two hundred"
/// - "two thousand" → "two thousand" (unchanged)
/// - "a thousand people" → "a thousand people" (unchanged)
///
/// The fix is applied as post-processing after normalization to avoid forking
/// the upstream FST grammars.
///
/// **English only, and it is [`Lang::postprocess`] that says so.** It used to sit
/// on the shared numeral step, where it was safe only because the words it looks
/// for do not occur in Chinese or Japanese — a Japanese sentence quoting the
/// English word `thousand` would have had an `one` inserted into it.
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
