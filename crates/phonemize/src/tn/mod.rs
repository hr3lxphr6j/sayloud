//! Text normalization: text in, text out.
//!
//! The first stage of the pipeline, and the only one that is not per language: the
//! numeral step is the vendored WeText engine ([`wetext`]) for every language.
//! **It is the only reader there is** — the hand-written readers that used to stand
//! in for a caller that never called `prepare` are gone, all three of them, so a
//! numeral the engine did not read is a sentence this stage declines ([`NoReader`])
//! rather than text with its digits missing. What differs per language is only
//! *whether* the engine is asked about a sentence at all — so that is a property
//! of [`Lang`] rather than a parameter a caller supplies.
//!
//! Nothing here knows what a phoneme is: the stage after this one is the one that
//! turns this text into phonemes.

pub mod engine;
pub mod gate;
pub mod wetext;

pub use engine::{chinese, english, japanese};
pub use gate::needs_normalization;
pub use wetext::{FstTextNormalizer, Normalizer, WeTextError};

use std::borrow::Cow;

/// Which language's numerals are being read.
///
/// The thing that differs per language is a method here rather than an argument
/// to [`normalize`], because a caller that has the language in hand has no
/// business choosing it separately.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    Ja,
    Zh,
    En,
}

impl Lang {
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

/// The numeral step had no engine to read a numeral with.
///
/// Every language can produce it now — there is no hand-written reader to fall
/// back to for any of them (see [`normalize`]) — and the two cases are worth
/// telling apart, because they do not have the same fix:
///
/// - [`NoReader::NoEngine`] is `prepare` not having run, or a build whose assets
///   never arrived. One call away from working, and `PhonemizeError::NotPrepared`
///   is how a caller hears about it;
/// - [`NoReader::Failed`] is the engine that *was* built giving up on this
///   sentence. Nothing a caller can do, and the cause travels with it.
#[derive(Debug)]
pub enum NoReader {
    /// No engine was built: `prepare` was not called, or its assets did not arrive.
    NoEngine,
    /// The engine was built and failed on this sentence.
    Failed(WeTextError),
}

impl std::fmt::Display for NoReader {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoEngine => write!(
                f,
                "no WeText engine was built for this language, so its numerals cannot be read"
            ),
            Self::Failed(error) => write!(f, "the WeText engine failed on this sentence: {error}"),
        }
    }
}

/// The numeral step: WeText if there is one, and a refusal if there is not.
///
/// `text` is the text as the stage's caller wants the engine to see it — for
/// Chinese that is the raw sentence, for Japanese the punctuation-mapped one,
/// because that is the order each pipeline has always run its steps in.
///
/// Three ways the engine is not the one writing the numerals, and only the last is
/// a failure:
///
/// - it was never built (`None`), which is the caller that never called
///   `prepare` and the build whose assets were not fetched — a [`NoReader::NoEngine`]
///   for a sentence that needs it, and the text unchanged for one that does not;
/// - the gate says there is nothing here for it, which is only reachable for
///   English, and the text goes on unchanged;
/// - it failed on this sentence. The engine can fail — a composition that will
///   not build, a grammar that cannot produce a path — and with no reader behind
///   it that is [`NoReader::Failed`] rather than a sentence read without the
///   numerals.
///
/// **The line is [`gate::drops_without_engine`], not the gate.** A sentence with a
/// digit, a symbol the grammar maps to a word, or a full-width form in it is a
/// sentence something would leave unspoken; a contraction, a capital run or an
/// abbreviation is a *worse reading* of ordinary letters, and every language has
/// always read those with no engine loaded.
pub fn normalize<'a>(
    text: &'a str,
    lang: Lang,
    engine: Option<&Normalizer>,
) -> Result<Cow<'a, str>, NoReader> {
    // The engine is there and the gate says there is nothing here for it.
    // Skipping is then the same as running it, because `gate` only returns
    // `false` for text whose digits the tagger would have passed through.
    // `tests/tn_gate.rs` asserts that rather than assuming it — and it is also
    // why a skip is not a `NoReader`: there is nothing to read.
    let skipped = lang.gate() == Gate::CheapSkip && !gate::needs_normalization(text);

    match engine {
        Some(engine) if !skipped => match engine.normalize(text) {
            Ok(normalized) => Ok(Cow::Owned(normalized)),
            Err(error) => unread(text, Some(error)),
        },
        Some(_) => Ok(Cow::Borrowed(text)),
        None => unread(text, None),
    }
}

/// No engine wrote them: `error` is why, or `None` for "there was no engine at
/// all".
///
/// One predicate for both cases, because the question is the same one — would
/// something in this text go unspoken without the engine
/// ([`gate::drops_without_engine`]) — and the answer decides between a refusal and
/// the text as it is. Only the *reason* travels differently, because only one of
/// the two is a caller's to fix.
fn unread(text: &str, error: Option<WeTextError>) -> Result<Cow<'_, str>, NoReader> {
    if !gate::drops_without_engine(text) {
        return Ok(Cow::Borrowed(text));
    }
    Err(match error {
        Some(error) => NoReader::Failed(error),
        None => NoReader::NoEngine,
    })
}
