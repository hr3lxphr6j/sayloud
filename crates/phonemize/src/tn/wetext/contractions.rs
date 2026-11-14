//! English contraction expansion: `We'll` → `we will`.
//!
//! The English pipeline runs this before the WeText tagger, from
//! `Normalizer::normalize_with_config`, and only on sentences that contain an
//! apostrophe (see [`has_apostrophe`]). It is the equivalent of Python's
//! `contractions.fix()`.
//!
//! # Data
//!
//! Three JSON tables copied unchanged from the Python `contractions` package
//! 0.1.73, plus 11 month abbreviations. Every key that contains `'` also gets a
//! copy spelled with `’`. That makes 412 keys, all lower case, the longest
//! 16 bytes. The tables are MIT while the rest of this directory is Apache-2.0;
//! the licence and the file hashes are in `data/contractions-NOTICE.txt`.
//!
//! # Matching
//!
//! One [`AhoCorasick`] automaton finds every occurrence of every key. It only
//! matches literal strings, so two more checks run on each occurrence, in
//! [`Rule::accepts`]:
//!
//! - **Word boundaries.** A key must not start or end in the middle of a word,
//!   like the regex `\b…\b`. Month keys (`jan.`) have no trailing boundary.
//! - **Case.** Matching ignores ASCII case, except for seven text-speak keys
//!   (`bc`, `u`, …) that only match in lower case. See [`convention_keys`].
//!
//! Among the occurrences that pass, the scan takes the leftmost one, and of
//! those that start at the same place, the longest. See [`Tables::expand`].
//!
//! [`warm_up`] builds the automaton during `prepare`: 0.73 ms and 89 KB of heap.
//! The same rules as 412 separate regexes would cost 56 ms and 6.7 MB.
//!
//! # Differences from the Python package
//!
//! The test `differences_from_the_python_package` lists them with examples.
//! In short: text-speak keys are case-sensitive (`BC` stays `BC`), the
//! replacement is always the table's lower-case text, and keys that start or end
//! with an apostrophe treat word boundaries differently.

use std::collections::{HashMap, HashSet};

use aho_corasick::{AhoCorasick, Input, Match, MatchKind};
use once_cell::sync::Lazy;

/// The tables, embedded at compile time from the Python `contractions` package:
/// - `contractions_dict.json`: standard contractions (~180 entries)
/// - `leftovers_dict.json`: suffixes such as `'ll` and `'d` (~17 entries)
/// - `slang_dict.json`: slang and text-speak (~50 entries)
const CONTRACTIONS_JSON: &str = include_str!("data/contractions_dict.json");
const LEFTOVERS_JSON: &str = include_str!("data/leftovers_dict.json");
const SLANG_JSON: &str = include_str!("data/slang_dict.json");

/// Month abbreviations. The Python package adds these in code, not in a table.
const MONTH_ABBREVS: &[(&str, &str)] = &[
    ("jan.", "january"),
    ("feb.", "february"),
    ("mar.", "march"),
    ("apr.", "april"),
    ("jun.", "june"),
    ("jul.", "july"),
    ("aug.", "august"),
    ("sep.", "september"),
    ("oct.", "october"),
    ("nov.", "november"),
    ("dec.", "december"),
];

/// What the automaton cannot store about a key.
///
/// Indexed by the automaton's `PatternID`. [`Tables::new`] builds this vector and
/// the automaton from the same sorted list, so the indices line up.
#[derive(Debug)]
struct Rule {
    /// The replacement text, verbatim from the table. Always lower case.
    expansion: String,
    /// Whether the key must end on a word boundary.
    ///
    /// False only for the month keys. Their key includes the dot (`jan.`), so
    /// both `jan. 15` and `jan.15` expand.
    trailing_boundary: bool,
    /// Whether the key only matches in the case the table writes it in (lower
    /// case). True for the text-speak keys; see [`convention_keys`].
    exact_case: bool,
    /// Whether the key's first and last characters are word characters. The
    /// boundary test compares these with the characters around the match.
    first_is_word: bool,
    last_is_word: bool,
}

