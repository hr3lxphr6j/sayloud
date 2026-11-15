//! FST file path constants for WeText normalization.
//!
//! Centralizes all FST relative path names used by the normalizer and engine.
//! This module consolidates hardcoded strings that appear in multiple places,
//! making it easier to maintain consistency across the codebase.

// Shared preprocessors
pub const FULL_TO_HALF: &str = "full_to_half.fst";
pub const TRADITIONAL_TO_SIMPLE: &str = "traditional_to_simple.fst";
pub const CONTRACTIONS: &str = "contractions.fst";
pub const REMOVE_INTERJECTIONS: &str = "remove_interjections.fst";
pub const REMOVE_PUNCTS: &str = "remove_puncts.fst";
pub const TAG_OOV: &str = "tag_oov.fst";

// English TN
pub const EN_TN_TAGGER: &str = "en/tn/tagger.fst";
pub const EN_TN_VERBALIZER: &str = "en/tn/verbalizer.fst";

// English ITN
pub const EN_ITN_TAGGER: &str = "en/itn/tagger.fst";
pub const EN_ITN_VERBALIZER: &str = "en/itn/verbalizer.fst";

// Chinese TN
pub const ZH_TN_TAGGER: &str = "zh/tn/tagger.fst";
pub const ZH_TN_VERBALIZER: &str = "zh/tn/verbalizer.fst";
pub const ZH_TN_VERBALIZER_REMOVE_ERHUA: &str = "zh/tn/verbalizer_remove_erhua.fst";

// Chinese ITN
pub const ZH_ITN_TAGGER: &str = "zh/itn/tagger.fst";
pub const ZH_ITN_TAGGER_ENABLE_0_TO_9: &str = "zh/itn/tagger_enable_0_to_9.fst";
pub const ZH_ITN_VERBALIZER: &str = "zh/itn/verbalizer.fst";

// Japanese TN
pub const JA_TN_TAGGER: &str = "ja/tn/tagger.fst";
pub const JA_TN_VERBALIZER: &str = "ja/tn/verbalizer.fst";

// Japanese ITN
pub const JA_ITN_TAGGER: &str = "ja/itn/tagger.fst";
pub const JA_ITN_TAGGER_ENABLE_0_TO_9: &str = "ja/itn/tagger_enable_0_to_9.fst";
pub const JA_ITN_VERBALIZER: &str = "ja/itn/verbalizer.fst";
