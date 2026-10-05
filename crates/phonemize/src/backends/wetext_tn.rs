//! Text normalization, through the vendored WeText engine.
//!
//! The engine itself is [`crate::backends::wetext`]; this module is the seam
//! between it and the dictionary protocol — it turns the two FSTs the registry
//! holds into the [`Normalizer`] a pipeline runs, and it is where the design
//! decisions about that live.
//!
//! # Why this is optional everywhere
//!
//! Every pipeline takes an `Option<&Normalizer>` and falls back to a hand-written
//! numeral reader when it is `None`: [`numbers_en`](crate::backends::numbers_en)
//! for English, [`numbers_to_kanji`](crate::backends::numbers::numbers_to_kanji)
//! for Japanese, [`numbers_to_han`](crate::backends::numbers_zh::numbers_to_han)
//! for Chinese. The FSTs are still declared as required dictionaries, so a caller
//! that goes through `prepare` gets them or gets an error; the fallback exists for
//! the caller that did not, and for a build whose assets were not fetched.
//!
//! That is not a hedge. The three readers are what the pipelines did before this
//! engine arrived, they are pinned by tests of their own, and the JavaScript
//! frontends that Kokoro's v1.0 voices were trained against read numerals that
//! way. Keeping them reachable is what makes this switch reversible and what lets
//! `tests/zh_pipeline.rs` still assert the phase 6 pipeline's output
//! character-for-character — see [`crate::pipeline::ToneRules`] for the same
//! argument made about the tone rules.
//!
//! # Why per instance rather than a global cache
//!
//! Upstream's own cache lives inside the [`Normalizer`], and the PoC cached one
//! per language in a `thread_local`. That is wrong here for two reasons: the
//! `Phonemizer` already owns everything else it needs per worker (the
//! segmenters), and a `thread_local` would be shared state between two
//! `Phonemizer`s on one thread — which is exactly the shape `cargo test
//! --test-threads=1` would take, turning "not prepared" into an order-dependent
//! answer.
//!
//! Parsing is the expensive half and it happens once, in `finish_loading`, so
//! holding the parsed normalizer for the life of the worker is what keeps the
//! cost off the first sentence.
//!
//! # What it costs at runtime
//!
//! English is the only language with a gate in front of it
//! ([`crate::backends::tn_gate`]), and only because upstream's English TN is
//! deliberately not gated on digits — `should_normalize` returns true for any
//! non-empty English text, so the engine ran on every sentence whatever it
//! contained, at ~4.6 ms per 100 characters and 92% of that in the tagger.
//!
//! **Chinese and Japanese need no such gate, and adding one would be wrong.**
//! Their `should_normalize` *is* the digit test (modification 5's `lang != En`
//! branch), so the engine is not entered at all for text with no digit in it.
//! What that leaves is a `chars().any()` over every Chinese and Japanese sentence
//! — a scan that cannot cost anything worth measuring — and the engine's real
//! cost on the sentences that reach it. Nothing here needs a gate, and a gate
//! would be a second opinion about a question the engine already answers.
//!
//! The one-off cost is the parse in `finish_loading`, and it is proportional to
//! the grammars: English's `tagger` and `verbalizer` are 12.04 MB raw and 70 ms in
//! the release wasm, Chinese's 1.60 MB and Japanese's 0.73 MB. That is the shape
//! to expect — 12.04 / 1.60 / 0.73 against English's measured 70 ms — and it is
//! paid once per worker, before the first sentence, not per sentence.

use super::wetext::{Language, Normalizer, NormalizerConfig, WeTextError};

/// `(language, the relative name its tagger is keyed under, the name its
/// verbalizer is keyed under)`.
///
/// The two names are the strings upstream would have joined to its FST
/// directory, kept because they are what the normalizer asks for internally —
/// see [`crate::backends::wetext::Normalizer`]. The language is what decides
/// which pair of those names the configuration looks up.
type Grammar<'a> = (Language, &'a str, &'a str);

const EN: Grammar<'static> = (Language::En, "en/tn/tagger.fst", "en/tn/verbalizer.fst");
const ZH: Grammar<'static> = (Language::Zh, "zh/tn/tagger.fst", "zh/tn/verbalizer.fst");
const JA: Grammar<'static> = (Language::Ja, "ja/tn/tagger.fst", "ja/tn/verbalizer.fst");