impl Rule {
    /// Whether this occurrence of the key counts.
    ///
    /// A word boundary sits between a word character and a non-word character,
    /// and the edges of the text count as non-word. So an occurrence is
    /// accepted when the character before it differs in word-ness from the key's
    /// first character, and (if `trailing_boundary`) the character after it
    /// differs from the key's last character.
    ///
    /// Example: `'ll` starts with a non-word character, so it needs a word
    /// character before it. `John'll` matches; `John 'll` does not.
    fn accepts(&self, haystack: &str, matched: &str, start: usize, end: usize) -> bool {
        if self.exact_case && matched.chars().any(|c| c.is_ascii_uppercase()) {
            return false;
        }

        let before = haystack[..start].chars().next_back();
        if is_word(before) == self.first_is_word {
            return false;
        }

        if !self.trailing_boundary {
            return true;
        }
        let after = haystack[end..].chars().next();
        is_word(after) != self.last_is_word
    }
}

/// Whether `character` is a word character for the boundary test. `None` is the
/// edge of the text, which counts as non-word.
///
/// This is [`char::is_alphanumeric`] plus `_`, an approximation of the regex
/// crate's `\w`. The two agree on all of ASCII. Outside ASCII, `\w` also covers
/// combining marks and join controls, and `is_alphanumeric` also covers number
/// forms such as `²`, `½` and `①`. Every key is ASCII apart from `’`, so this
/// only affects how the characters next to a key are classified. The test
/// `is_word_agrees_with_the_regex_word_class_over_these_code_points` pins the
/// differences.
fn is_word(character: Option<char>) -> bool {
    character.is_some_and(|c| c.is_alphanumeric() || c == '_')
}

/// The automaton and the per-key rules.
///
/// The automaton uses `MatchKind::Standard` because it is the only kind that
/// supports overlapping iteration, which [`Tables::expand`] needs in order to see
/// every candidate. The automaton does not choose the winner: when two keys match
/// at the same position, `Standard` reports the one that ends first (`o'` before
/// `o'clock`), but the rule wants the longest. `expand` picks the winner itself.
struct Tables {
    /// Reports every match, including shorter keys inside longer ones.
    automaton: AhoCorasick,
    /// Indexed by `PatternID`.
    rules: Vec<Rule>,
    /// The length of the longest key, in bytes. Lets [`Tables::expand`] stop
    /// scanning early.
    max_key_len: usize,
}

static TABLES: Lazy<Tables> = Lazy::new(Tables::new);

impl Tables {
    fn new() -> Self {
        let mut entries: Vec<(String, Rule)> = Vec::new();
        let conventions = convention_keys();

        for (key, expansion) in merged_tables() {
            let first = key.chars().next().expect("no key is empty");
            let last = key.chars().next_back().expect("no key is empty");
            let rule = Rule {
                expansion,
                // Month keys end in `.` and have no trailing boundary; every
                // other key needs one.
                trailing_boundary: !key.ends_with('.'),
                exact_case: conventions.contains(&key),
                first_is_word: is_word(Some(first)),
                last_is_word: is_word(Some(last)),
            };
            entries.push((key, rule));
        }

        // Sort so the build does not depend on `HashMap` iteration order. The
        // output of `expand` does not depend on pattern order; this only keeps
        // builds reproducible.
        entries.sort_by(|(left, _), (right, _)| left.cmp(right));

        let patterns: Vec<&str> = entries.iter().map(|(key, _)| key.as_str()).collect();
        let automaton = AhoCorasick::builder()
            .match_kind(MatchKind::Standard)
            .ascii_case_insensitive(true)
            .build(&patterns)
            .expect("the tables build an automaton");
        let max_key_len = patterns.iter().map(|key| key.len()).max().unwrap_or(0);
        let rules = entries.into_iter().map(|(_, rule)| rule).collect();

        Tables {
            automaton,
            rules,
            max_key_len,
        }
    }

