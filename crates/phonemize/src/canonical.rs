//! Character-level canonicalisation, before anything else looks at the text.
//!
//! This is the layer that turns characters a reader has no word for into the
//! characters it does: the ligature `ﬁ` into `fi`, `①` into `1`, `Ⅳ` into `4`,
//! half-width `ｶﾞ` into `ガ`. It is **not** text normalization: nothing here
//! knows a language's numbers, dates or units, and nothing here rewrites a word
//! into another word.
//!
//! # Why it is not an FST
//!
//! The WeText grammar has a preprocessor slot (`full_to_half`), so a character
//! table *could* be a small transducer. It cannot live there, for two reasons
//! that are about order rather than about taste:
//!
//! - the gate in front of the engine (`crate::tn::needs_normalization`) is a
//!   character test, and a sentence holding only `ﬁ`, `①` or `−` is exactly the
//!   sentence it skips. A preprocessor inside the grammar never runs on a skipped
//!   sentence, so the character would be dropped anyway;
//! - half-width kana and the circled numbers need context (`ｶ` + `ﾞ` is one
//!   character; `①②` must not become `12`), which is easier to get right in a
//!   scanner than in a table lookup.
//!
//! # What is deliberately absent
//!
//! - **NFKC.** It maps `，` to `,` and `．` to `.`, which breaks the comma-to-
//!   period pause decision in [`crate::text::normalize_punctuation`] and the
//!   Chinese decimal point the grammar reads; it also maps `™` to `TM`, which
//!   would bypass the symbol table, and `½` to `1⁄2`, which the grammar does not
//!   read.
//! - **U+FF01–FF5E.** The per-language folds own that range (`full_to_half` for
//!   English and Japanese, [`crate::text::to_half_width`] for Chinese), and
//!   Chinese's order is load-bearing: its numeral step must see a full-width `．`
//!   before the fold turns it into a full stop.
//! - **U+200C/U+200D and the variation selectors.** They are part of displayed
//!   text — an emoji sequence, an ideographic variation — and removing them
//!   would change what the page shows and what a highlight covers.

use std::borrow::Cow;

use crate::provenance::SpannedText;
use crate::tn::Lang;

/// The text with the characters no reader can pronounce replaced by ones it can.
///
/// Borrowed when there is nothing to change: this runs once per sentence, and a
/// sentence of ordinary prose should not pay for an allocation.
pub fn fold(text: &str, lang: Lang) -> Cow<'_, str> {
    if text.is_empty() || !needs_fold(text) {
        return Cow::Borrowed(text);
    }
    Cow::Owned(fold_owned(text, lang))
}

/// [`fold`], keeping track of where each character came from.
///
/// The identity fast path is the same one [`fold`] has: a sentence of ordinary
/// prose pays nothing, and its characters came from themselves.
pub fn fold_spanned(text: &str, lang: Lang) -> SpannedText {
    if text.is_empty() || !needs_fold(text) {
        return SpannedText::identity(text);
    }
    fold_owned_spanned(text, lang)
}

/// Whether [`fold`] would change this text.
///
/// A scan rather than a dry run: the whitespace test is the only one that looks
/// at neighbours, and a text that starts or ends with a space, or holds a run of
/// two, is a change even though every character in it is ordinary.
fn needs_fold(text: &str) -> bool {
    let mut after_space = true;
    for ch in text.chars() {
        if ch.is_whitespace() {
            // A single interior space is left alone; anything else — a leading
            // space, a run, or a whitespace that is not U+0020 — is a rewrite.
            if after_space || ch != ' ' {
                return true;
            }
            after_space = true;
            continue;
        }
        if is_trigger(ch) {
            return true;
        }
        after_space = false;
    }
    after_space && !text.is_empty()
}

