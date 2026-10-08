//! Main Normalizer implementation
//!
//! This module provides the main Normalizer struct that orchestrates
//! the text normalization pipeline.
//!
//! Differences from upstream (modification 2 and 3 in `NOTICE`):
//!
//! - Every FST a configuration can ask for is supplied to
//!   [`Normalizer::from_bytes`] up front and looked up by relative name. There
//!   is no `fst_dir` and no `get_or_load`, because there is no filesystem — and
//!   with nothing left to load lazily, the method chain does not need `&mut`.
//! - `full_to_half` runs in `preprocess` rather than `postprocess`, which is
//!   the bug the evaluation found: see [`Normalizer::preprocess`].

use std::collections::HashMap;

use super::config::{Language, NormalizerConfig, Operator};
use super::contractions::{fix_contractions, has_apostrophe};
use super::error::{Result, WeTextError};
use super::text_normalizer::FstTextNormalizer;
use super::token_parser::TokenParser;

/// WeText Normalizer
///
/// Main entry point for text normalization functionality.
/// Supports Text Normalization (TN) and Inverse Text Normalization (ITN)
/// for Chinese, English, and Japanese.
///
/// # Example
/// ```rust,ignore
/// use phonemize::tn::wetext::{Normalizer, NormalizerConfig, Language};
///
/// let config = NormalizerConfig::new().with_lang(Language::En);
/// let mut normalizer = Normalizer::from_bytes(config, [
///     ("en/tn/tagger.fst".to_string(), tagger_bytes),
///     ("en/tn/verbalizer.fst".to_string(), verbalizer_bytes),
/// ])?;
/// let result = normalizer.normalize("3:30pm")?;
/// // Result: "three thirty PM"
/// ```
pub struct Normalizer {
    config: NormalizerConfig,
    /// The FSTs, by the relative name the configuration asks for them under —
    /// `"en/tn/tagger.fst"`, `"full_to_half.fst"`. Flat rather than nested,
    /// because a name is all [`Self::fst`] ever has to look one up with.
    fsts: HashMap<String, FstTextNormalizer>,
}

impl Normalizer {
    /// Build a normalizer for a target with no filesystem, from FST bytes.
    ///
    /// The caller supplies exactly the FSTs the configuration will ask for,
    /// under the relative names a filesystem build would have used
    /// (`"en/tn/tagger.fst"`). Nothing is read from disk, so this is the
    /// constructor a wasm build wants.
    ///
    /// An FST the configuration needs but that is not here is *not* an error at
    /// this point — it is one at the call that needs it, as
    /// [`WeTextError::FstNotFound`]. That keeps a `zh` configuration from having
    /// to supply `remove_erhua` it will never use, at the price of a late error
    /// for a name that is genuinely missing. The caller is expected to pass the
    /// full set for the language it configured, the way
    /// [`crate::tn::engine::english`] does.
    pub fn from_bytes<'a>(
        config: NormalizerConfig,
        fsts: impl IntoIterator<Item = (String, &'a [u8])>,
    ) -> Result<Self> {
        let mut parsed = HashMap::new();
        for (relative_path, bytes) in fsts {
            parsed.insert(relative_path, FstTextNormalizer::from_bytes(bytes)?);
        }
        Ok(Self {
            config,
            fsts: parsed,
        })
    }

    /// Normalize text using the configured settings.
    ///
    /// `&self`, not `&mut self` as upstream has it: there is no cache to fill
    /// in, so there is nothing for a second call to change.
    pub fn normalize(&self, text: &str) -> Result<String> {
        self.normalize_with_config(text, &self.config)
    }

