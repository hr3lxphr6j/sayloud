//! Chinese word segmentation, on jieba.
//!
//! # Why there is a segmenter here at all
//!
//! The syllables are not in question — `pinyin-pro`'s tables answer those. The
//! *boundaries between words* are, and they are audible: misaki writes one space
//! between words, and Kokoro was trained on that. Writing one space between every
//! syllable instead made the model pause inside words (人设, 曾经), which is the
//! reason jieba was added to the JavaScript chain in the first place.
//!
//! # Why it is jieba, and why the dictionary is a file
//!
//! The JavaScript side segments with `jieba-wasm`, which is this crate compiled
//! to wasm, so using the same crate is what makes the two agree by construction
//! rather than by luck. Three things keep it that way: the dictionary's version
//! *and* its bytes are pinned (`scripts/setup/setup-jieba-dict.sh` checks a sha256), the
//! committed pipeline corpus pins the end-to-end output for 46 sentences
//! (`tests/fixtures/zh-frontend-parity.json`, where a wrong boundary shows up as a
//! wrong space), and the crate is pinned to the release whose dictionary that is.
//!
//! Before this module was written, a one-off cross-check compared this crate's
//! segmentation against `jieba-wasm` 2.4.0 on 98 sentences — the 45 from the
//! committed corpus plus 53 written for the purpose — and all 98 were identical.
//! That corpus was a scratch experiment and is not committed; the 46-sentence one
//! is the continuous check, and it is the reason this comment does not claim the
//! 98 is still true today.
//!
//! The dictionary arrives as an asset rather than compiled in, because the only
//! way `jieba-rs` can embed it cannot link for wasm on macOS — the full
//! measurement is in `scripts/setup/setup-jieba-dict.sh` and in `Cargo.toml`'s note on
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
    /// [`SegmenterError::code`](crate::g2p::ja::segmenter::SegmenterError::code).
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

/// One word of the segmentation, with the part of speech jieba's dictionary
/// gives it.
///
/// A *length* rather than the word itself, for the same reason
/// [`SegmenterZh::word_lengths`] returns lengths: the word is a range of the
/// text, and every consumer of it already has the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaggedWord<'a> {
    /// How many characters the word covers.
    pub length: usize,
    /// jieba's tag: `n`, `v`, `ul`, `nr`, `x`.
    pub tag: &'a str,
}

/// The byte offset of the `chars`-th character, for splitting on a character
/// boundary.
fn byte_at(text: &str, chars: usize) -> usize {
    text.char_indices()
        .nth(chars)
        .map(|(index, _)| index)
        .unwrap_or(text.len())
}

impl SegmenterZh {
    /// Build a segmenter from the decompressed dictionary.
    ///
    /// `dictionary` is jieba's own `dict.txt` — a `word freq tag` list, one word
    /// per line — because that is the format the crate parses and the format the
    /// asset is stored in. Uncompressed bytes, like every other dictionary: the
    /// zstd frame is unwrapped before it reaches this module.
    pub fn from_dictionary(dictionary: &[u8]) -> Result<Self, SegmenterZhError> {
        let mut reader = BufReader::new(dictionary);
        Jieba::with_dict(&mut reader)
            .map(|jieba| Self { jieba })
            .map_err(|error| SegmenterZhError::Dictionary {
                detail: error.to_string(),
            })
    }