/// A character the fold has an opinion about.
fn is_trigger(ch: char) -> bool {
    matches!(
        ch,
        '\u{fb00}'..='\u{fb06}'            // ligatures
            | '\u{00ad}' | '\u{200b}' | '\u{2060}' | '\u{feff}' // invisible
            | '\u{00b9}' | '\u{00b2}' | '\u{00b3}'              // ¹ ² ³
            | '\u{2070}' | '\u{2074}'..='\u{2079}'              // ⁰ ⁴–⁹
            | '\u{2080}'..='\u{2089}'                           // ₀–₉
            | '\u{2460}'..='\u{249b}'                           // ①–⑳ ⑴–⒇ ⒈–⒛
            | '\u{3220}'..='\u{3229}'                           // ㈠–㈩
            | '\u{3280}'..='\u{3289}'                           // ㊀–㊉
            | '\u{2160}'..='\u{2188}'                           // Roman, upper and lower
            | '\u{2010}' | '\u{2011}' | '\u{2013}'..='\u{2015}' // dashes
            | '\u{2212}'                                        // minus
            | '\u{ff61}'..='\u{ff9f}'                           // half-width kana
            | '\u{2116}' | '\u{2121}' | '\u{3231}' | '\u{3232}' // № ℡ ㈱ ㈲
    )
}

fn fold_owned(text: &str, lang: Lang) -> String {
    fold_owned_spanned(text, lang).into_text()
}

/// The fold's output, recording what each emitted character came from.
struct FoldOutput {
    text: String,
    origin: Vec<(u32, u32)>,
}

impl FoldOutput {
    /// Emit one character, from the input characters `source` names.
    ///
    /// `source` is a UTF-16 range in the input — one character for everything
    /// ordinary, two for a composed half-width kana. An emission that carries
    /// no source (the space [`Self::push_space`] adds between two others) is
    /// attributed to the character that asked for it, so a word's range reaches
    /// the spacing it was given.
    fn emit(&mut self, source: (u32, u32), ch: char) {
        self.text.push(ch);
        self.origin.push(source);
    }

    /// Emit the characters of `replacement`, from one source range.
    fn emit_str(&mut self, source: (u32, u32), replacement: &str) {
        for ch in replacement.chars() {
            self.emit(source, ch);
        }
    }

    /// Append one space, unless the output already ends with one (or is empty).
    /// Attributed to `source`, like everything else this call emits.
    fn push_space(&mut self, source: (u32, u32)) {
        if !self.text.is_empty() && !self.text.ends_with(' ') {
            self.emit(source, ' ');
        }
    }
}

