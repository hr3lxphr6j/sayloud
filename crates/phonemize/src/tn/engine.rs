//! Text normalization, through the vendored WeText engine.
//!
//! The engine itself is [`crate::tn::wetext`]; this module is the seam
//! between it and the dictionary protocol — it turns the FSTs the registry holds
//! into the [`Normalizer`] a pipeline runs, and it is where the design decisions
//! about that live.
//!
//! # Which of upstream's switches are on, and why
//!
//! Two, and the other six that could be are off with a reason:
//!
//! - `full_to_half` — `ＡＢＣ` is `ABC` before anything else reads it. Also off
//!   upstream. `classify` in `text.rs` accepts `A-Za-z` and drops everything else,
//!   so full-width Latin used to leave the pipeline as silence: `Ｈｅｌｌｏ world`
//!   phonemized to `wˈɜːld`, and `Ｉ ａｍ here` to `hˈiːɹ`. Measured on the
//!   shipped FST over the whole width block: 91 characters map, all of them in
//!   U+FF01–U+FF5E — the three that range leaves alone (`＃`, `［`, `］`) and
//!   everything after it (half-width katakana, hangul, the currency signs) this
//!   step does not fold and `text.rs` still drops. **English and Japanese only,
//!   and that is a pipeline-order fact rather than a preference** — [`chinese`]
//!   says why Chinese's fold is elsewhere.
//! - `traditional_to_simple` — Chinese only. See [`chinese`] for the table.
//!
//! Left off: `fix_contractions` (English's apostrophes are read one letter at a
//! time without it — `We'll` is `We` `L` `L` — and it is being fixed separately),
//! `remove_interjections` and `remove_puncts` (both delete text a listener needs —
//! `你好啊` becomes `你好`, and `。！？` are what Kokoro pauses on), `tag_oov` (it
//! marks out-of-vocabulary words for a downstream consumer this project has no use
//! for), `remove_erhua` (erhua is `g2p/zh/tone_sandhi`'s job and this FST would
//! delete the 儿 before that stage saw it), and `enable_0_to_9` and the `itn`
//! grammars (the other direction; nothing here inverts text normalization).
//!
//! # Why this is optional everywhere
//!
//! Every pipeline takes an `Option<&Normalizer>` and falls back to a hand-written
//! numeral reader when it is `None`: [`numbers_to_english`](crate::tn::numbers_to_english)
//! for English, [`numbers_to_kanji`](crate::tn::numbers_to_kanji)
//! for Japanese, [`numbers_to_han`](crate::tn::numbers_to_han)
//! for Chinese. The FSTs are still declared as required dictionaries, so a caller
//! that goes through `prepare` gets them or gets an error; the fallback exists for
//! the caller that did not, and for a build whose assets were not fetched.
//!
//! That is not a hedge. The three readers are what the pipelines did before this
//! engine arrived, they are pinned by tests of their own, and the JavaScript
//! frontends that Kokoro's v1.0 voices were trained against read numerals that
//! way. Keeping them reachable is what makes this switch reversible and what lets
//! `tests/zh_pipeline.rs` still assert the frozen pipeline's output
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
//! ([`crate::tn::gate`]), and only because upstream's English TN is
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
//!
//! Two of the preprocessors add to that parse and not to the per-sentence cost,
//! which is why they are worth having for the size they are: `full_to_half` is
//! 15.6 KB raw, and `traditional_to_simple` — Chinese's, and the only FST here
//! that is not a grammar — is 401 KB. Both are dwarfed by the grammars beside
//! them, and the fold's own work is a character map: one pass, no composition.

use super::wetext::{Language, Normalizer, NormalizerConfig, WeTextError};

/// `(language, the relative name its tagger is keyed under, the name its
/// verbalizer is keyed under)`.
///
/// The two names are the strings upstream would have joined to its FST
/// directory, kept because they are what the normalizer asks for internally —
/// see [`crate::tn::wetext::Normalizer`]. The language is what decides
/// which pair of those names the configuration looks up.
type Grammar<'a> = (Language, &'a str, &'a str);

const EN: Grammar<'static> = (Language::En, "en/tn/tagger.fst", "en/tn/verbalizer.fst");
const ZH: Grammar<'static> = (Language::Zh, "zh/tn/tagger.fst", "zh/tn/verbalizer.fst");
const JA: Grammar<'static> = (Language::Ja, "ja/tn/tagger.fst", "ja/tn/verbalizer.fst");

/// The relative name the shared full-width preprocessor is keyed under.
///
/// Not per language, which is why it has no entry in [`Grammar`]: the FST lives at
/// the top of the wheel's `fsts/` directory rather than under a language.
const FULL_TO_HALF: &str = "full_to_half.fst";

/// The relative name Chinese's traditional-to-simplified preprocessor is keyed
/// under.
const TRADITIONAL_TO_SIMPLE: &str = "traditional_to_simple.fst";

/// Build a normalizer from the FSTs the registry delivered.
///
/// The `itn`, `prefix` and post-processor files the Python package also ships are
/// not read by any configuration this crate builds — see the module comment for
/// which switches are on and why each of the others is off. Every FST a
/// configuration *will* ask for has to be here, because
/// [`Normalizer::from_bytes`] reports a missing one only when a sentence reaches
/// it, and a sentence that reaches it is a sentence whose normalizer falls back
/// to the hand-written reader: a silent wrong answer rather than a failure.
fn build<'a>(
    language: Language,
    config: NormalizerConfig,
    fsts: impl IntoIterator<Item = (String, &'a [u8])>,
) -> Result<Normalizer, WeTextError> {
    Normalizer::from_bytes(config.with_lang(language), fsts)
}