    /// The length in characters of each word in `text`, with its part of speech.
    ///
    /// The tone rules ask about the tag in about a third of their
    /// branches: `_neural_sandhi` will not make a suffix neutral on the wrong
    /// kind of word, and `_merge_yi` only glues `V 一 V` together when the first
    /// V is a verb.
    ///
    /// # Where the tag comes from
    ///
    /// The third column of jieba's own word list, which is the same data Python
    /// jieba's `posseg` reads, so a word the dictionary has is tagged the same
    /// way on both sides. **A word the dictionary does not have is `x`** —
    /// "other" — because the compound HMM that would guess a tag for it is
    /// behind `jieba-rs`'s `default-dict` feature, and that feature cannot be
    /// built for wasm (`Cargo.toml`).
    ///
    /// That is a real difference from PaddleSpeech, and a narrow one: Python
    /// jieba tags 还书 `v` where this says `x`, and a rule that checks the tag
    /// then declines. A sandhi or a neutral tone the tag would have allowed is
    /// not applied; nothing is read wrong.
    ///
    /// The *boundaries* are not guessed either way: `cut` and `tag` are one walk
    /// over one dictionary, and `agrees_with_word_lengths` asserts that on a
    /// corpus rather than assuming it.
    pub fn tagged_words<'a>(
        &'a self,
        text: &'a str,
    ) -> Result<Vec<TaggedWord<'a>>, SegmenterZhError> {
        let words = self.jieba.tag(text, true);
        let lengths: Vec<usize> = words.iter().map(|word| word.word.chars().count()).collect();

        // The same check `word_lengths` makes, for the same reason: a segmenter
        // that dropped or invented a character would shift every following
        // syllable onto the wrong word.
        let covered: usize = lengths.iter().sum();
        let expected = text.chars().count();
        if covered != expected {
            return Err(SegmenterZhError::Coverage {
                covered,
                expected,
                text: text.to_string(),
            });
        }

        Ok(words
            .iter()
            .zip(lengths)
            .map(|(word, length)| TaggedWord {
                length,
                tag: word.tag,
            })
            .collect())
    }

    /// `tone_sandhi.py`'s `_split_word`: where jieba's search mode breaks a word
    /// in two, and what it calls the two pieces.
    ///
    /// The reference sorts the sub-words `jieba.cut_for_search` returns by length
    /// and then looks for the shortest one in the word: at the front, the word
    /// splits after it; anywhere else, the shortest sub-word is its *tail*. So the
    /// returned length is the boundary — the first `length` characters of the word
    /// are one group and the rest are the other — and the two strings are the
    /// names `_split_word` calls them by.
    ///
    /// **The names are not the two groups, and this reproduces that rather than
    /// fixing it.** 不怎么样 comes back as `(2, "不怎", "怎么")`: `cut_for_search`
    /// offers 不 / 怎么 / 怎么样 / 不怎么样, the shortest is 怎么, it starts at
    /// index 1, so the second name spells characters 1–2 while the second group is
    /// characters 2–4. `_neural_sandhi` tests the *name* for membership in the
    /// neutral-tone list and then neutralizes the *group's* last tone, and this
    /// word is exactly where that difference is observable: 怎么 is in the list
    /// and 么样 is not, so the last tone of 不怎么样 comes out neutral. Both halves
    /// have to be returned for that to be reproducible.
    ///
    /// A sub-word can be the whole word, in which case the second group is empty —
    /// the reference's callers treat that as a group with no tones in it.
    pub fn split_word<'a>(&self, word: &'a str) -> (usize, [&'a str; 2]) {
        let mut subwords: Vec<&str> = self
            .jieba
            .cut_for_search(word, true)
            .iter()
            .map(|token| token.word)
            .collect();
        // Stable, as Python's `sorted` is: on equal lengths the tie goes to
        // whichever sub-word jieba offered first, and that decides the split.
        subwords.sort_by_key(|subword| subword.chars().count());

        let total = word.chars().count();
        let Some(shortest) = subwords.first().copied() else {
            return (total, [word, ""]);
        };
        let length = shortest.chars().count();

        // Only "is it at the front" is asked, so bytes against characters does
        // not matter here. Not found is `None` and Python's -1, and both fall
        // through to the tail case.
        if word.find(shortest) == Some(0) {
            let (first, second) = word.split_at(byte_at(word, length));
            (length, [first, second])
        } else {
            let (prefix, _) = word.split_at(byte_at(word, total - length));
            (total - length, [prefix, shortest])
        }
    }

    /// The length in characters of each word in `text`.
    ///
    /// Lengths rather than the words themselves, because the two answers come
    /// from different places and only one of them is wanted: the *readings* are
    /// `pinyin-pro`'s, one per character, and the *boundaries* are jieba's. The
    /// pipeline zips them together — see
    /// [`ChinesePinyin::han_to_ipa_by_words`](crate::g2p::zh::pinyin::ChinesePinyin::han_to_ipa_by_words).
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
                 Run ./scripts/setup/setup-jieba-dict.sh to build it.",
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
    fn agrees_with_word_lengths() {
        // `word_lengths` segments with `cut` and `tagged_words` with `tag`, and
        // the tone rules take their boundaries from the second while
        // `ToneRules::Off` takes them from the first. If they disagreed,
        // the spacing of the output would depend on whether the tone rules ran,
        // which is a difference nothing else would catch. They are one walk over
        // one dictionary, and this asserts it on a corpus rather than assuming
        // it.
        let segmenter = segmenter();
        let corpus: serde_json::Value = serde_json::from_str(include_str!(
            "../../../tests/fixtures/zh-frontend-parity.json"
        ))
        .expect("the corpus parses");
        let samples = corpus["samples"].as_array().expect("a sample list");

        for sample in samples {
            let text = sample["input"].as_str().expect("an input");
            let lengths = segmenter.word_lengths(text).expect("segments");
            let tagged: Vec<usize> = segmenter
                .tagged_words(text)
                .expect("tags")
                .iter()
                .map(|word| word.length)
                .collect();
            assert_eq!(lengths, tagged, "{text:?} segments the same way twice");
        }
    }

    #[test]
    fn splits_a_word_where_the_reference_does() {
        // `tone_sandhi.py`'s `_split_word`, checked against Python jieba's
        // `cut_for_search` and its own implementation. The two cases that decide
        // the third-tone rules split in opposite directions, and 不怎么样 is the
        // one where the two names are not the two halves.
        let segmenter = segmenter();

        // 纸 / 老虎: monosyllable plus disyllable.
        let (first, names) = segmenter.split_word("纸老虎");
        assert_eq!((first, names), (1, ["纸", "老虎"]));

        // 蒙古 / 包: the other way round.
        let (first, names) = segmenter.split_word("蒙古包");
        assert_eq!((first, names), (2, ["蒙古", "包"]));

        // 所有 / 人.
        let (first, names) = segmenter.split_word("所有人");
        assert_eq!((first, names), (2, ["所有", "人"]));

        // The names are `不怎` and `怎么` while the halves are `不怎` and `么样`:
        // jieba's shortest sub-word starts at index 1, so it is the word's *tail*
        // and not its remainder. `_neural_sandhi` tests the name and neutralizes
        // the group, and 不怎么样 is the word where that shows.
        let (first, names) = segmenter.split_word("不怎么样");
        assert_eq!((first, names), (2, ["不怎", "怎么"]));

        // A reduplication splits into its two halves, which is why the
        // reduplication rule cannot simply ask whether the repeat is inside one
        // sub-word.
        let (first, names) = segmenter.split_word("说说");
        assert_eq!((first, names), (1, ["说", "说"]));

        // And a word jieba's search mode has nothing to say about is one word.
        let (first, names) = segmenter.split_word("人设");
        assert_eq!((first, names), (2, ["人设", ""]));
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