    /// Replace every accepted key occurrence in `text` with its expansion.
    ///
    /// # Rule
    ///
    /// Starting from the current position: among all accepted matches, take the
    /// one that starts leftmost, and of those that start there, the longest.
    /// Replace it and continue after it. The Python reference's `TextSearch`
    /// does the same.
    ///
    /// # Why every match is enumerated
    ///
    /// Asking the automaton for one match and then filtering it does not work,
    /// because the automaton's choice ignores boundaries and case:
    ///
    /// - `LeftmostLongest`, skipping past a rejected match. In `awe'll`, `we'll`
    ///   is rejected (it starts mid-word) and the skip jumps over `'ll`, which
    ///   should have matched.
    /// - The same, but restarting one character into a rejected match. In
    ///   `o'clocks`, `o'clock` is rejected (it ends mid-word) and the restart
    ///   misses `o'`, which starts at the same place. The right answer is
    ///   `ofclocks`.
    /// - `Standard`, one match at a time. At a given position it reports the
    ///   shorter key first, so `o'er` becomes `ofer` instead of `over`.
    ///
    /// So the loop walks all overlapping matches with `find_overlapping_iter` and
    /// keeps the best accepted one.
    ///
    /// # Stopping early
    ///
    /// Walking to the end of the text for every replacement is slow (174 µs
    /// instead of 16 µs on an 860-character paragraph). The loop stops as soon as
    /// no later match can beat the current best.
    ///
    /// The iterator reports matches in order of their end offset, and no key is
    /// longer than `max_key_len` bytes. So once a match ends more than
    /// `max_key_len` bytes after `best` starts, every later match starts after
    /// `best`:
    ///
    /// ```text
    /// later.start >= later.end - max_key_len   (no key is longer than max_key_len)
    ///             >= found.end - max_key_len   (later matches end no earlier)
    ///             >  best.start                (the stop condition)
    /// ```
    ///
    /// A match that starts after `best` is neither further left nor a longer
    /// match at the same start, so it cannot win. The check runs before the
    /// boundary and case filter, so a rejected match can end the loop too.
    ///
    /// Example, `I'd've said so, and we'll see.`: the first round sees `i'd`
    /// (best so far), shorter keys inside it, then `i'd've` (same start, longer,
    /// so the new best). The next match is `we'll`, which ends more than 16 bytes
    /// after position 0, so the round stops without reading the rest. The second
    /// round takes `we'll`.
    fn expand(&self, text: &str) -> String {
        let mut out = String::with_capacity(text.len());
        // Everything before `copied` is already in `out`.
        let mut copied = 0;
        let mut from = 0;

        while from < text.len() {
            let mut best: Option<Match> = None;

            for found in self
                .automaton
                .find_overlapping_iter(Input::new(text).span(from..text.len()))
            {
                // No later match can start at or before `best`; see "Stopping
                // early" above.
                if let Some(current) = &best {
                    if found.end() > current.start() + self.max_key_len {
                        break;
                    }
                }

                let rule = &self.rules[found.pattern().as_usize()];
                if !rule.accepts(
                    text,
                    &text[found.start()..found.end()],
                    found.start(),
                    found.end(),
                ) {
                    continue;
                }
                let better = match &best {
                    // Smaller start wins; at the same start, larger end wins.
                    // `usize::MAX - end` turns "larger end" into "smaller value".
                    Some(current) => {
                        (found.start(), usize::MAX - found.end())
                            < (current.start(), usize::MAX - current.end())
                    }
                    None => true,
                };
                if better {
                    best = Some(found);
                }
            }

            let Some(take) = best else { break };
            out.push_str(&text[copied..take.start()]);
            out.push_str(&self.rules[take.pattern().as_usize()].expansion);
            copied = take.end();
            from = take.end();
        }

        out.push_str(&text[copied..]);
        out
    }
}

/// Whether `text` contains `'` (U+0027) or `’` (U+2019), the two apostrophes the
/// keys are spelled with.
///
/// `Normalizer::normalize_with_config` only calls [`fix_contractions`] when this
/// is true. Python's WeText checks only for `'`, so a sentence that uses only `’`
/// is never expanded there, even though the tables contain `’` keys.
pub fn has_apostrophe(text: &str) -> bool {
    text.contains('\'') || text.contains('\u{2019}')
}

/// Build the automaton now instead of on the first sentence that needs it.
///
/// Called from `crate::tn::engine::english` during `finish_loading`, alongside
/// the English FST parses (70 ms; this takes 0.7 ms).
pub fn warm_up() {
    Lazy::force(&TABLES);
}

/// Every key and its expansion: the three JSON tables, the month keys, and a `’`
/// copy of every key that contains `'`. Keys are lower-cased, and leftover
/// entries with an empty expansion are dropped. Later tables overwrite earlier
/// ones on the same key.
///
/// The tests use this as well, to build the regex reference implementation.
fn merged_tables() -> HashMap<String, String> {
    let mut map = HashMap::new();

    let parse_json = |json: &str| -> HashMap<String, String> {
        serde_json::from_str::<HashMap<String, String>>(json).unwrap_or_default()
    };

    // Standard contractions
    for (k, v) in parse_json(CONTRACTIONS_JSON) {
        map.insert(k.to_lowercase(), v);
    }

    // Leftovers, skipping empty mappings such as "'all" → ""
    for (k, v) in parse_json(LEFTOVERS_JSON) {
        if !v.is_empty() {
            map.insert(k.to_lowercase(), v);
        }
    }

    // Slang
    for (k, v) in parse_json(SLANG_JSON) {
        map.insert(k.to_lowercase(), v);
    }

    // Month abbreviations
    for (abbrev, full) in MONTH_ABBREVS {
        map.insert(abbrev.to_string(), full.to_string());
    }

    // A `’` (U+2019) copy of every key containing `'` (U+0027), as the Python
    // package does.
    let variants: Vec<(String, String)> = map
        .iter()
        .filter(|(k, _)| k.contains('\''))
        .map(|(k, v)| (k.replace('\'', "\u{2019}"), v.clone()))
        .collect();

    for (k, v) in variants {
        map.entry(k).or_insert(v);
    }

    map
}

