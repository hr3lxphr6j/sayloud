//! The vocabulary gate: what stops a phoneme the model cannot use.
//!
//! The two Kokoro models do not share a phoneme inventory. v1.0 keeps 115
//! characters and speaks IPA with four tone arrows; v1.1-zh keeps 172 and speaks
//! zhuyin with tone digits, a `/` between words and an `R` for 儿化. Each has
//! characters the other does not — nine and sixty-six of them — so the frontend
//! has to follow the *voice the user picked* and not the language of the page,
//! and getting it wrong is not a subtle quality difference:
//!
//! > The tokenizer's normaliser is a `Replace` with the empty string. A phoneme
//! > outside the vocabulary is not reported, it is deleted, and the word is heard
//! > without it.
//!
//! That is why this is a gate and not a warning. It was found the hard way on the
//! Japanese path (`P5 §4.2.1`): the kana table wrote an ASCII `g` where the
//! vocabulary has `ɡ` (U+0261), every ガ行 syllable was read as ア行, and nothing
//! noticed because the output was a string of perfectly valid-looking IPA.
//!
//! # Two things are allowed through
//!
//! - **`\u{032F}` and `\u{0329}`.** The normaliser strips both, and neither is in
//!   either vocabulary: `\u{032F}` is in 好's IPA (`xau̯`), `\u{0329}` in 世's
//!   (`ʂɻ̩`). Rejecting them would reject every Japanese sentence.
//! - **Whitespace**, which is a separator rather than a phoneme.
//!
//! # One thing is repaired rather than refused
//!
//! the CMU dictionary reads `never` as `nˈɛvɚ`, and v1.1-zh has no `ɚ` — so the
//! tokenizer
//! would silently drop the rhotic and the word would lose its last sound. `əɹ` is
//! what it should have been, and both characters are in the vocabulary. The
//! substitution is per vocabulary rather than global, because v1.0 *does* have
//! `ɚ` and replacing it there would change phonemes the model was trained on.

use std::borrow::Cow;
use std::collections::HashSet;
use std::sync::OnceLock;

/// v1.0's vocabulary: 115 characters, IPA, four tone arrows.
const VOCABULARY_V1: &str = include_str!("../data/vocab-v1.txt");
/// v1.1-zh's vocabulary: 172 characters, zhuyin, tone digits.
const VOCABULARY_V11_ZH: &str = include_str!("../data/vocab-v11-zh.txt");

/// The two combining marks the tokenizer's normaliser strips.
///
/// Allowed by name rather than by being in the vocabulary, because they are not
/// in it and never will be — the normaliser removes them, and the pipeline
/// produces them (`\u{032F}` from the syllable table, `\u{0329}` from the kana
/// table). `P5 §4.2.1` states this as a hard requirement, and it is the whole
/// reason the check is "in the vocabulary, or one of these two" rather than
/// "in the vocabulary".
const STRIPPED_BY_THE_NORMALIZER: [char; 2] = ['\u{032F}', '\u{0329}'];

/// Which phoneme inventory the output has to belong to.
///
/// The names are the frontend ids the JavaScript side uses (`FrontendId` in
/// `lib/models/phonemize-rust.ts`), spelled as the model versions they are:
/// `V1_0` is `kokoro-v1` and `V1_1_ZH` is `kokoro-v11-zh`. The underscores are
/// deliberate — `V1_1Zh` would read as a different model name — which is why the
/// usual casing lint is off for this enum.
#[allow(non_camel_case_types)]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Vocab {
    V1_0,
    V1_1_ZH,
}

impl Vocab {
    /// The vocabulary a frontend uses, or `None` for a frontend this build does
    /// not know.
    pub fn for_frontend(frontend: &str) -> Option<Self> {
        match frontend {
            "kokoro-v1" => Some(Self::V1_0),
            "kokoro-v11-zh" => Some(Self::V1_1_ZH),
            _ => None,
        }
    }