    /// Normalize text with a specific configuration.
    pub fn normalize_with_config(&self, text: &str, config: &NormalizerConfig) -> Result<String> {
        let mut text = text.to_string();

        // 1. Fix English contractions
        //
        // The guard asks `contractions::has_apostrophe` rather than testing for
        // `'`, which is what upstream's Python guard does and what this copy used
        // to do. `'` is only one of the two apostrophes the contraction tables
        // are keyed with — the other is `’` (U+2019), which upstream teaches its
        // tables at load time and then never lets through, because a curly
        // apostrophe fails the guard. So the fix is the guard, not the tables:
        // `We’ll` is `we will`, and used to be read `We` `L` `L`.
        if config.fix_contractions && has_apostrophe(&text) {
            text = fix_contractions(&text);
        }

        // 2. Preprocessing
        text = self.preprocess(&text, config)?;

        // 3. Detect language
        let lang = if config.lang == Language::Auto {
            Self::detect_language(&text)
        } else {
            config.lang
        };

        // 4. Check if normalization is needed
        if self.should_normalize(&text, lang, config.operator, config.remove_erhua) {
            // English ITN is not supported in Python wetext (raises NotImplementedError).
            // Fallback to Chinese ITN as a workaround, matching Python behavior.
            let lang = if lang == Language::En && config.operator == Operator::Itn {
                Language::Zh
            } else {
                lang
            };

            // 4.1 Tagger: tag entities
            text = self.tag(&text, lang, config)?;

            // 4.2 Reorder: reorder token fields
            text = self.reorder(&text, lang, config.operator)?;

            // 4.3 Verbalizer: convert to spoken form
            text = self.verbalize(&text, lang, config)?;
        }

        // 5. Postprocessing
        text = self.postprocess(&text, config)?;

        Ok(text)
    }

    /// One FST by the relative name the configuration asks for it under.
    fn fst(&self, relative_path: &str) -> Result<&FstTextNormalizer> {
        self.fsts
            .get(relative_path)
            .ok_or_else(|| WeTextError::FstNotFound(relative_path.to_string()))
    }

    /// Detect text language
    ///
    /// **Note:** This implementation extends the original Python version with Japanese detection.
    /// Python wetext only detects Chinese vs English. This Rust version adds Japanese support
    /// by detecting Hiragana/Katakana characters.
    ///
    /// Detection priority:
    /// 1. Japanese (Hiragana/Katakana) - Rust extension, not in Python version
    /// 2. Chinese (CJK Unified Ideographs)
    /// 3. Numeric-only text (digits, punctuation, symbols) - treated as Chinese
    /// 4. Default to English
    ///
    /// Reachable only when `NormalizerConfig::lang` is left at its `Auto`
    /// default. Every caller in this crate sets the language explicitly.
    fn detect_language(text: &str) -> Language {
        let mut has_cjk = false;
        let mut has_alpha = false;

        for ch in text.chars() {
            // [Rust Extension] Japanese detection via Hiragana/Katakana
            // Japanese Hiragana: U+3040 - U+309F
            // Japanese Katakana: U+30A0 - U+30FF
            // Note: Python wetext does NOT have this detection - it would return "zh" for Japanese text
            if ('\u{3040}'..='\u{309f}').contains(&ch) || ('\u{30a0}'..='\u{30ff}').contains(&ch) {
                return Language::Ja;
            }

            // CJK Unified Ideographs: U+4E00 - U+9FFF
            // Note: These are shared between Chinese and Japanese
            // If we find hiragana/katakana, it's Japanese; otherwise treat as Chinese
            if ('\u{4e00}'..='\u{9fff}').contains(&ch) {
                has_cjk = true;
            }

            // Track if there are any ASCII alphabetic characters
            if ch.is_ascii_alphabetic() {
                has_alpha = true;
            }
        }

        // If contains CJK but no Japanese-specific characters, treat as Chinese
        if has_cjk {
            return Language::Zh;
        }

        // Numeric-only text (no alphabetic characters) treated as Chinese
        // This covers cases like "123", "3/4", "1.5", "2024年" (when year char is not present)
        if !text.is_empty() && !has_alpha {
            return Language::Zh;
        }

        Language::En
    }