/// Build a normalizer from the two FSTs the registry delivered.
///
/// Both are the *TN* grammars; the `itn`, `prefix` and post-processor files the
/// Python package also ships are not read by this configuration. Every flag that
/// would pull one of those in is left at its default, which is what the Python
/// reference does — including `full_to_half`, which looks like it ought to be on
/// and is not: the taggers read full-width numerals and full-width punctuation
/// themselves, so turning it on changes which grammar sees the text rather than
/// what comes out. `tests/wetext_en.rs`, `tests/wetext_zh.rs` and
/// `tests/wetext_ja.rs` pin the full-width cases; `NOTICE` modification 7 is the
/// one place this copy *does* have to disagree with the port.
fn build<'a>(
    grammar: Grammar<'_>,
    tagger: &'a [u8],
    verbalizer: &'a [u8],
) -> Result<Normalizer, WeTextError> {
    let (language, tagger_name, verbalizer_name) = grammar;
    let config = NormalizerConfig::new().with_lang(language);

    Normalizer::from_bytes(
        config,
        [
            (tagger_name.to_string(), tagger),
            (verbalizer_name.to_string(), verbalizer),
        ],
    )
}

/// The English normalizer: `3:30pm` → `three thirty PM`, `50%` → `fifty percent`.
///
/// `fix_contractions` is left off, which is upstream's default too: English TN is
/// not where an apostrophe should become three words.
pub fn english(tagger: &[u8], verbalizer: &[u8]) -> Result<Normalizer, WeTextError> {
    build(EN, tagger, verbalizer)
}

/// The Chinese normalizer: `2024年` → `二零二四年`, `下午3:30` → `下午三点三十分`.
///
/// A *year* is read digit by digit here and a quantity is not, which is the one
/// place this reading differs most visibly from
/// [`numbers_to_han`](crate::backends::numbers_zh::numbers_to_han): that reader
/// has no context to tell them apart and reads `2024` as 二千零二十四 either way.
/// The rest of what it buys is the same list for both languages — money
/// (`$20.50` → 二十点五零美元, which the old pipeline read as 二十点五零 and
/// dropped the sign from), fractions (`1/2` → 二分之一), clock times, and
/// comma-grouped numbers (`1,234个` → 一千二百三十四个 where `numbers_to_han`
/// stopped at the comma and said 一,二百三十四).
///
/// Measured on 44 probe inputs, 22 move and 5 of those are the corpus's. What it
/// costs is one class recorded in `tests/wetext_zh.rs`: a zero-padded number is
/// fragmented rather than stripped, so `０１２３` reads 零一百二十三 where the
/// hand-written reader said 一百二十三. `tests/zh_pipeline.rs` has the two tables.
pub fn chinese(tagger: &[u8], verbalizer: &[u8]) -> Result<Normalizer, WeTextError> {
    build(ZH, tagger, verbalizer)
}

/// The Japanese normalizer: `1/2` → `二分の一`, `2.5km` → `二点五キロメートル`.
///
/// **Not percentages.** [`numbers_to_kanji`](crate::backends::numbers::numbers_to_kanji)
/// already reads `50%` as 五十パーセント; it is the comma-grouped numbers
/// (`1,234` → 千二百三十四, where the old reader said いち,にひゃくさんじゅうよん) and
/// the unit-bearing ones (`2.5km` → 二点五キロメートル, where the old reader read the
/// letters *K M* through the English dictionary) that this engine adds. Which is
/// to say: the Japanese numeral reader was already the best of the three, and
/// this is a smaller change there than in Chinese.
///
/// It has one cost of its own, recorded in `tests/wetext_ja.rs`: a lone `０`
/// normalizes to `〇` (U+3007), which no script run in this crate claims — it is
/// not in the CJK Unified Ideographs block — so it is dropped and the digit reads
/// as silence where it used to say れい.
pub fn japanese(tagger: &[u8], verbalizer: &[u8]) -> Result<Normalizer, WeTextError> {
    build(JA, tagger, verbalizer)
}
