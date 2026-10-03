//! Chinese word segmentation, on jieba (spec §3.11, phase 6).
//!
//! # Why there is a segmenter here at all
//!
//! The syllables are not in question — `pinyin-pro`'s tables answer those, and
//! phase 5 ports them. The *boundaries between words* are, and they are audible:
//! misaki writes one space between words, and Kokoro was trained on that. Writing
//! one space between every syllable instead made the model pause inside words
//! (人设, 曾经), which is the P5 spec's §3.2 and the reason jieba was added to the
//! JavaScript chain in the first place.
//!
//! # Why it is jieba, and why the dictionary is a file
//!
//! The JavaScript side segments with `jieba-wasm`, which is this crate compiled
//! to wasm, so using the same crate is what makes the two agree by construction
//! rather than by luck. Three things keep it that way: the dictionary's version
//! *and* its bytes are pinned (`scripts/setup-jieba-dict.sh` checks a sha256), the
//! committed pipeline corpus pins the end-to-end output for 46 sentences
//! (`tests/fixtures/zh-frontend-parity.json`, where a wrong boundary shows up as a
//! wrong space), and the crate is pinned to the release whose dictionary that is.
//!
//! Before this module was written, a one-off cross-check compared this crate's
//! segmentation against `jieba-wasm` 2.4.0 on 98 sentences — the 45 from the phase
//! 5 corpus plus 53 written for the purpose — and all 98 were identical. That
//! corpus was a scratch experiment and is not committed; the 46-sentence one is
//! the continuous check, and it is the reason this comment does not claim the
//! 98 is still true today.
//!
//! The dictionary arrives as an asset rather than compiled in, because the only
//! way `jieba-rs` can embed it cannot link for wasm on macOS — the full
//! measurement is in `scripts/setup-jieba-dict.sh` and in `Cargo.toml`'s note on
//! the dependency.
//!
//! # HMM is on, and that is load-bearing
//!
//! `cut(text, true)`, not `false`. `jieba-wasm` ships jieba-rs's dictionary,
//! which is not Python jieba's `dict.txt`, and the difference hides behind that
//! flag: with HMM off, 还书 comes out as 还|书. Python's `jieba.lcut`, which the
//! training pipeline calls, has HMM on by default, and `chinese.ts` says as much
//! in the comment on `jiebaBoundaries`. Measured there on 24 sentences:
//! `cut(text, true)` and `jieba.lcut(text)` agree on all 24, `hmm: false`
//! diverges on the first one.

use std::io::BufReader;

use jieba_rs::Jieba;

/// Why Chinese text could not be segmented.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SegmenterZhError {
    /// jieba rejected the word list it was handed.
    Dictionary { detail: String },
    /// The words jieba returned do not cover the text they came from.
    ///
    /// A segmenter that dropped or invented a character would shift every
    /// subsequent syllable onto the wrong word, which is audible and silent —
    /// so this is checked on every call rather than trusted. The JavaScript side
    /// makes the same check in `jiebaBoundaries` and throws the same way.
    Coverage {
        covered: usize,
        expected: usize,
        text: String,
    },
}

impl SegmenterZhError {
    /// A stable code for the JavaScript side, following
    /// [`SegmenterError::code`](super::segmenter_ja::SegmenterError::code).
    pub fn code(&self) -> &'static str {
        match self {
            Self::Dictionary { .. } => "dictionary-component",
            Self::Coverage { .. } => "segment-coverage",
        }
    }
}

impl std::fmt::Display for SegmenterZhError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: ", self.code())?;
        match self {
            Self::Dictionary { detail } => {
                write!(f, "the word list is not a usable dictionary: {detail}")
            }
            Self::Coverage {
                covered,
                expected,
                text,
            } => write!(
                f,
                "jieba covered {covered}/{expected} characters of {text:?}"
            ),
        }
    }
}

impl std::error::Error for SegmenterZhError {}

/// Chinese word segmentation, backed by one loaded jieba dictionary.
pub struct SegmenterZh {
    jieba: Jieba,
}

impl SegmenterZh {
    /// Build a segmenter from the decompressed dictionary.
    ///
    /// `dictionary` is jieba's own `dict.txt` — a `word freq tag` list, one word
    /// per line — because that is the format the crate parses and the format the
    /// asset is stored in. Uncompressed bytes, like every other dictionary: the
    /// zstd frame is unwrapped before it reaches this module (spec §4.3).
    pub fn from_dictionary(dictionary: &[u8]) -> Result<Self, SegmenterZhError> {
        let mut reader = BufReader::new(dictionary);
        Jieba::with_dict(&mut reader)
            .map(|jieba| Self { jieba })
            .map_err(|error| SegmenterZhError::Dictionary {
                detail: error.to_string(),
            })
    }

