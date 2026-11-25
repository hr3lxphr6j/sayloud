//! Character provenance: where each output character came from in the input.
//!
//! Word-level highlighting needs the reverse of what the pipeline produces: not
//! "this text became these phonemes" but "these phonemes came from this word".
//! Every transform the pipelines run is character-level — one input character
//! becomes none, one, or several output characters, all attributable to the
//! input character (or pair, for a composed half-width kana) that produced it —
//! so a text that carries, per character, the UTF-16 range it came from can be
//! transformed and still answer that question. The one transform that cannot is
//! the WeText engine ([`crate::tn`]), which rewrites whole spans (`123` →
//! `one hundred twenty three`) opaquely; the pipelines drop spans for a
//! sentence the engine changed rather than guess.
//!
//! Ranges are UTF-16 code units, not Rust `char` indices, because what slices
//! with them is JavaScript: `sentence.slice(charStart, charEnd)` is the
//! highlight, and JavaScript counts UTF-16 units.

use std::iter::once;

/// Text plus, for each of its characters, the UTF-16 range of the original
/// input that character came from — or `None` for a character that cannot be
/// traced (one the WeText engine produced, whose origin nothing knows).
#[derive(Debug, Clone)]
pub struct SpannedText {
    text: String,
    /// `(start, exclusive end)` in UTF-16 units of the original input, per
    /// character of `text`. Starts are monotone non-decreasing — transforms
    /// reorder nothing.
    origin: Vec<Option<(u32, u32)>>,
    /// UTF-16 length of the original input; what an empty text's range is.
    input_utf16_len: u32,
}

impl SpannedText {
    /// The text unchanged: character `i` came from character `i`.
    pub fn identity(text: &str) -> Self {
        let mut origin = Vec::with_capacity(text.chars().count());
        let mut utf16 = 0u32;
        for ch in text.chars() {
            let start = utf16;
            utf16 += ch.len_utf16() as u32;
            origin.push(Some((start, utf16)));
        }
        Self {
            text: text.to_string(),
            origin,
            input_utf16_len: utf16,
        }
    }

    /// The output of a rewrite this layer cannot follow, aligned back to the
    /// input by character.
    ///
    /// The WeText engine rewrites whole spans (`it's` → `it is`, `3` → `three`)
    /// and says nothing about what came from where. Dropping every span for
    /// such a sentence would cost word-level highlighting on most English
    /// prose, because contractions and numbers are why the engine runs at all.
    /// What *is* knowable is the part the engine left verbatim, and that is
    /// nearly all of it: the rewrite is local.
    ///
    /// So the output is aligned to the input by longest common subsequence, and
    /// each aligned character claims its match's range. An unaligned character
    /// — the engine's own output — claims nothing, and any word containing one
    /// loses its own span (see [`SpannedText::char_range`]) while the words
    /// around it keep theirs.
    ///
    /// The alignment is a claim about identical characters, not about meaning:
    /// a matched character is the same character in both texts, in order. When
    /// the engine reorders, a matched character can point at the wrong
    /// occurrence of a repeated character — the honest failure of a rule that
    /// never guesses, and one natural text normalization does not produce.
    pub fn aligned(before: &SpannedText, after: &str) -> Self {
        let input: Vec<char> = before.text.chars().collect();
        let output: Vec<char> = after.chars().collect();

        // match_of[i] = the input character output character `i` was matched
        // with, by LCS. The table is 0..=len for both sides; the walk is the
        // standard one, taking the diagonal when the characters are equal. The
        // table is indexed `i * width + j` with `width = output.len() + 1`, so a
        // row is one input character and the columns are the output positions.
        let width = output.len() + 1;
        let mut table = vec![0u32; (input.len() + 1) * width];
        for (i, in_ch) in input.iter().enumerate().rev() {
            for (j, out_ch) in output.iter().enumerate().rev() {
                let shared = if in_ch == out_ch {
                    table[(i + 1) * width + (j + 1)] + 1
                } else {
                    table[(i + 1) * width + j].max(table[i * width + (j + 1)])
                };
                table[i * width + j] = shared;
            }
        }
        let mut match_of: Vec<Option<usize>> = vec![None; output.len()];
        {
            let mut i = 0usize;
            let mut j = 0usize;
            while i < input.len() && j < output.len() {
                if input[i] == output[j] {
                    match_of[j] = Some(i);
                    i += 1;
                    j += 1;
                } else if table[(i + 1) * width + j] >= table[i * width + (j + 1)] {
                    i += 1;
                } else {
                    j += 1;
                }
            }
        }

        let origin: Vec<Option<(u32, u32)>> = match_of
            .into_iter()
            .map(|matched| matched.map(|index| before.origin[index].expect("aligned input has ranges")))
            .collect();
        Self {
            text: after.to_string(),
            origin,
            input_utf16_len: before.input_utf16_len,
        }
    }