    /// Whether a character counts as a digit for [`Self::should_normalize`].
    ///
    /// The reference asks `re.search(r"\d", text)`, which over a Python `str`
    /// is every character in Unicode general category `Nd`.
    /// [`char::is_numeric`] is `Nd | Nl | No`, so this is a **superset** — `½`,
    /// `①` and `Ⅷ` are "digits" here and not to the reference. That direction is
    /// the safe one: it can only make the normalizer *run* on text the reference
    /// would have skipped, and running it on text it has nothing to say about
    /// returns that text unchanged. The other direction was the bug
    /// (modification 7 in `NOTICE`).
    fn is_digit(ch: char) -> bool {
        ch.is_numeric()
    }

    /// Check if normalization is needed
    ///
    /// The digit test is **not** applied to English (modification 5 in
    /// `NOTICE`). Upstream's Python has it that way on purpose:
    ///
    /// ```python
    /// if operator == "tn" and lang != "en":
    ///     if bool(re.search(r"\d", text)):
    ///         return True
    ///     ...
    ///     return False
    /// return len(text) > 0
    /// ```
    ///
    /// so an English sentence is normalized whether or not it has a digit in
    /// it, and the Rust port lost that condition along with the `lang`
    /// parameter. What it costs in behaviour is the whole abbreviation half of
    /// English TN: `Dr. Smith` is `doctor Smith` in the reference and was left
    /// untouched here, because it has no digit. What it costs in time is the
    /// early exit — see the module's cost note in
    /// `crate::tn::wetext::README.md`.
    ///
    /// **The digit test is Unicode-wide, the way the reference's `\d` is.** That
    /// is modification 7 in `NOTICE`, and it is the difference between Chinese
    /// and Japanese TN working and not: fully half the numerals in real Chinese
    /// and Japanese text are written full-width (`２０２２年`, `１５．６％`), `０` is
    /// not an ASCII digit, so every one of those skipped the whole normalizer
    /// and came out unread. English never saw it, because this is not the branch
    /// English takes — which is also why the port's `is_ascii_digit` looked
    /// harmless for as long as English was the only language wired up.
    fn should_normalize(
        &self,
        text: &str,
        lang: Language,
        operator: Operator,
        remove_erhua: bool,
    ) -> bool {
        if operator == Operator::Tn && lang != Language::En {
            // TN: needs normalization if contains digits
            if text.chars().any(Self::is_digit) {
                return true;
            }
            // Or if need to remove erhua
            if remove_erhua && (text.contains('儿') || text.contains('兒')) {
                return true;
            }
            false
        } else {
            // ITN, and English TN, which is not gated on digits: non-empty text
            // needs processing
            !text.is_empty()
        }
    }

    /// Preprocessing step
    fn preprocess(&self, text: &str, config: &NormalizerConfig) -> Result<String> {
        let mut result = text.trim().to_string();

        if config.traditional_to_simple {
            let fst = self.fst("traditional_to_simple.fst")?;
            result = fst.normalize(&result)?;
        }

        // `full_to_half` has to run here and not in `postprocess`, which is where
        // upstream runs it (modification 3). Applying it after the TN is too
        // late: `should_normalize` looks for an ASCII digit, and ２０２２年 has
        // none, so full-width numerals reached the tagger unnormalised and
        // passed through untouched — silently, because the output still looked
        // plausible. Japanese and Chinese text is full of them. Measured on 11
        // Japanese inputs: 6/11 normalized upstream, 10/11 with this move.
        if config.full_to_half {
            let fst = self.fst("full_to_half.fst")?;
            result = fst.normalize(&result)?;
        }

        Ok(result)
    }

    /// Postprocessing step
    fn postprocess(&self, text: &str, config: &NormalizerConfig) -> Result<String> {
        let mut result = text.to_string();

        if config.remove_interjections {
            let fst = self.fst("remove_interjections.fst")?;
            result = fst.normalize(&result)?;
        }

        if config.remove_puncts {
            let fst = self.fst("remove_puncts.fst")?;
            result = fst.normalize(&result)?;
        }

        if config.tag_oov {
            let fst = self.fst("tag_oov.fst")?;
            result = fst.normalize(&result)?;
        }

        Ok(result.trim().to_string())
    }