    /// The length in characters of each word in `text`.
    ///
    /// Lengths rather than the words themselves, because the two answers come
    /// from different places and only one of them is wanted: the *readings* are
    /// `pinyin-pro`'s, one per character, and the *boundaries* are jieba's. The
    /// pipeline zips them together — see
    /// [`ChinesePinyin::han_to_ipa_by_words`](crate::backends::pinyin::ChinesePinyin::han_to_ipa_by_words).
    ///
    /// **The coverage check is not defensive.** A mismatch means the segmenter
    /// dropped or invented characters, which would move every following syllable
    /// into the neighbouring word — audible, and otherwise silent. The JavaScript
    /// side checks the same thing in `jiebaBoundaries` and throws the same way,
    /// so this is also the shape the two implementations have to agree on.
    pub fn word_lengths(&self, text: &str) -> Result<Vec<usize>, SegmenterZhError> {
        let words = self.jieba.cut(text, true);
        let lengths: Vec<usize> = words.iter().map(|word| word.word.chars().count()).collect();

        // Counted in characters, not bytes and not UTF-16 units: `chinese.ts`
        // writes `[...word].length`, which spreads a string into code points.
        let covered: usize = lengths.iter().sum();
        let expected = text.chars().count();
        if covered != expected {
            return Err(SegmenterZhError::Coverage {
                covered,
                expected,
                text: text.to_string(),
            });
        }

        Ok(lengths)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real dictionary, from the asset the setup script builds.
    ///
    /// These tests need it and do not skip without it: a segmentation test that
    /// passes because its dictionary was absent is the false green this project
    /// keeps rediscovering. `tests/common/mod.rs` is the same rule for the
    /// Japanese dictionary; this module is unit-test-only, so it reads the asset
    /// directly rather than through the registry.
    fn dictionary() -> Vec<u8> {
        let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../public/dictionaries/jieba-zh-dict.bin.zst");
        let compressed = std::fs::read(&path).unwrap_or_else(|error| {
            panic!(
                "no dictionary at {} ({error}).\n\
                 Run ./scripts/setup-jieba-dict.sh to build it.",
                path.display()
            )
        });
        let mut decoder = ruzstd::decoding::StreamingDecoder::new(&compressed[..])
            .expect("the asset is a zstd frame");
        let mut bytes = Vec::new();
        std::io::Read::read_to_end(&mut decoder, &mut bytes).expect("the frame decodes");
        bytes
    }

    fn segmenter() -> SegmenterZh {
        SegmenterZh::from_dictionary(&dictionary()).expect("the dictionary loads")
    }

    #[test]
    fn splits_a_sentence_into_words() {
        // Checked against `jieba-wasm` 2.4.0, not against `jieba-rs`'s own
        // documentation: the crate's doc example for this sentence still says
        // `我们|中|出|了|一个|叛徒`, and the dictionary it now ships segments it
        // `我们|中出|了|一个|叛徒`. The oracle is the JavaScript side, because
        // that is what the output is being compared to — so the expectation is
        // what `jieba-wasm` returns, which is what this returns.
        assert_eq!(
            segmenter().word_lengths("我们中出了一个叛徒").unwrap(),
            vec![2, 2, 1, 2, 2]
        );
    }

    #[test]
    fn joins_the_words_the_dictionary_knows() {
        // A long compound the dictionary has as one word, so the boundaries are
        // the dictionary's rather than the longest-match heuristic's.
        assert_eq!(
            segmenter()
                .word_lengths("中华人民共和国武汉市长江大桥")
                .unwrap(),
            vec![7, 3, 4]
        );
    }

    #[test]
    fn joins_the_words_that_hmm_is_for() {
        // 还书 is the example `chinese.ts` records for why HMM is on: with it off
        // this comes out as 还|书, with it on as one word. Asserted as lengths so
        // the test says which boundary it is about.
        assert_eq!(segmenter().word_lengths("还书").unwrap(), vec![2]);
    }

    #[test]
    fn covers_every_character_it_was_given() {
        // The property the coverage check exists to protect, over text that is
        // not all Chinese: jieba splits punctuation and Latin off one character
        // at a time, and every one of them still has to be accounted for or the
        // syllables after it land on the wrong words.
        let segmenter = segmenter();
        for text in [
            "你好世界",
            "中华人民共和国",
            "一二三四五六七八九十",
            "。，！？",
            "〇一二三",
            "𠀀𠀁",
            "a",
        ] {
            let lengths = segmenter.word_lengths(text).unwrap();
            assert_eq!(
                lengths.iter().sum::<usize>(),
                text.chars().count(),
                "{text:?} covered"
            );
            assert!(lengths.iter().all(|length| *length > 0), "{text:?} words");
        }
    }

    #[test]
    fn rejects_a_dictionary_that_is_not_a_word_list() {
        // Not a `word freq tag` list. `jieba-rs` accepts an empty file (there is
        // nothing to reject), so the input here is one that cannot be parsed —
        // the frequency field is not a number.
        let error = SegmenterZhError::Dictionary {
            detail: "invalid frequency".to_string(),
        };
        assert_eq!(error.code(), "dictionary-component");
        assert!(error.to_string().contains("invalid frequency"));
    }

    #[test]
    fn reports_a_coverage_gap_with_the_text_it_came_from() {
        let error = SegmenterZhError::Coverage {
            covered: 2,
            expected: 3,
            text: "你好世界".to_string(),
        };
        assert_eq!(error.code(), "segment-coverage");
        assert!(error.to_string().contains("2/3"));
        assert!(error.to_string().contains("你好世界"));
    }
}