/// The fold's loop, recording what each emitted character came from.
///
/// Every emission is attributed to the input character that produced it — a
/// replacement string ("number", 株式会社) to its one source character, and a
/// composed half-width kana (ｶ + ﾞ, which the loop consumes as a pair) to the
/// *range* of both, which is what [`crate::provenance::SpannedText`] records.
fn fold_owned_spanned(text: &str, lang: Lang) -> SpannedText {
    let chars: Vec<char> = text.chars().collect();
    // The UTF-16 range of each input character, by index.
    let mut ranges: Vec<(u32, u32)> = Vec::with_capacity(chars.len());
    let mut utf16 = 0u32;
    for ch in &chars {
        let start = utf16;
        utf16 += ch.len_utf16() as u32;
        ranges.push((start, utf16));
    }

    let mut out = FoldOutput {
        text: String::with_capacity(text.len()),
        origin: Vec::with_capacity(chars.len()),
    };
    let mut index = 0;

    while index < chars.len() {
        let ch = chars[index];
        let previous = if index == 0 {
            None
        } else {
            Some(chars[index - 1])
        };
        let next = chars.get(index + 1).copied();
        let source = ranges[index];

        if ch.is_whitespace() {
            out.push_space(source);
            index += 1;
            continue;
        }

        if matches!(ch, '\u{00ad}' | '\u{200b}' | '\u{2060}' | '\u{feff}') {
            index += 1;
            continue;
        }

        if let Some(replacement) = ligature(ch) {
            out.emit_str(source, replacement);
            index += 1;
            continue;
        }

        if let Some(digit) = small_digit(ch) {
            // ² and ³ after a letter or a digit are a unit, not a digit: `x²` is
            // "x squared", `10³` is "ten cubed" — never `103`, which is what a
            // plain digit substitution would produce.
            if (ch == '\u{00b2}' || ch == '\u{00b3}') && previous.is_some_and(char::is_alphanumeric)
            {
                // English needs the space (`x squared`); Chinese and Japanese
                // write the unit onto the number (`x平方`).
                if lang == Lang::En {
                    out.push_space(source);
                }
                out.emit_str(source, squared_word(ch, lang));
            } else {
                out.push_space(source);
                out.emit(source, digit);
                out.push_space(source);
            }
            index += 1;
            continue;
        }

        if let Some(value) = circled_value(ch) {
            out.push_space(source);
            out.emit_str(source, &value.to_string());
            out.push_space(source);
            index += 1;
            continue;
        }

        if let Some(value) = roman_value(ch) {
            out.push_space(source);
            out.emit_str(source, &value.to_string());
            out.push_space(source);
            index += 1;
            continue;
        }

        match ch {
            '\u{2212}' | '\u{2010}' | '\u{2011}' => {
                out.emit(source, '-');
                index += 1;
                continue;
            }
            '\u{2013}' | '\u{2014}' | '\u{2015}' => {
                // A dash between two digits is a range (`1990–1995`); everywhere
                // else it is punctuation this layer has no business rewriting.
                let between_digits = previous.is_some_and(|c| c.is_ascii_digit())
                    && next.is_some_and(|c| c.is_ascii_digit());
                out.emit(source, if between_digits { '-' } else { ch });
                index += 1;
                continue;
            }
            _ => {}
        }

        if ('\u{ff61}'..='\u{ff9f}').contains(&ch) {
            match ch {
                '\u{ff61}' => out.emit(source, '。'),
                '\u{ff62}' => out.emit(source, '「'),
                '\u{ff63}' => out.emit(source, '」'),
                '\u{ff64}' => out.emit(source, '、'),
                '\u{ff65}' => out.emit(source, '・'),
                // An orphan dakuten has no base to voice.
                '\u{ff9e}' | '\u{ff9f}' => {}
                _ => {
                    if let Some(base) = halfwidth_kana(ch) {
                        let mark = next.filter(|c| matches!(c, '\u{ff9e}' | '\u{ff9f}'));
                        match mark.and_then(|mark| compose_kana(base, mark)) {
                            Some(composed) => {
                                // The pair is one character now, and its range
                                // is both input characters'.
                                out.emit((source.0, ranges[index + 1].1), composed);
                                index += 2; // the mark is part of the character
                                continue;
                            }
                            None => out.emit(source, base),
                        }
                    }
                }
            }
            index += 1;
            continue;
        }

        match ch {
            '\u{2116}' => {
                out.emit_str(source, "number");
                out.push_space(source);
            }
            '\u{2121}' => {
                out.emit_str(source, "telephone");
                out.push_space(source);
            }
            '\u{3231}' => out.emit_str(source, "株式会社"),
            '\u{3232}' => out.emit_str(source, "有限会社"),
            _ => out.emit(source, ch),
        }
        index += 1;
    }

    while out.text.ends_with(' ') {
        out.text.pop();
        out.origin.pop();
    }

    SpannedText::from_parts(out.text, out.origin, utf16)
}

fn ligature(ch: char) -> Option<&'static str> {
    Some(match ch {
        '\u{fb00}' => "ff",
        '\u{fb01}' => "fi",
        '\u{fb02}' => "fl",
        '\u{fb03}' => "ffi",
        '\u{fb04}' => "ffl",
        '\u{fb05}' | '\u{fb06}' => "st",
        _ => return None,
    })
}