    /// Tag entities using tagger FST
    fn tag(&self, text: &str, lang: Language, config: &NormalizerConfig) -> Result<String> {
        let fst_path = match (lang, config.operator) {
            (Language::En, Operator::Tn) => "en/tn/tagger.fst",
            (Language::Zh, Operator::Tn) => "zh/tn/tagger.fst",
            (Language::Zh, Operator::Itn) => {
                if config.enable_0_to_9 {
                    "zh/itn/tagger_enable_0_to_9.fst"
                } else {
                    "zh/itn/tagger.fst"
                }
            }
            (Language::Ja, Operator::Tn) => "ja/tn/tagger.fst",
            (Language::Ja, Operator::Itn) => {
                if config.enable_0_to_9 {
                    "ja/itn/tagger_enable_0_to_9.fst"
                } else {
                    "ja/itn/tagger.fst"
                }
            }
            _ => return Err(WeTextError::InvalidLanguage(format!("{:?}", lang))),
        };

        let fst = self.fst(fst_path)?;
        let result = fst.normalize(text)?;
        Ok(result.trim().to_string())
    }

    /// Reorder token fields
    fn reorder(&self, text: &str, lang: Language, operator: Operator) -> Result<String> {
        let parser = TokenParser::new(lang, operator);
        parser.reorder(text)
    }

    /// Verbalize using verbalizer FST
    fn verbalize(&self, text: &str, lang: Language, config: &NormalizerConfig) -> Result<String> {
        let fst_path = match (lang, config.operator) {
            (Language::En, Operator::Tn) => "en/tn/verbalizer.fst",
            (Language::Zh, Operator::Tn) => {
                if config.remove_erhua {
                    "zh/tn/verbalizer_remove_erhua.fst"
                } else {
                    "zh/tn/verbalizer.fst"
                }
            }
            (Language::Zh, Operator::Itn) => "zh/itn/verbalizer.fst",
            (Language::Ja, Operator::Tn) => "ja/tn/verbalizer.fst",
            (Language::Ja, Operator::Itn) => "ja/itn/verbalizer.fst",
            _ => return Err(WeTextError::InvalidLanguage(format!("{:?}", lang))),
        };

        let fst = self.fst(fst_path)?;
        let result = fst.normalize(text)?;
        Ok(result.trim().to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_detect_language() {
        // English
        assert_eq!(Normalizer::detect_language("hello world"), Language::En);
        assert_eq!(Normalizer::detect_language("Hello, World!"), Language::En);

        // Chinese
        assert_eq!(Normalizer::detect_language("你好世界"), Language::Zh);
        assert_eq!(Normalizer::detect_language("今天是2024年"), Language::Zh);

        // Japanese (Hiragana/Katakana triggers Japanese detection)
        assert_eq!(Normalizer::detect_language("こんにちは"), Language::Ja); // Hiragana
        assert_eq!(Normalizer::detect_language("カタカナ"), Language::Ja); // Katakana
        assert_eq!(Normalizer::detect_language("東京タワー"), Language::Ja); // Mixed Kanji + Katakana

        // Pure digits treated as Chinese (common TTS use case)
        assert_eq!(Normalizer::detect_language("123"), Language::Zh);
        assert_eq!(Normalizer::detect_language("2024"), Language::Zh);

        // Edge cases
        assert_eq!(Normalizer::detect_language(""), Language::En); // Empty defaults to English
    }

    /// An FST the configuration asks for and that was not supplied is reported
    /// by name rather than by a read of a directory that does not exist.
    #[test]
    fn a_missing_fst_is_named_rather_than_read() {
        let normalizer =
            Normalizer::from_bytes(NormalizerConfig::new().with_lang(Language::En), [])
                .expect("an empty normalizer is constructible");
        let error = normalizer
            .normalize("3:30pm")
            .expect_err("nothing was supplied for the tagger");

        match error {
            WeTextError::FstNotFound(name) => assert_eq!(name, "en/tn/tagger.fst"),
            other => panic!("expected FstNotFound, got {other:?}"),
        }
    }
}