/// The text-speak keys from the slang table, which only match in lower case:
/// `b4`, `bc`, `kk`, `r `, `rn`, `u`, `ur`.
///
/// Each of them is also a capitalised word or initialism in ordinary prose, so
/// case-insensitive matching breaks real text. Through the full pipeline:
///
/// | text | matched case-insensitively | correct |
/// |------|----------------------------|---------|
/// | `It's 500 BC` | `it is five hundred because` | `five hundred B C` |
/// | `It's the U.S. Army` | `it is the you.S. Army` | `the U S Army` |
///
/// Text-speak is written in lower case and the colliding words are not (`BC`,
/// `U.S.`, `Ur` the city, `RN` registered nurse, `B4` the paper size), so
/// case-sensitive matching keeps both: `It's 4 u` still becomes `it is 4 you`.
///
/// The Python package matches these case-insensitively and turns `It's 500 BC`
/// into `It is 500 BECAUSE`. This is a deliberate difference.
fn convention_keys() -> HashSet<String> {
    serde_json::from_str::<HashMap<String, String>>(SLANG_JSON)
        .unwrap_or_default()
        .into_keys()
        .map(|key| key.to_lowercase())
        .filter(|key| is_a_convention_rather_than_a_word(key))
        .collect()
}

/// Whether a slang key is text-speak: at most two characters, or containing a
/// digit. A rule rather than a fixed list, so new entries such as `gr8` or
/// `2day` are handled the same way.
fn is_a_convention_rather_than_a_word(key: &str) -> bool {
    key.chars().count() <= 2 || key.chars().any(|c| c.is_ascii_digit())
}

/// Expand English contractions in `text`.
///
/// The equivalent of Python's `contractions.fix(text)`, with the differences
/// listed in the module documentation. A matched key is replaced by the table's
/// lower-case text, so `It's` becomes `it is`.
///
/// # Example
/// ```rust,ignore
/// use phonemize::tn::wetext::contractions::fix_contractions;
///
/// assert_eq!(fix_contractions("I don't know"), "I do not know");
/// assert_eq!(fix_contractions("It's gonna be fine"), "it is going to be fine");
/// assert_eq!(fix_contractions("Jan. 15th"), "january 15th");
/// ```
pub fn fix_contractions(text: &str) -> String {
    // Fast path: skip the scan and the allocation unless the text has an
    // apostrophe or one of the apostrophe-less keys in `needs_expansion`. An
    // apostrophe-less key that is not on that list (such as `whats`) therefore
    // only expands when the text also contains an apostrophe.
    if !has_apostrophe(text) && !needs_expansion(text) {
        return text.to_string();
    }

    TABLES.expand(text)
}

/// The apostrophe-less keys the fast path in [`fix_contractions`] looks for:
/// common slang and the month keys. Not every apostrophe-less key is listed.
fn needs_expansion(text: &str) -> bool {
    let lower = text.to_lowercase();
    // Slang without an apostrophe
    lower.contains("gonna")
        || lower.contains("wanna")
        || lower.contains("gotta")
        || lower.contains("dunno")
        || lower.contains("gimme")
        || lower.contains("lemme")
        // Month abbreviations
        || lower.contains("jan.")
        || lower.contains("feb.")
        || lower.contains("mar.")
        || lower.contains("apr.")
        || lower.contains("jun.")
        || lower.contains("jul.")
        || lower.contains("aug.")
        || lower.contains("sep.")
        || lower.contains("oct.")
        || lower.contains("nov.")
        || lower.contains("dec.")
}

