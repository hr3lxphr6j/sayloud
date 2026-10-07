//! The rule engine: a spelling to a phoneme string, one rule at a time.
//!
//! [`phonemize_native`] is a port of `Language#phonemizeWord` from HeadTTS's
//! `modules/language-en-us.mjs` (MIT — see `NOTICE` beside this file), which is
//! an adaptation of the letter-to-sound rules of NRL Report 7948. The rules
//! themselves are [`super::rules`], generated from upstream; this file is the
//! loop around them, and it is deliberately a transcription of upstream's loop
//! rather than a better one.
//!
//! # The loop
//!
//! Left to right over the normalized word. At each position, take the character
//! there, and try that character's rules in order; the first one whose regular
//! expression matches wins and emits its phonemes, and the position advances by
//! the *length of the pattern* — not by one, so `[TH]` consumes two characters
//! and `[TION]` four. A character with no rule group is skipped, which is what
//! makes a hyphen survive: it is not spelled, it is echoed.
//!
//! Two details of upstream's loop are load-bearing and are reproduced exactly:
//!
//! **Only the character at the current position is lower-cased before the
//! match.** Every rule's pattern keeps its first letter in lower case (that is
//! how upstream's constructor expands `[THE]` — `ctxLetters[0].toLowerCase()`),
//! so the one lower-case character in the string is the *anchor*: a pattern has
//! to line up there and nowhere else. Written as a port of the regular
//! expressions rather than of the rules, this is what turns an unanchored
//! `RegExp#match` — which searches the whole string and returns the leftmost hit
//! — into "does this rule apply at this position?".
//!
//! **The patterns are matched, not tested.** `String#match` returns the leftmost
//! match anywhere in the string, so the same regular expression is asked a
//! question about the whole word every time. The port does that too — it rebuilds
//! the same string with one character lower-cased and searches it — because
//! anchoring the expression instead would be a different question, and this
//! module is a port, not a rewrite. Words are short; the cost is a `Regex::find`
//! per rule tried, over at most a couple of dozen bytes.
//!
//! # The regular expressions are compiled once, at the first word that needs them
//!
//! There are 309, and compiling them all up front would spend milliseconds on the
//! first OOV word a sentence happens to contain — and, worse, would spend them in
//! `prepare` on a language that may never phonemize English at all. [`CACHE`]
//! compiles each one the first time a rule is tried, and keeps it. A rule that is
//! never tried is never compiled, and the rules a word does not reach cost a hash
//! lookup each.
//!
//! `Regex` is `Arc` inside, so handing one out of the cache is a refcount bump
//! and not a copy of the compiled program.
//!
//! # Upstream's infinite loop
//!
//! Upstream's loop has no "no rule matched" case: `i` is only advanced inside the
//! `if ( matches )` branch, so a character whose every rule failed would spin
//! forever. It cannot happen — every group ends in a bare `[X]`, whose pattern is
//! that one letter and therefore always matches — and the port turns the
//! unreachable case into [`None`] rather than into an advance, because "I cannot
//! read this word" is an answer the caller can act on (it spells the word out
//! instead) and a dropped phoneme is not.

use once_cell::sync::Lazy;
use regex::Regex;
use std::collections::HashMap;
use std::sync::Mutex;

use super::rules;
/// One rule: a pattern, how far it moves the position, and what it says.
///
/// The fields are upstream's `{regex, move, phonemes}` with `move` renamed to
/// what it is: the number of characters of the *word* the rule consumes, which is
/// the length of the pattern inside `[` `]` and not anything about the regular
/// expression.
#[derive(Debug, PartialEq)]
pub struct Rule {
    /// The expanded regular expression, as `RegExp#source`.
    pub regex: &'static str,
    /// How many characters of the word this rule consumes.
    pub advance: u8,
    /// The phonemes, in HeadTTS's own notation. [`to_ipa`] translates.
    pub phonemes: &'static str,
}

/// Compiled regular expressions, one per rule, filled in on first use.
///
/// Not a `Lazy<Vec<Regex>>`: that would compile all 309 to answer a question
/// about one. The key is the pattern itself rather than an index, because that is
/// what the cache has to be looked up with — the rule carries its pattern, and an
/// index would have to be threaded through every call for a lookup that the
/// string already answers.
///
/// The values are leaked so that they can be handed out by reference; see
/// [`compiled`] for why a reference and not a clone, which is the difference
/// between a match costing 60 ns and costing 3.5 µs.
static CACHE: Lazy<Mutex<HashMap<&'static str, &'static Regex>>> =
    Lazy::new(|| Mutex::new(HashMap::new()));