    /// Assemble a text from its parts: the characters and where each came from.
    ///
    /// Not `pub fn identity`'s job — that is the "came from itself" case. This
    /// is what a context-sensitive rewrite (the canonical fold) hands back.
    pub fn from_parts(text: String, origin: Vec<(u32, u32)>, input_utf16_len: u32) -> Self {
        Self {
            text,
            origin: origin.into_iter().map(Some).collect(),
            input_utf16_len,
        }
    }

    pub fn text(&self) -> &str {
        &self.text
    }

    pub fn into_text(self) -> String {
        self.text
    }

    /// The input range of output characters `from..to`, as UTF-16 offsets into
    /// the original input — or `None` when any of them is untraceable.
    ///
    /// The start is the first character's; the end, the last character's — so a
    /// character that consumed two input characters (composed ｶ + ﾞ) reaches
    /// both, and a dropped character inside a word belongs to the word's range
    /// while one *between* two words belongs to neither. A range over characters
    /// the rewrite produced is `None`: a span the pipeline cannot vouch for is
    /// no span.
    pub fn char_range(&self, from: usize, to: usize) -> Option<(u32, u32)> {
        let chars = self.text.chars().count();
        debug_assert!(from <= to && to <= chars, "char_range out of bounds");
        if from >= to {
            return None;
        }
        let slice = self.origin.get(from..to)?;
        if slice.iter().any(Option::is_none) {
            return None;
        }
        let (start, _) = slice.first()?.as_ref()?;
        let (_, end) = slice.last()?.as_ref()?;
        Some((*start, (*end).max(*start)))
    }

    /// Replace every character with zero or more, all attributed to it.
    ///
    /// This is the shape every character-level rewrite shares — the punctuation
    /// maps, the width fold, digit spelling — so it is the one primitive the
    /// spanned rewrites are written against. A rewrite with *context* (the
    /// canonical fold looks at the neighbours) does not fit and carries its own
    /// loop.
    pub fn map_chars<I: IntoIterator<Item = char>>(&mut self, replace: impl Fn(char) -> I) {
        let chars: Vec<char> = self.text.chars().collect();
        let mut text = String::with_capacity(self.text.len());
        let mut origin = Vec::with_capacity(self.origin.len());
        for (ch, source) in chars.into_iter().zip(self.origin.drain(..)) {
            for emitted in replace(ch) {
                text.push(emitted);
                origin.push(source);
            }
        }
        self.text = text;
        self.origin = origin;
    }

    /// Drop the characters the predicate rejects, keeping the rest's origins.
    pub fn retain(&mut self, keep: impl Fn(char) -> bool) {
        let chars: Vec<char> = self.text.chars().collect();
        let mut text = String::with_capacity(self.text.len());
        let mut origin = Vec::with_capacity(self.origin.len());
        for (ch, source) in chars.into_iter().zip(self.origin.iter()) {
            if keep(ch) {
                text.push(ch);
                origin.push(*source);
            }
        }
        self.text = text;
        self.origin = origin;
    }

    /// Remove leading and trailing whitespace ([`char::is_whitespace`], the set
    /// [`crate::text::normalize_punctuation`]'s `trim` uses).
    pub fn trim(&mut self) {
        let chars: Vec<char> = self.text.chars().collect();
        let Some(first) = chars.iter().position(|ch| !ch.is_whitespace()) else {
            self.text.clear();
            self.origin.clear();
            return;
        };
        let last = chars
            .iter()
            .rposition(|ch| !ch.is_whitespace())
            .unwrap_or(first);
        self.text = chars[first..=last].iter().collect();
        self.origin = self.origin[first..=last].to_vec();
    }
}