/// The English normalizer: `3:30pm` → `three thirty PM`, `50%` → `fifty percent`.
///
/// Plus the switch the module comment argues for: `ＡＢＣ` → `ABC`.
pub fn english(
    tagger: &[u8],
    verbalizer: &[u8],
    full_to_half: &[u8],
) -> Result<Normalizer, WeTextError> {
    let config = NormalizerConfig::new().with_full_to_half(true);
    build(
        EN.0,
        config,
        [
            (EN.1.to_string(), tagger),
            (EN.2.to_string(), verbalizer),
            (FULL_TO_HALF.to_string(), full_to_half),
        ],
    )
}

/// The Chinese normalizer: `2024年` → `二零二四年`, `下午3:30` → `下午三点三十分`.
///
/// A *year* is read digit by digit here and a quantity is not, which is the one
/// place this reading differs most visibly from
/// [`numbers_to_han`](crate::tn::numbers_to_han): that reader
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
///
/// **`traditional_to_simple` is on, and it is the one switch whose absence is
/// audible in ordinary text rather than at the edges.** pinyin-pro's polyphone
/// disambiguation is a phrase table over simplified spellings, so a traditional
/// spelling misses it and the character is read with its default pronunciation.
/// Measured through the shipped pipeline, traditional in, before and after:
///
/// | text | before | after |
/// |------|--------|-------|
/// | 銀行 | `i↗nɕi↗ŋ` (xíng) | `i↗nxa↗ŋ` (háng) |
/// | 音樂 | `i→nlɤ↘` (lè) | `i→nɥe↘` (yuè) |
/// | 會計 | `xwei↘ʨi↘` (huì) | `kʰwai↘ʨi↘` (kuài) |
/// | 長大 | `ꭧʰa↗ŋ ta↘` (cháng) | `ꭧa↓ŋta↘` (zhǎng) |
/// | 為了 | `wei↗ lɤ` (wéi) | `wei↘lɤ` (wèi) |
/// | 重複 | `ꭧʊ↘ŋ fu↘` (zhòng) | `ꭧʰʊ↗ŋfu↘` (chóng) |
/// | 還是有 | `xwa↗n…` (huán) | `xai↗…` (hái) |
///
/// The FST is conservative exactly where one-to-many mapping would be lossy:
/// 乾燥, 乾隆, 乾淨, 著作, 著手 and 藉口 all come back unchanged, so the classical
/// `乾→干` / `著→着` / `藉→借` traps are not traps here. The readings it cannot
/// fix are pinyin-pro's own — 乾淨 is `qiánjìng` either way, because the FST never
/// rewrites 乾.
///
/// **`full_to_half` is off here, alone among the three languages, and the reason
/// is where Chinese's two steps sit relative to each other.** Chinese runs its
/// numeral step *before* its punctuation map — it has to: the grammar reads a
/// full-width `．` as the decimal point of a whole number, and
/// `zh_text::map_punctuation` turns that same character into a full stop. A fold in
/// `preprocess` therefore rewrites `，` and `。` before the map has owned them, and
/// `你好，世界。` loses the listening-tested comma→period pause: measured
/// `ni↗xau↓,ʂɻ̩↘ʨje↘.` where the map gives `ni↗xau↓. ʂɻ̩↘ʨje↘.`. English's and
/// Japanese's maps both run first, so their folds cost nothing.
///
/// Chinese's fold is the *pipeline's* instead, after the map:
/// [`to_half_width`](crate::text::to_half_width), widened to full-width Latin for
/// the same silence the other two languages fold away. What the ordering gives up
/// is the tagger's reading of a full-width `％` — the one corpus sample that the
/// fold had moved went back to the hand-written reader's value; see
/// `tests/zh_pipeline.rs`.
pub fn chinese(
    tagger: &[u8],
    verbalizer: &[u8],
    traditional_to_simple: &[u8],
) -> Result<Normalizer, WeTextError> {
    let config = NormalizerConfig::new().with_traditional_to_simple(true);
    build(
        ZH.0,
        config,
        [
            (ZH.1.to_string(), tagger),
            (ZH.2.to_string(), verbalizer),
            (TRADITIONAL_TO_SIMPLE.to_string(), traditional_to_simple),
        ],
    )
}

/// The Japanese normalizer: `1/2` → `二分の一`, `2.5km` → `二点五キロメートル`.
///
/// **Not percentages.** [`numbers_to_kanji`](crate::tn::numbers_to_kanji)
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
///
/// `full_to_half` is on, and for Japanese it is free: its punctuation map runs
/// before the numeral step, so the fold cannot rewrite anything the map still
/// wants. Japanese text writes Latin in full width (`ＡＢＣの話`, `ｈｅｌｌｏ`) and
/// `classify` drops what is not `A-Za-z`, so without the fold the sentence came out
/// with a hole in it.
pub fn japanese(
    tagger: &[u8],
    verbalizer: &[u8],
    full_to_half: &[u8],
) -> Result<Normalizer, WeTextError> {
    let config = NormalizerConfig::new().with_full_to_half(true);
    build(
        JA.0,
        config,
        [
            (JA.1.to_string(), tagger),
            (JA.2.to_string(), verbalizer),
            (FULL_TO_HALF.to_string(), full_to_half),
        ],
    )
}