/// The digit a superscript or subscript character stands for.
fn small_digit(ch: char) -> Option<char> {
    Some(match ch {
        '\u{00b9}' | '\u{2081}' => '1',
        '\u{00b2}' | '\u{2082}' => '2',
        '\u{00b3}' | '\u{2083}' => '3',
        '\u{2070}' | '\u{2080}' => '0',
        '\u{2074}' | '\u{2084}' => '4',
        '\u{2075}' | '\u{2085}' => '5',
        '\u{2076}' | '\u{2086}' => '6',
        '\u{2077}' | '\u{2087}' => '7',
        '\u{2078}' | '\u{2088}' => '8',
        '\u{2079}' | '\u{2089}' => '9',
        _ => return None,
    })
}

fn squared_word(ch: char, lang: Lang) -> &'static str {
    match (lang, ch) {
        (Lang::En, '\u{00b2}') => "squared",
        (Lang::En, _) => "cubed",
        (_, '\u{00b2}') => "平方",
        (_, _) => "立方",
    }
}

/// ①–⑳, ⑴–⒇, ⒈–⒛, ㈠–㈩, ㊀–㊉, by their contiguous blocks.
fn circled_value(ch: char) -> Option<u32> {
    let code = ch as u32;
    let value = if (0x2460..=0x2473).contains(&code) {
        code - 0x2460 + 1
    } else if (0x2474..=0x2487).contains(&code) {
        code - 0x2474 + 1
    } else if (0x2488..=0x249b).contains(&code) {
        code - 0x2488 + 1
    } else if (0x3220..=0x3229).contains(&code) {
        code - 0x3220 + 1
    } else if (0x3280..=0x3289).contains(&code) {
        code - 0x3280 + 1
    } else {
        return None;
    };
    Some(value)
}

/// The value of a Roman-numeral code point. Decimal straight away: going via the
/// ASCII letters would lose the only signal that the character was a numeral at
/// all (`I` and `V` are ordinary letters in running text).
fn roman_value(ch: char) -> Option<u32> {
    let code = ch as u32;
    let value = match code {
        0x2160..=0x216b | 0x2170..=0x217b => (code & 0x0f) + 1,
        0x216c..=0x216f => [50, 100, 500, 1000][(code - 0x216c) as usize],
        0x217c..=0x217f => [50, 100, 500, 1000][(code - 0x217c) as usize],
        0x2180 => 1000,
        0x2181 => 5000,
        0x2182 => 10000,
        0x2185 => 6,
        0x2186 => 50,
        0x2187 => 50000,
        0x2188 => 100000,
        _ => return None,
    };
    Some(value)
}