/// The compiled form of one rule's pattern, or `None` if it will not compile.
///
/// `None` rather than a panic: this runs inside the wasm, where a panic takes the
/// worker with it. It should not happen — the patterns come from upstream and
/// `tests/headtts_en.rs` compiles all 309 of them — but the failure mode of a
/// panic is a dead worker and the failure mode of `None` is a word read out
/// letter by letter.
///
/// # Why this hands out a reference and not a clone
///
/// Cloning a `regex::Regex` clones the compiled program and **not** its lazy DFA
/// cache, and a cache-cold match re-derives the DFA on the way in. Measured on
/// this module's own patterns, a 13-byte haystack and one pattern:
///
/// | | per `is_match` |
/// |---|---|
/// | the same handle, reused | 34–62 ns |
/// | a fresh clone every call | 3,549 ns |
///
/// That is 60–100×, and it is not a micro-optimisation here: a word tries ~92
/// rules, so a clone per rule costs ~180 µs per OOV word against ~6 µs. The first
/// version of this function did clone, and this paragraph is what it cost —
/// measured before and after, on the same corpus, by the numbers above.
///
/// Leaking is what makes the reference possible: the entry can never be removed,
/// so its address is valid for the life of the process, and the cache is bounded
/// by the rule table — 309 entries, at most, once each. A `Lazy<Vec<...>>` of
/// `OnceLock`s would avoid `Box::leak` and the `Mutex` together, but it would have
/// to be indexed by something, and the rule carries its pattern rather than its
/// index.
fn compiled(pattern: &'static str) -> Option<&'static Regex> {
    let mut cache = CACHE.lock().unwrap_or_else(|error| error.into_inner());
    if let Some(regex) = cache.get(pattern).copied() {
        return Some(regex);
    }
    let regex: &'static Regex = Box::leak(Box::new(Regex::new(pattern).ok()?));
    cache.insert(pattern, regex);
    Some(regex)
}

/// Fold a word into the alphabet the rules are written in.
///
/// Upstream's `normalizeUpper`, minus the one branch that cannot be reached here:
/// the letters it keeps, the punctuation it echoes, the ligatures it expands, and
/// everything else dropped. `A1` becomes `A`, `don't` becomes `DON'T`, and
/// `ß` becomes `SS`.
///
/// **The diacritic branch is not ported.** Upstream strips the combining marks
/// from `É` and then keeps the `E`; this drops the `É`. That is a real
/// difference, and it is one the pipeline cannot reach: a Latin run is
/// `segment_text`'s `[A-Za-z]+` and has no accented letter in it to fold. Porting
/// it would mean carrying a Unicode decomposition table into the wasm for input
/// no caller can produce, which is the trade this module declines to make —
/// documented rather than silently different.
pub fn normalize(word: &str) -> String {
    let mut normalized = String::with_capacity(word.len());
    for character in word.chars() {
        // `char::to_uppercase` is what expands `ß` to `SS`; the seven entries
        // below are the ligatures whose upper case is still not a letter of the
        // A-Z alphabet upstream's rules are written over.
        for upper in character.to_uppercase() {
            match upper {
                'A'..='Z' => normalized.push(upper),
                'Ø' => normalized.push('O'),
                'Æ' => normalized.push_str("AE"),
                'Œ' => normalized.push_str("OE"),
                'Ð' => normalized.push('D'),
                'Þ' => normalized.push_str("TH"),
                'Ł' => normalized.push('L'),
                // `punctuations`, which `phonemizeWord` echoes rather than
                // spells. Only the entries that are not their own value need an
                // arm; the rest fall through to the second match below.
                '¡' => normalized.push('!'),
                '¿' => normalized.push('?'),
                '«' | '»' | '“' | '”' => normalized.push('"'),
                '{' | '[' => normalized.push('('),
                '}' | ']' => normalized.push(')'),
                ';' | ':' | ',' | '.' | '!' | '?' | '—' | '"' | '…' | '(' | ')' | ' ' | '-'
                | '\'' => normalized.push(upper),
                // Dropped, which is upstream's answer for a character in neither
                // table — a digit, most importantly, and a diacritic.
                _ => {}
            }
        }
    }
    normalized
}

/// The phonemes HeadTTS's rules give a word, in HeadTTS's own notation.
///
/// `word` may be any case; it is normalized first. An empty string is a real
/// answer — `H` is silent, so a word of nothing but `H` reads as nothing. `None`
/// is the loop giving up: a letter whose every rule failed to match, which
/// upstream's table cannot produce (every group ends in a bare `[X]`, whose
/// pattern is that one letter) and which upstream's loop would spin forever on
/// instead. See the module docs.
///
/// The notation is misaki's, not IPA: `A` for `eɪ`, `I` for `aɪ`, `ʧ` for `tʃ`,
/// `ɜ ɹ` for the r-coloured vowel. [`to_ipa`] is what the pipeline wants; this
/// function is what the parity test wants, because it is what upstream returns.
pub fn phonemize_native(word: &str) -> Option<String> {
    let mut phonemes = String::new();
    scan(&normalize(word), &mut phonemes, &mut Vec::new())?;
    Some(phonemes)
}

/// Which rules fired, as `(letter, index within that letter's group)`.
///
/// The trace `tests/headtts_en.rs` checks the fixture's coverage with: a rule
/// that no word in the corpus can reach is either a gap in the corpus or a rule
/// that cannot fire, and the difference matters enough to be asserted rather than
/// assumed. Upstream's loop is shared with [`phonemize_native`], so this cannot
/// disagree with it about which rule won.
pub fn trace(word: &str) -> Option<Vec<(char, usize)>> {
    let mut hits = Vec::new();
    scan(&normalize(word), &mut String::new(), &mut hits)?;
    Some(hits)
}

/// Walk the normalized word, appending each phoneme and each rule that won.
///
/// The `(letter, index)` pair is what the trace needs and what a rule alone
/// cannot say: the same `Rule` is reachable from more than one letter in
/// principle, and the index is how the fixture's coverage is recorded. Both
/// callers above share this loop, so the trace cannot disagree with the reading
/// about which rule won.
fn scan(word: &str, phonemes: &mut String, hits: &mut Vec<(char, usize)>) -> Option<()> {
    let mut characters: Vec<char> = word.chars().collect();
    let mut position = 0;

    while position < characters.len() {
        let letter = characters[position];

        // A punctuation is echoed and does not consume a rule. Upstream tests
        // this before the rules, which is why `well-known` keeps its hyphen
        // rather than spelling it.
        if is_punctuation(letter) {
            phonemes.push(letter);
            position += 1;
            continue;
        }

        let group = match rules::group(letter) {
            Some(group) => group,
            // No rules for this character: no phonemes either, and the position
            // still advances — upstream's `else { i++ }`.
            None => {
                position += 1;
                continue;
            }
        };

        // The anchor: exactly one character of the string is lower case, and it
        // is this one. See the module docs.
        let restore = characters[position];
        characters[position] = letter.to_ascii_lowercase();
        let anchor: String = characters.iter().collect();

        let mut matched = None;
        for (index, rule) in group.iter().enumerate() {
            let Some(regex) = compiled(rule.regex) else {
                continue;
            };
            if regex.is_match(&anchor) {
                matched = Some((index, rule));
                break;
            }
        }

        characters[position] = restore;

        let (index, rule) = matched?;
        phonemes.push_str(rule.phonemes);
        hits.push((letter, index));
        position += rule.advance as usize;
    }

    Some(())
}

/// Whether `character` is one of the punctuations upstream echoes.
///
/// The set is `LanguageBase#punctuations` after `normalizeUpper` has already
/// folded the pairs that differ — so `¡` is a `!` by the time it arrives here, and
/// this is the identity half of the table.
fn is_punctuation(character: char) -> bool {
    matches!(
        character,
        ';' | ':' | ',' | '.' | '!' | '?' | '—' | '"' | '…' | '(' | ')' | ' ' | '-' | '\''
    )
}

/// HeadTTS's misaki notation rewritten as the IPA the rest of the pipeline uses.
///
/// Seven substitutions, and each is a spelling rather than a sound: HeadTTS
/// carries misaki's one-character aliases for the diphthongs (`A` is `eɪ`) and
/// its `ʧ`/`ʤ` ligatures, and every other symbol it emits is already IPA. The
/// dictionary side of the English pipeline writes `tʃ`, `oʊ` and `aɪ`, and one
/// sentence reads through both — a word in the dictionary and a word outside it —
/// so the two notations have to agree or a sentence would mix them.
///
/// The output is looked up in `vocab-v1.txt` by the frontend's gate, so the
/// choice matters beyond tidiness: both notations are in the vocabulary, but only
/// this one is the notation the English dictionary path already writes, so the
/// choice changes OOV words alone.
///
/// **`ɜɹ` is left alone.** Upstream's rules give `ER` as `ɚ`, which misaki writes
/// `ɜ ɹ`; the dictionary side of this pipeline writes `ɜː` for a stressed `ER1`
/// (`world` → `wˈɜːld`). Folding one into the other needs the stress the rule
/// engine has already decided, and the difference is between two symbols the
/// vocabulary has and the model was trained on both — so it is recorded here as a
/// known divergence rather than papered over.
pub fn to_ipa(native: &str) -> String {
    let mut ipa = String::with_capacity(native.len());
    for character in native.chars() {
        match character {
            'ʧ' => ipa.push_str("tʃ"),
            'ʤ' => ipa.push_str("dʒ"),
            'A' => ipa.push_str("eɪ"),
            'I' => ipa.push_str("aɪ"),
            'W' => ipa.push_str("aʊ"),
            'Y' => ipa.push_str("ɔɪ"),
            'O' => ipa.push_str("oʊ"),
            other => ipa.push(other),
        }
    }
    ipa
}

#[cfg(test)]
mod tests {
    use super::*;

    fn native(word: &str) -> String {
        phonemize_native(word).expect("a word of letters always has a rule")
    }

    #[test]
    fn normalization_is_upstreams() {
        assert_eq!(normalize("tough"), "TOUGH");
        assert_eq!(normalize("GitHub"), "GITHUB");
        // A digit is in neither table upstream, and is dropped.
        assert_eq!(normalize("A1"), "A");
        assert_eq!(normalize("don't"), "DON'T");
        assert_eq!(normalize("well-known"), "WELL-KNOWN");
        assert_eq!(normalize("straße"), "STRASSE");
        assert_eq!(normalize("Æon"), "AEON");
        // The one branch that is not ported: upstream folds `É` to `E`.
        assert_eq!(normalize("café"), "CAF");
    }

    #[test]
    fn every_rule_compiles() {
        // The cache hands out `None` for a pattern that will not compile, and a
        // rule that does not compile is a rule that silently never fires. This is
        // where that would be caught, rather than by a word sounding wrong three
        // layers away.
        for rule in rules::RULES {
            assert!(
                Regex::new(rule.regex).is_ok(),
                "{:?} is not a regular expression this crate accepts",
                rule.regex
            );
        }
        assert_eq!(rules::RULES.len(), 309);
    }

    #[test]
    fn a_pattern_anchors_at_the_position_it_is_tried_at() {
        // `[THE] =DH AX` needs a word boundary after `THE`, and `THET` has the
        // letter `T` there — so the same three letters read differently, which
        // is the left context doing its work.
        assert_eq!(native("THE"), "ðə");
        assert_eq!(native("THET"), "θɛt");
    }

    #[test]
    fn a_rule_consumes_its_whole_pattern() {
        // `[TH]` advances two characters, so the `H` is not visited twice — if it
        // were, the word would end in a second `h`.
        assert_eq!(native("TH"), "θ");
        assert_eq!(native("THING"), "θɪŋ");
    }

    #[test]
    fn punctuation_is_echoed_and_not_spelled() {
        assert_eq!(native("WELL-KNOWN"), "wɛl-nOn");
        assert_eq!(native("DON'T"), "dOnt");
    }

    #[test]
    fn the_ipa_translation_is_the_seven_aliases() {
        assert_eq!(to_ipa("ʧæt"), "tʃæt");
        assert_eq!(to_ipa("ʤəb"), "dʒəb");
        assert_eq!(to_ipa("tIm"), "taɪm");
        assert_eq!(to_ipa("hOm"), "hoʊm");
        assert_eq!(to_ipa("nW"), "naʊ");
        assert_eq!(to_ipa("bY"), "bɔɪ");
        assert_eq!(to_ipa("dA"), "deɪ");
        // Everything else passes through, including the stress marks.
        assert_eq!(to_ipa("kɑkɔɹO"), "kɑkɔɹoʊ");
        assert_eq!(to_ipa("ˈɛks"), "ˈɛks");
    }

    #[test]
    fn a_word_with_no_letters_is_empty_rather_than_none() {
        // Not a failure: there was nothing to fail at. The caller decides what an
        // empty reading means, the same way it does for the dictionary.
        assert_eq!(phonemize_native("123"), Some(String::new()));
        assert_eq!(phonemize_native(""), Some(String::new()));
    }

    #[test]
    fn the_trace_names_the_rules_that_won() {
        // `AE` is the A group's last rule and the E group's, so a bare `AE` is
        // two fallbacks — which is what a trace of the loop looks like.
        let rules = trace("AE").expect("traces");
        assert_eq!(rules.len(), 2);
        assert_eq!(rules[0].0, 'A');
        assert_eq!(rules[1].0, 'E');
    }
}