/// Unused. `_include_slang` is ignored: slang is always expanded.
#[allow(dead_code)]
pub fn fix_contractions_with_options(text: &str, _include_slang: bool) -> String {
    fix_contractions(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A second implementation of the same rules, used only as a test reference.
    ///
    /// One regex per key: `(?i)\b…\b`, without `(?i)` for text-speak keys and
    /// without the trailing `\b` for month keys. The regexes are applied in a
    /// loop, longest key first. It is deliberately simple and shares no matching
    /// code with the automaton, so that comparing the two means something. Keep
    /// it that way.
    fn reference(text: &str) -> String {
        use std::sync::OnceLock;

        /// Compiled once. Compiling 412 regexes per call makes the test take
        /// minutes.
        static PATTERNS: OnceLock<Vec<(regex::Regex, String)>> = OnceLock::new();

        if !has_apostrophe(text) && !needs_expansion(text) {
            return text.to_string();
        }

        let patterns = PATTERNS.get_or_init(|| {
            let conventions = convention_keys();
            let mut patterns: Vec<(String, regex::Regex, String)> = merged_tables()
                .into_iter()
                .filter_map(|(key, expansion)| {
                    let escaped = regex::escape(&key);
                    let insensitivity = if conventions.contains(&key) {
                        ""
                    } else {
                        "(?i)"
                    };
                    let pattern = if key.ends_with('.') {
                        format!(r"{insensitivity}\b{escaped}")
                    } else {
                        format!(r"{insensitivity}\b{escaped}\b")
                    };
                    regex::Regex::new(&pattern)
                        .ok()
                        .map(|re| (key, re, expansion))
                })
                .collect();
            patterns.sort_by(|(left, ..), (right, ..)| {
                right.len().cmp(&left.len()).then_with(|| left.cmp(right))
            });
            patterns
                .into_iter()
                .map(|(_, re, expansion)| (re, expansion))
                .collect()
        });

        let mut result = text.to_string();
        for (pattern, expansion) in patterns {
            result = pattern.replace_all(&result, expansion.as_str()).to_string();
        }
        result
    }

    /// The automaton and [`reference`] give the same output on about 4,500
    /// inputs.
    ///
    /// The inputs are every key in 11 surroundings (spaces, text edges, letters,
    /// digits, quotes, dots, hyphens, newlines), plus prose and overlapping keys
    /// (`he'll've`, `I'd've`, `y'all'll`).
    ///
    /// The inputs are ASCII. The one known disagreement is outside ASCII: the
    /// regex `(?i)` folds the long s `ſ` to `s` and the automaton does not. That
    /// case is in `differences_from_the_python_package`.
    #[test]
    fn the_engine_swap_changes_nothing_over_these_inputs() {
        let mut carriers = Vec::new();
        for key in merged_tables().keys() {
            for (before, after) in [
                ("", ""),
                (" ", " "),
                ("a", "b"),
                ("'", "'"),
                ("a", ""),
                ("", "s"),
                (".", ""),
                ("", "."),
                ("-", "-"),
                ("5", "5"),
                ("\n", " "),
            ] {
                carriers.push(format!("{before}{key}{after}"));
            }
        }
        for prose in [
            "It's the best of times, and we'll see whether they don't mind that she's already gone.",
            "John'll come, won't he? I'd've said so, and he'd not have minded.",
            "Y'all'll wanna see this, 'cause it don't get better than that.",
            "Jan. 15th, 2 p.m., 500 BC, the U.S. Army, and 4 u.",
            "'twas brillig, and the slithy toves did gyre and gimble in the wabe",
            "Whatcha gonna do when nothin' works, and somethin' breaks?",
            // Several matches in one text, each with a lot of text after it, so
            // the early stop in `expand` is exercised.
            "It's the best of times, and we'll see whether they don't mind that she's already gone, \
             because I'd've said so too, and he'd not have minded; o'clock came and went, and the \
             U.S. Army moved on. 'Cause nothin' works the way it should, don't you know.",
        ] {
            carriers.push(prose.to_string());
        }
        for overlap in [
            "he'll've",
            "I'd've",
            "couldn't've",
            "y'all'll",
            "We'll We'll We'll",
            "''",
            "'''",
            "'ll",
            "a'll",
            "o'",
            "o'clock",
            "ma'am",
        ] {
            carriers.push(overlap.to_string());
        }

        let mut differences = Vec::new();
        for text in &carriers {
            let (engine, reference) = (fix_contractions(text), reference(text));
            if engine != reference {
                differences.push(format!(
                    "{text:?}\n  automaton {engine:?}\n  regex     {reference:?}"
                ));
            }
        }
        assert!(
            differences.is_empty(),
            "{} of {} inputs differ:\n{}",
            differences.len(),
            carriers.len(),
            differences.join("\n")
        );
        // If the corpus stopped covering the tables, the assertion above would
        // pass without proving anything.
        assert!(carriers.len() > 4000, "only {} inputs", carriers.len());
    }

    /// How [`is_word`] differs from the regex crate's `\w`, over U+0000–U+2FFF.
    ///
    /// - `\w` also includes combining marks and join controls: 432 characters,
    ///   starting at U+0300. The count is pinned, because both sides of it are
    ///   fixed by the lockfile: the `regex` crate's own tables.
    /// - `is_word` also includes the `No` and `Nl` number categories (`²`, `½`,
    ///   `①`, `Ⅷ`), and — because it asks the *toolchain's* tables rather than
    ///   the crate's — every character Rust knows and `regex 1.13.1` does not.
    ///   That second half is **not** pinned to an exact count: it moves with
    ///   the Rust version. 235 at Unicode 16 (rustc 1.99.1), 244 at Unicode 17
    ///   (rustc 1.100.0), which assigned nine more letters below U+2FFF
    ///   (U+0558, U+058B, U+058C, U+05C8, U+05C9, U+208F, U+209D–U+209F).
    ///
    /// None of them is ASCII, which is what matters, because the keys are
    /// (apart from `’`). Six of them are in Latin-1 (`²³¹¼½¾`), so those are
    /// listed by name. What *is* pinned is the shape of the difference: a
    /// character may only be accepted here if it is a letter or a number, so
    /// `is_word` cannot quietly grow to accept punctuation. If a toolchain bump
    /// raises the floor, update the number above with it — that is the signal
    /// this test is here to give, not a failure to work around.
    #[test]
    fn is_word_agrees_with_the_regex_word_class_over_these_code_points() {
        let theirs = regex::Regex::new(r"^\w$").expect("the pattern compiles");
        let (mut only_theirs, mut ascii_differing, mut latin1) = (0, 0, Vec::new());
        let mut only_mine: Vec<char> = Vec::new();

        for code in 0u32..=0x2FFF {
            let Some(character) = char::from_u32(code) else {
                continue;
            };
            let mine = is_word(Some(character));
            let their = theirs.is_match(&character.to_string());
            if mine == their {
                continue;
            }
            if code < 0x80 {
                ascii_differing += 1;
            } else if code <= 0xFF {
                latin1.push(character);
            }
            if mine {
                only_mine.push(character);
            } else {
                only_theirs += 1;
            }
        }

        assert_eq!(ascii_differing, 0, "the two disagree on an ASCII character");
        assert_eq!(
            latin1,
            ['²', '³', '¹', '¼', '½', '¾'],
            "the Latin-1 exceptions"
        );
        assert!(
            only_mine.len() >= 235,
            "only {} characters, fewer than Unicode 16's 235",
            only_mine.len()
        );
        assert_eq!(
            only_mine
                .iter()
                .filter(|character| !character.is_alphanumeric())
                .collect::<Vec<_>>(),
            Vec::<&char>::new(),
            "`is_word` accepts punctuation as well as letters and numbers"
        );
        assert_eq!(
            only_theirs, 432,
            "marks and join controls, which \\w includes"
        );

        // One example per category, so that swapping one category for another
        // cannot pass by keeping the totals.
        for (character, mine) in [
            ('½', true),         // No: a word character here, not to `\w`
            ('①', true),         // No
            ('Ⅷ', true),         // Nl
            ('é', true),         // a letter to both
            ('_', true),         // connector punctuation both include
            ('\u{0301}', false), // Mn: a word character to `\w`, not here
            ('\u{200d}', false), // Cf (join control): the same
            ('\u{203f}', false), // Pc other than `_`: `\w` includes it, this does not
        ] {
            assert_eq!(
                is_word(Some(character)),
                mine,
                "{character:?} ({:#06x})",
                character as u32
            );
        }
    }

    /// The early stop in [`Tables::expand`] keeps the longest match at a
    /// position, and still finds a match inside a rejected one.
    ///
    /// A stop that came too early would not fail loudly: it would quietly take
    /// the shorter of two keys at the same position, or miss a key inside a
    /// rejected match. These are the cases that would catch it. (The longest key
    /// is 16 bytes.)
    #[test]
    fn the_early_exit_keeps_the_longest_match_at_a_position() {
        // Two accepted keys at the same position: `o'` → `of` and
        // `o'clock` → `of the clock`. The longer must win; stopping as soon as
        // something ends past the best's start would give `ofclock`.
        assert_eq!(fix_contractions("o'clock"), "of the clock");
        assert_eq!(fix_contractions("o'clock today"), "of the clock today");

        // The same with longer keys: `I'd` and `I'd've` at one position.
        assert_eq!(fix_contractions("I'd've"), "I would have");
        assert_eq!(fix_contractions("he'll've"), "he will have");

        // A key inside a rejected match. `o'clock` is rejected inside `o'clocks`
        // (it ends mid-word), so `o'` applies. `you’d` is rejected inside
        // `ayou’d` (it starts mid-word), so `’d` applies.
        assert_eq!(fix_contractions("o'clocks"), "ofclocks");
        assert_eq!(fix_contractions("ayou’d"), "ayou would");

        // Several matches in one text, so the stop has to be right more than
        // once, with text after each match.
        assert_eq!(
            fix_contractions("It's John's, and it's not what's-his-name's."),
            "it is John's, and it is not what is-his-name's."
        );
        let paragraph = "It's the best of times, and we'll see whether they don't mind \
             that she's already gone. I'd've said so, and he'd not have minded, 'cause \
             nothin' works the way it should.";
        assert_eq!(
            fix_contractions(paragraph),
            // `'cause` and `nothin'` stay unchanged on purpose. A key that starts
            // with an apostrophe needs a word character before it, and a key that
            // ends with one needs a word character after it. The comma before
            // `'cause` and the space after `nothin'` are not word characters. See
            // the `doin' it` case in `differences_from_the_python_package`.
            "it is the best of times, and we will see whether they do not mind that she \
             is already gone. I would have said so, and he would not have minded, 'cause \
             nothin' works the way it should."
        );
    }

    #[test]
    fn test_basic_contractions() {
        assert_eq!(fix_contractions("I don't know"), "I do not know");
        // The replacement is the table's lower-case text.
        assert_eq!(fix_contractions("It's fine"), "it is fine");
        assert_eq!(fix_contractions("we're here"), "we are here");
    }

    #[test]
    fn test_slang() {
        // The table writes "I'm" → "I am" with a capital I.
        assert_eq!(fix_contractions("I'm gonna go"), "I am going to go");
        assert_eq!(fix_contractions("I wanna eat"), "I want to eat");
        assert_eq!(fix_contractions("I gotta leave"), "I got to leave");
    }

    #[test]
    fn test_month_abbreviations() {
        assert_eq!(fix_contractions("jan. 15"), "january 15");
        assert_eq!(fix_contractions("dec. 25"), "december 25");
    }

    #[test]
    fn test_curly_apostrophe() {
        assert_eq!(fix_contractions("don't"), "do not");
        assert_eq!(fix_contractions("don’t"), "do not");
    }

    /// `We'll` becomes `we will` (main table), not `We` + `'ll` → ` will`
    /// (leftovers table). `we'll` starts further left than `'ll`, so it wins.
    ///
    /// Both readings sound the same; this pins the text so it cannot vary.
    /// `John'll` has no specific key, so the general `'ll` applies.
    #[test]
    fn a_specific_contraction_wins_over_the_leftover_that_overlaps_it() {
        assert_eq!(fix_contractions("We'll go"), "we will go");
        assert_eq!(fix_contractions("We’ll go"), "we will go");
        assert_eq!(fix_contractions("I'll go"), "I will go");
        assert_eq!(fix_contractions("John'll go"), "John will go");
    }

    /// Where this module differs from `contractions.fix` in the Python package,
    /// version 0.1.73 (the version the tables come from). Measured against it:
    ///
    /// | input | here | Python |
    /// |-------|------|--------|
    /// | `doin' it` | `doin' it` | `doing it` |
    /// | `doin'it` | `doingit` | `doin'it` |
    /// | `jan.15` | `january15` | `jan.15` |
    /// | `whats up` | `whats up` | `what is up` |
    /// | `ſhe's here` | `ſhe's here` | `ſhe is here` |
    /// | `We'll go` | `we will go` | `We will go` |
    /// | `It's 500 BC` | `it is 500 BC` | `It is 500 BECAUSE` |
    #[test]
    fn differences_from_the_python_package() {
        // 1. A key that ends in an apostrophe (`doin'`) needs a word character
        //    after it, because a boundary after a non-word character needs one.
        //    So `doin' it` is unchanged and `doin'it` expands: the reverse of
        //    Python, which matches the whole word `doin'`.
        assert_eq!(fix_contractions("doin' it"), "doin' it");
        assert_eq!(fix_contractions("doin'it"), "doingit");

        // 2. Month keys include the dot and have no trailing boundary, so
        //    `jan.15` expands here and not in Python.
        assert_eq!(fix_contractions("jan. 15"), "january 15");
        assert_eq!(fix_contractions("jan.15"), "january15");

        // 3. `whats` has no apostrophe and is not in `needs_expansion`, so it
        //    only expands when the text also contains an apostrophe.
        assert_eq!(fix_contractions("whats up"), "whats up");
        assert_eq!(fix_contractions("It's whats"), "it is what is");

        // 4. Case folding is ASCII only, so `ſ` (long s) is not read as `s` and
        //    nothing matches. The regex reference, whose `(?i)` is Unicode, would
        //    read `she's`; that is why this case is not in the equivalence test.
        assert_eq!(fix_contractions("ſhe's here"), "ſhe's here");

        // 5. The replacement is the table's lower-case text; Python keeps the
        //    case of the matched text. It sounds the same, but it changes the
        //    text the tagger sees.
        assert_eq!(fix_contractions("We'll go"), "we will go");

        // 6. Text-speak keys only match in lower case, so `BC` is not `because`.
        //    See `convention_keys`.
        assert_eq!(fix_contractions("It's 500 BC"), "it is 500 BC");
    }

    /// Text-speak keys only match in lower case, so ordinary prose survives and
    /// text-speak still expands.
    ///
    /// Every input starts with `It's` because in the pipeline this step only runs
    /// on sentences with an apostrophe. Turning `500` into `five hundred` is the
    /// tagger's job; the pipeline-level versions of these cases are in
    /// `tests/wetext_en.rs`.
    #[test]
    fn a_convention_is_matched_exactly_so_prose_survives() {
        // Initialisms and capitalised words that collide with text-speak keys.
        assert_eq!(fix_contractions("It's 500 BC"), "it is 500 BC");
        assert_eq!(
            fix_contractions("It's the U.S. Army"),
            "it is the U.S. Army"
        );
        assert_eq!(fix_contractions("It's the RN"), "it is the RN");
        assert_eq!(fix_contractions("It's ancient Ur"), "it is ancient Ur");
        // Text-speak itself still expands.
        assert_eq!(fix_contractions("It's 4 u"), "it is 4 you");
        assert_eq!(fix_contractions("It's b4 noon"), "it is before noon");
        assert_eq!(fix_contractions("It's kk"), "it is okay");
        assert_eq!(fix_contractions("It's rn"), "it is right now");
        // The rule selects exactly these keys from the shipped table.
        let mut picked: Vec<String> = convention_keys().into_iter().collect();
        picked.sort_unstable();
        assert_eq!(picked, ["b4", "bc", "kk", "r ", "rn", "u", "ur"]);
        assert!(!is_a_convention_rather_than_a_word("y'all"));
        assert!(!is_a_convention_rather_than_a_word("gonna"));
    }

    /// [`has_apostrophe`] must recognise every apostrophe the keys use.
    ///
    /// If a key used an apostrophe the guard did not know, the caller would skip
    /// expansion for sentences containing it, silently. This checks every key
    /// against a list of apostrophe-like characters.
    #[test]
    fn has_apostrophe_knows_the_apostrophes_the_tables_are_keyed_with() {
        assert!(has_apostrophe("don't"));
        assert!(has_apostrophe("don’t"));
        assert!(!has_apostrophe("dont"));
        assert!(!has_apostrophe("plain text"));

        let candidates = [
            '\'', '\u{2019}', '\u{02bc}', '\u{2018}', '\u{201b}', '\u{ff07}',
        ];
        let mut used = false;
        for key in merged_tables().keys() {
            for ch in key.chars() {
                if candidates.contains(&ch) {
                    used = true;
                    assert!(
                        has_apostrophe(&ch.to_string()),
                        "a contraction key contains {ch:?}, which the guard does not know"
                    );
                }
            }
        }
        assert!(
            used,
            "no key uses an apostrophe at all: this test proves nothing"
        );
    }

    #[test]
    fn test_no_contractions() {
        assert_eq!(fix_contractions("Hello world"), "Hello world");
        assert_eq!(
            fix_contractions("No contractions here"),
            "No contractions here"
        );
    }

    #[test]
    fn test_case_insensitive() {
        // Matching ignores case; the replacement is the table's lower-case text.
        assert_eq!(fix_contractions("DON'T SHOUT"), "do not SHOUT");
        assert_eq!(fix_contractions("It's OK"), "it is OK");
    }
}