    /// The frontend id, for a message a reader can act on.
    pub fn name(self) -> &'static str {
        match self {
            Self::V1_0 => "kokoro-v1",
            Self::V1_1_ZH => "kokoro-v11-zh",
        }
    }

    /// Every character the model's tokenizer keeps.
    pub fn characters(self) -> impl Iterator<Item = char> {
        self.set().iter().copied()
    }

    /// Characters this vocabulary does not have, and what to write instead.
    ///
    /// One entry, and it is not a style choice: see the module docs.
    pub fn substitutions(self) -> &'static [(char, &'static str)] {
        match self {
            Self::V1_0 => &[],
            Self::V1_1_ZH => &[('ɚ', "əɹ")],
        }
    }

    /// Rewrite what this vocabulary cannot express into what it can.
    ///
    /// Borrows when there is nothing to rewrite, which is the common case: this
    /// runs on every phonemize call.
    pub fn repair(self, phonemes: &str) -> Cow<'_, str> {
        let substitutions = self.substitutions();
        if !substitutions
            .iter()
            .any(|(from, _)| phonemes.contains(*from))
        {
            return Cow::Borrowed(phonemes);
        }

        let mut repaired = phonemes.to_string();
        for (from, to) in substitutions {
            if repaired.contains(*from) {
                repaired = repaired.replace(*from, to);
            }
        }
        Cow::Owned(repaired)
    }

    /// The vocabulary, parsed on first use.
    fn set(self) -> &'static HashSet<char> {
        match self {
            Self::V1_0 => VOCABULARY_V1_CHARS.get_or_init(|| parse_vocabulary(VOCABULARY_V1)),
            Self::V1_1_ZH => {
                VOCABULARY_V11_ZH_CHARS.get_or_init(|| parse_vocabulary(VOCABULARY_V11_ZH))
            }
        }
    }
}

/// Check that every character can survive the tokenizer.
///
/// Returns every character that cannot, deduplicated and in the order it appears:
/// a report that stopped at the first one would make a systematically wrong table
/// look like a single typo.
pub fn validate_phonemes(phonemes: &str, vocab: Vocab) -> Result<(), VocabError> {
    let characters = vocab.set();
    let mut missing: Vec<char> = Vec::new();

    for character in phonemes.chars() {
        if character.is_whitespace()
            || characters.contains(&character)
            || STRIPPED_BY_THE_NORMALIZER.contains(&character)
        {
            continue;
        }
        if !missing.contains(&character) {
            missing.push(character);
        }
    }

    if missing.is_empty() {
        return Ok(());
    }

    Err(VocabError {
        vocab,
        characters: missing,
        phonemes: phonemes.to_string(),
    })
}

/// Phonemes the chosen model's tokenizer would drop.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VocabError {
    /// Which vocabulary was being checked, and therefore which voice was chosen.
    pub vocab: Vocab,
    /// The characters it does not have, deduplicated, in the order they appear.
    pub characters: Vec<char>,
    /// The phonemes, so a log line has the context without a second lookup.
    pub phonemes: String,
}

impl VocabError {
    /// A stable code for the JavaScript side.
    pub fn code(&self) -> &'static str {
        "vocabulary-mismatch"
    }
}

impl std::fmt::Display for VocabError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "the {} vocabulary has no {} in {:?} — the tokenizer would drop {} silently, \
             so the voice and the language disagree",
            self.vocab.name(),
            describe(&self.characters),
            self.phonemes,
            if self.characters.len() == 1 {
                "it"
            } else {
                "them"
            },
        )
    }
}

impl std::error::Error for VocabError {}

/// The characters, each with its code point.
///
/// The code point is not decoration: two of the characters that matter here are
/// indistinguishable at a glance, `g` (U+0067) and `ɡ` (U+0261), and a message
/// that showed only the glyph would look like a message about nothing.
fn describe(characters: &[char]) -> String {
    characters
        .iter()
        .map(|character| format!("{character} (U+{:04X})", *character as u32))
        .collect::<Vec<_>>()
        .join(", ")
}

/// Parse a vocabulary file: one character per line, `# …` as a comment.
///
/// A character that does not render on its own — the space, the combining marks —
/// is written `U+XXXX`, so that a line is never a bare space and no editor can
/// strip one away.
///
/// **Panics on malformed data, deliberately.** The files are generated by
/// `scripts/generate/gen-kokoro-vocab.mjs`, whose `--check` mode is what verifies them, so
/// a broken one is a build error rather than a runtime condition; the tests
/// construct both vocabularies, so a malformed file fails there rather than in
/// the wasm.
fn parse_vocabulary(content: &'static str) -> HashSet<char> {
    content
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(|line| {
            let field = line
                .split('#')
                .next()
                .expect("`split` yields at least one piece")
                .trim();
            match field.strip_prefix("U+") {
                Some(hex) => {
                    let code = u32::from_str_radix(hex, 16)
                        .unwrap_or_else(|_| panic!("vocab: {hex:?} is not a code point"));
                    char::from_u32(code).unwrap_or_else(|| panic!("vocab: U+{hex} is not a char"))
                }
                None => {
                    let mut characters = field.chars();
                    let character = characters
                        .next()
                        .unwrap_or_else(|| panic!("vocab: no character on {line:?}"));
                    assert!(
                        characters.next().is_none(),
                        "vocab: {field:?} is more than one character — write U+XXXX for one that \
                         does not render on its own"
                    );
                    character
                }
            }
        })
        .collect()
}

static VOCABULARY_V1_CHARS: OnceLock<HashSet<char>> = OnceLock::new();
static VOCABULARY_V11_ZH_CHARS: OnceLock<HashSet<char>> = OnceLock::new();
