//! The chain: text in, phonemes out.
//!
//! One function per `(frontend, lang)` pair today, because one pair is all that
//! exists. Phase 6 turns this into a dispatch over the frontends and adds the
//! other three; the shape of the Japanese path below is the shape they take.
//!
//! The order of the steps is not free — see [`phonemize_ja`].

use crate::backends::numbers::numbers_to_kanji;
use crate::backends::segmenter_ja::{SegmenterError, SegmenterJa};
use crate::frontends::ja_ipa::{fix_numeral_sound_changes, kana_to_ipa};
use crate::text::{
    collapse_whitespace, keep_punctuation, normalize_punctuation, segment_text, ScriptRun,
};

/// Why text could not be turned into phonemes.
#[derive(Debug)]
pub enum PipelineError {
    /// The segmenter failed.
    Segmenter(SegmenterError),
}

impl PipelineError {
    /// A stable code for the JavaScript side.
    pub fn code(&self) -> &'static str {
        match self {
            Self::Segmenter(error) => error.code(),
        }
    }
}

impl std::fmt::Display for PipelineError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Segmenter(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for PipelineError {}

impl From<SegmenterError> for PipelineError {
    fn from(error: SegmenterError) -> Self {
        Self::Segmenter(error)
    }
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
/// # Latin runs are passed through, not phonemized
///
/// A `Latin` run keeps its characters, which is a real difference from the
/// JavaScript pipeline: it hands them to espeak, and espeak arrives in phase 4.
///
/// Passing the characters through rather than dropping the run is deliberate.
/// Dropping is the failure mode this pipeline exists to avoid — text that is
/// simply absent from the output, with nothing thrown — and it is the wrong side
/// of the trade twice over: for an acronym, which is most of what Latin text in
/// a Japanese sentence is, Kokoro's vocabulary already holds the letters as
/// phonemes, so `API` comes out close to the way the JavaScript spells it; and
/// for anything else, wrong audio is easier to notice than missing audio.
///
/// It is still a divergence, and `tests/ja_parity.rs` records it per sample
/// rather than leaving it to be discovered.
pub fn phonemize_ja(text: &str, segmenter: &SegmenterJa) -> Result<String, PipelineError> {
    let normalized = normalize_punctuation(text);
    let with_numerals = numbers_to_kanji(&normalized);
    let runs = segment_text(&with_numerals);

    let mut parts: Vec<String> = Vec::new();

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
            ScriptRun::Latin(run_text) => parts.push(run_text.clone()),
            ScriptRun::Other(run_text) => parts.push(keep_punctuation(run_text)),
        }
    }

    Ok(collapse_whitespace(&parts.concat()))
}