/// Replace one character with the characters of `with`, keeping it when `None`.
pub fn map_char_or_keep(ch: char, with: Option<&'static str>) -> Vec<char> {
    match with {
        Some(with) => with.chars().collect(),
        None => once(ch).collect(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::*;

    fn utf16(text: &str, char_index: usize) -> u32 {
        text.chars().take(char_index).map(|ch| ch.len_utf16() as u32).sum()
    }

    #[test]
    fn identity_ranges_cover_their_own_characters() {
        let spanned = SpannedText::identity("hello, world");
        // `world` starts at char 7 and runs to the end of the input.
        let (start, end) = spanned.char_range(7, 12).expect("traceable");
        assert_eq!(start, utf16("hello, world", 7));
        assert_eq!(end, spanned.input_utf16_len);
    }

    #[test]
    fn one_input_character_expanded_to_two_words_is_their_shared_range() {
        let mut spanned = SpannedText::identity("ab");
        // Both output characters claim the first input character.
        spanned.map_chars(|ch| {
            if ch == 'a' {
                "xx".chars().collect::<Vec<char>>()
            } else {
                once(ch).collect::<Vec<char>>()
            }
        });
        // "xx" (origin 0..1 twice), then 'b' (origin 1..2).
        let (start, end) = spanned.char_range(0, 2).expect("traceable");
        assert_eq!((start, end), (0, 1));
    }

    #[test]
    fn identity_ranges_of_multi_character_text() {
        let spanned = SpannedText::identity("ｶﾞです");
        // ｶ (0..1) ﾞ (1..2) で (2..3) す (3..4).
        assert_eq!(spanned.char_range(0, 1), Some((0, 1)));
        assert_eq!(spanned.char_range(2, 4), Some((2, 4)));
        // A composed pair shows up as one wider range once `fold` produces it;
        // the mechanism that makes that possible is the (start, end) pair.
    }

    #[test]
    fn dropped_characters_between_two_words_belong_to_the_earlier_word() {
        let mut spanned = SpannedText::identity("a\u{200b}b");
        spanned.retain(|ch| ch != '\u{200b}');
        // "ab": 'a' (0..1), 'b' (2..3). One word over both reaches the whole.
        let (start, end) = spanned.char_range(0, 2).expect("traceable");
        assert_eq!((start, end), (0, 3));
        // Two words leave the invisible character in neither.
        assert_eq!(spanned.char_range(0, 1), Some((0, 1)));
        assert_eq!(spanned.char_range(1, 2), Some((2, 3)));
    }

    #[test]
    fn trim_drops_only_the_ends() {
        let mut spanned = SpannedText::identity("  hi  ");
        spanned.trim();
        assert_eq!(spanned.text(), "hi");
        let (start, end) = spanned.char_range(0, 2).expect("traceable");
        assert_eq!((start, end), (2, 4));
    }

    #[test]
    fn an_empty_spanned_text_trims_to_nothing() {
        let mut spanned = SpannedText::identity("   ");
        spanned.trim();
        assert_eq!(spanned.text(), "");
        // No characters left, so there is no range.
        assert_eq!(spanned.char_range(0, 0), None);
    }
}

#[cfg(test)]
mod alignment_tests {
    use super::*;

    /// `spanned.text()` back as a string, for asserting on the aligned output.
    fn aligned_of(before_text: &str, after_text: &str) -> SpannedText {
        SpannedText::aligned(&SpannedText::identity(before_text), after_text)
    }

    #[test]
    fn the_unrewritten_part_keeps_its_origins() {
        // "it's fine" → "it is fine": "It", the space and " fine" match; the
        // engine's own "is" claims nothing.
        let aligned = aligned_of("It's fine", "It is fine");
        // "It" is verbatim; the space after it is on the unaligned side of the
        // rewrite, and one unaligned character takes the range with it.
        assert_eq!(aligned.char_range(0, 2), Some((0, 2)));
        assert_eq!(aligned.char_range(2, 3), None);
        // The output word "is" (characters 3..5) holds an aligned `s` and the
        // engine's own `i` — untraceable as a word, whatever one of its
        // characters managed to match.
        assert_eq!(aligned.char_range(3, 5), None, "the engine's own word");
        // " fine" is verbatim.
        assert_eq!(aligned.char_range(5, 10), Some((4, 9)));
    }

    #[test]
    fn an_expansion_claims_nothing_but_its_neighbours_keep_theirs() {
        let aligned = aligned_of("I have 3 cats.", "I have three cats.");
        // "I have " (0..7) matches; "three" is the engine's; " cats." matches.
        assert_eq!(aligned.char_range(0, 7), Some((0, 7)));
        assert_eq!(aligned.char_range(7, 12), None);
        assert_eq!(aligned.char_range(12, 18), Some((8, 14)));
    }

    #[test]
    fn the_aligned_text_is_the_output_text() {
        let aligned = aligned_of("it's", "it is");
        assert_eq!(aligned.text(), "it is");
    }
}