/// Half-width katakana to its full-width form, one character at a time.
///
/// The composed forms (゛ ゜) are not here: they are marks, and [`compose_kana`]
/// is what turns a base plus a mark into one character.
fn halfwidth_kana(ch: char) -> Option<char> {
    Some(match ch {
        '\u{ff66}' => 'ヲ',
        '\u{ff67}' => 'ァ',
        '\u{ff68}' => 'ィ',
        '\u{ff69}' => 'ゥ',
        '\u{ff6a}' => 'ェ',
        '\u{ff6b}' => 'ォ',
        '\u{ff6c}' => 'ャ',
        '\u{ff6d}' => 'ュ',
        '\u{ff6e}' => 'ョ',
        '\u{ff6f}' => 'ッ',
        '\u{ff70}' => 'ー',
        '\u{ff71}' => 'ア',
        '\u{ff72}' => 'イ',
        '\u{ff73}' => 'ウ',
        '\u{ff74}' => 'エ',
        '\u{ff75}' => 'オ',
        '\u{ff76}' => 'カ',
        '\u{ff77}' => 'キ',
        '\u{ff78}' => 'ク',
        '\u{ff79}' => 'ケ',
        '\u{ff7a}' => 'コ',
        '\u{ff7b}' => 'サ',
        '\u{ff7c}' => 'シ',
        '\u{ff7d}' => 'ス',
        '\u{ff7e}' => 'セ',
        '\u{ff7f}' => 'ソ',
        '\u{ff80}' => 'タ',
        '\u{ff81}' => 'チ',
        '\u{ff82}' => 'ツ',
        '\u{ff83}' => 'テ',
        '\u{ff84}' => 'ト',
        '\u{ff85}' => 'ナ',
        '\u{ff86}' => 'ニ',
        '\u{ff87}' => 'ヌ',
        '\u{ff88}' => 'ネ',
        '\u{ff89}' => 'ノ',
        '\u{ff8a}' => 'ハ',
        '\u{ff8b}' => 'ヒ',
        '\u{ff8c}' => 'フ',
        '\u{ff8d}' => 'ヘ',
        '\u{ff8e}' => 'ホ',
        '\u{ff8f}' => 'マ',
        '\u{ff90}' => 'ミ',
        '\u{ff91}' => 'ム',
        '\u{ff92}' => 'メ',
        '\u{ff93}' => 'モ',
        '\u{ff94}' => 'ヤ',
        '\u{ff95}' => 'ユ',
        '\u{ff96}' => 'ヨ',
        '\u{ff97}' => 'ラ',
        '\u{ff98}' => 'リ',
        '\u{ff99}' => 'ル',
        '\u{ff9a}' => 'レ',
        '\u{ff9b}' => 'ロ',
        '\u{ff9c}' => 'ワ',
        '\u{ff9d}' => 'ン',
        _ => return None,
    })
}

/// A full-width kana plus a dakuten/handakuten, as one character.
///
/// A pair this table does not know (a mark on a vowel with no voiced form) is
/// left uncomposed; the caller then emits the base and drops the mark, which is
/// what a reader would do with `ｱﾞ` as well.
fn compose_kana(base: char, mark: char) -> Option<char> {
    let voiced = mark == '\u{ff9e}';
    Some(match (base, voiced) {
        ('カ', true) => 'ガ',
        ('キ', true) => 'ギ',
        ('ク', true) => 'グ',
        ('ケ', true) => 'ゲ',
        ('コ', true) => 'ゴ',
        ('サ', true) => 'ザ',
        ('シ', true) => 'ジ',
        ('ス', true) => 'ズ',
        ('セ', true) => 'ゼ',
        ('ソ', true) => 'ゾ',
        ('タ', true) => 'ダ',
        ('チ', true) => 'ヂ',
        ('ツ', true) => 'ヅ',
        ('テ', true) => 'デ',
        ('ト', true) => 'ド',
        ('ハ', true) => 'バ',
        ('ヒ', true) => 'ビ',
        ('フ', true) => 'ブ',
        ('ヘ', true) => 'ベ',
        ('ホ', true) => 'ボ',
        ('ウ', true) => 'ヴ',
        ('ワ', true) => 'ヷ',
        ('ヰ', true) => 'ヸ',
        ('ヱ', true) => 'ヹ',
        ('ヲ', true) => 'ヺ',
        ('ハ', false) => 'パ',
        ('ヒ', false) => 'ピ',
        ('フ', false) => 'プ',
        ('ヘ', false) => 'ペ',
        ('ホ', false) => 'ポ',
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn folded(text: &str, lang: Lang) -> String {
        fold(text, lang).into_owned()
    }

    #[test]
    fn collapses_whitespace_and_trims() {
        assert_eq!(folded("a  b", Lang::En), "a b");
        assert_eq!(folded("  a\tb\n", Lang::En), "a b");
        assert_eq!(folded("a\u{00a0}b", Lang::En), "a b");
        assert_eq!(folded("a\u{3000}b", Lang::En), "a b");
        assert_eq!(folded("", Lang::En), "");
        assert_eq!(folded("   ", Lang::En), "");
    }

    #[test]
    fn folds_ligatures() {
        assert_eq!(folded("The ﬁle is ﬂat", Lang::En), "The file is flat");
        assert_eq!(folded("aﬀ bﬃ cﬄ", Lang::En), "aff bffi cffl");
    }

    #[test]
    fn folds_scripts_and_symbols() {
        assert_eq!(folded("Ⅳ", Lang::En), "4");
        assert_eq!(folded("Ⅻ", Lang::En), "12");
        assert_eq!(folded("ⅼ", Lang::En), "50");
        assert_eq!(folded("①②", Lang::En), "1 2");
        assert_eq!(folded("㈠", Lang::En), "1");
        assert_eq!(folded("㊉", Lang::En), "10");
    }

    #[test]
    fn folds_superscripts_with_context() {
        assert_eq!(folded("x²", Lang::En), "x squared");
        assert_eq!(folded("10³", Lang::En), "10 cubed");
        assert_eq!(folded("H₂O", Lang::En), "H 2 O");
        assert_eq!(folded("x²", Lang::Zh), "x平方");
        assert_eq!(folded("x³", Lang::Ja), "x立方");
        assert_eq!(folded("²", Lang::En), "2");
    }

    #[test]
    fn folds_dashes_and_minus() {
        assert_eq!(folded("a−b", Lang::En), "a-b");
        assert_eq!(folded("1990–1995", Lang::En), "1990-1995");
        assert_eq!(folded("a–b", Lang::En), "a–b");
        assert_eq!(folded("5‑10", Lang::En), "5-10");
    }

    #[test]
    fn drops_invisible_characters() {
        assert_eq!(folded("a\u{00ad}b", Lang::En), "ab");
        assert_eq!(folded("a\u{200b}b", Lang::En), "ab");
        assert_eq!(folded("\u{feff}a", Lang::En), "a");
    }

    #[test]
    fn composes_halfwidth_kana() {
        assert_eq!(folded("ｶﾞｷﾞ", Lang::Ja), "ガギ");
        assert_eq!(folded("ﾊﾟﾋﾟ", Lang::Ja), "パピ");
        assert_eq!(folded("ｳﾞ", Lang::Ja), "ヴ");
        assert_eq!(folded("ｶﾀｶﾅ", Lang::Ja), "カタカナ");
        assert_eq!(folded("｡｢｣､･", Lang::Ja), "。「」、・");
        // An orphan mark has nothing to voice and disappears.
        assert_eq!(folded("aﾞ", Lang::Ja), "a");
    }

    #[test]
    fn folds_named_characters() {
        assert_eq!(folded("№5", Lang::En), "number 5");
        assert_eq!(folded("℡", Lang::En), "telephone");
        assert_eq!(folded("㈱", Lang::Ja), "株式会社");
        assert_eq!(folded("㈲", Lang::Ja), "有限会社");
    }

    #[test]
    fn leaves_the_per_language_folds_alone() {
        for text in ["ＡＢＣ", "１２３", "，", "．", "™", "½"] {
            assert_eq!(fold(text, Lang::En), text, "{text:?} must survive");
        }
        // Joiners and variation selectors are displayed text.
        assert_eq!(
            fold("\u{200d}\u{200c}\u{fe0f}", Lang::En),
            "\u{200d}\u{200c}\u{fe0f}"
        );
    }

    #[test]
    fn is_idempotent() {
        let cases = [
            ("a  b", Lang::En),
            ("The ﬁle", Lang::En),
            ("H₂O", Lang::En),
            ("x²", Lang::En),
            ("①②", Lang::En),
            ("Ⅳ", Lang::En),
            ("ｶﾞｷﾞ", Lang::Ja),
            ("№5", Lang::En),
            ("x²", Lang::Zh),
        ];
        for (text, lang) in cases {
            let once = fold(text, lang).into_owned();
            let twice = fold(&once, lang).into_owned();
            assert_eq!(once, twice, "{text:?}");
        }
    }
}
