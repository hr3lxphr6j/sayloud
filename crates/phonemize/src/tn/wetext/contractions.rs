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
use std::sync::LazyLock;

use aho_corasick::{AhoCorasick, Input, Match, MatchKind};

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

/// The embedded tables, parsed once each.
///
/// The JSON is `include_str!`'d, so a table that does not parse is a defect in
/// this build and not something a caller can cause or recover from. Each table is
/// parsed exactly once, so every reader of it sees the same map.
static CONTRACTIONS_TABLE: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| parse_table(CONTRACTIONS_JSON, "contractions_dict.json"));
static LEFTOVERS_TABLE: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| parse_table(LEFTOVERS_JSON, "leftovers_dict.json"));
static SLANG_TABLE: LazyLock<HashMap<String, String>> =
    LazyLock::new(|| parse_table(SLANG_JSON, "slang_dict.json"));

/// Parse one embedded table, naming it in the panic a malformed file produces.
///
/// A panic rather than an empty map: an empty table would silently disable every
/// contraction, and the data is compiled in, so nothing a caller does can make
/// this fail. Naming the file is what turns the panic into a one-line fix.
fn parse_table(json: &str, name: &str) -> HashMap<String, String> {
    serde_json::from_str(json)
        .unwrap_or_else(|error| panic!("the embedded {name} table is not valid JSON: {error}"))
}

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
    ///
    /// `found` is an occurrence of this rule's key, so its offsets are the only
    /// position information the check needs; the matched text is the slice of
    /// `haystack` they describe.
    fn accepts(&self, haystack: &str, found: &Match) -> bool {
        let matched = &haystack[found.start()..found.end()];
        if self.exact_case && matched.chars().any(|c| c.is_ascii_uppercase()) {
            return false;
        }

        let before = haystack[..found.start()].chars().next_back();
        if is_word(before) == self.first_is_word {
            return false;
        }

        if !self.trailing_boundary {
            return true;
        }
        let after = haystack[found.end()..].chars().next();
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

static TABLES: LazyLock<Tables> = LazyLock::new(Tables::new);

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
                if !rule.accepts(text, &found) {
                    continue;
                }
                let better = match &best {
                    Some(current) => {
                        found.start() < current.start()
                            || (found.start() == current.start() && found.end() > current.end())
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

/// The two apostrophes the contraction keys are spelled with: `'` (U+0027) and
/// `’` (U+2019).
///
/// One list rather than the same pair of comparisons in two modules: `tn::gate`
/// counts an apostrophe as a reason to run the normalizer for exactly the reason
/// this module expands it, so the two answers have to be the same set.
pub const APOSTROPHES: [char; 2] = ['\'', '\u{2019}'];

/// Whether `text` contains one of [`APOSTROPHES`].
///
/// `Normalizer::normalize_with_config` only calls [`fix_contractions`] when this
/// is true. Python's WeText checks only for `'`, so a sentence that uses only `’`
/// is never expanded there, even though the tables contain `’` keys.
pub fn has_apostrophe(text: &str) -> bool {
    text.chars().any(|ch| APOSTROPHES.contains(&ch))
}

/// Build the automaton now instead of on the first sentence that needs it.
///
/// Called from `crate::tn::engine::english` during `finish_loading`, alongside
/// the English FST parses (70 ms; this takes 0.7 ms).
pub fn warm_up() {
    LazyLock::force(&TABLES);
}

/// Every key and its expansion: the three JSON tables, the month keys, and a `’`
/// copy of every key that contains `'`. Keys are lower-cased, and leftover
/// entries with an empty expansion are dropped. Later tables overwrite earlier
/// ones on the same key.
///
/// The tests use this as well, to build the regex reference implementation.
fn merged_tables() -> HashMap<String, String> {
    let mut map = HashMap::new();

    // Standard contractions
    for (key, value) in CONTRACTIONS_TABLE.iter() {
        map.insert(key.to_lowercase(), value.clone());
    }

    // Leftovers, skipping empty mappings such as "'all" → ""
    for (key, value) in LEFTOVERS_TABLE.iter() {
        if !value.is_empty() {
            map.insert(key.to_lowercase(), value.clone());
        }
    }

    // Slang
    for (key, value) in SLANG_TABLE.iter() {
        map.insert(key.to_lowercase(), value.clone());
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
    SLANG_TABLE
        .keys()
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

/// The slang keys the fast path in [`fix_contractions`] looks for.
///
/// Only the apostrophe-less ones: an apostrophe is the other reason to expand, and
/// [`has_apostrophe`] has already answered that question by the time this list is
/// read. Not every apostrophe-less key is listed — see [`needs_expansion`].
const SLANG_KEYS: &[&str] = &["gonna", "wanna", "gotta", "dunno", "gimme", "lemme"];

/// The apostrophe-less keys the fast path in [`fix_contractions`] looks for:
/// common slang and the month keys.
///
/// The month half is derived from [`MONTH_ABBREVS`], so a month added to the
/// tables is one the fast path looks for without a second edit. Not every apostrophe-less key is
/// listed: `whats` and the like expand only when the text also contains an
/// apostrophe, which is the trade the fast path makes.
fn needs_expansion(text: &str) -> bool {
    SLANG_KEYS
        .iter()
        .copied()
        .chain(MONTH_ABBREVS.iter().map(|(abbrev, _)| *abbrev))
        .any(|key| contains_ignore_ascii_case(text, key))
}

/// Whether `haystack` contains `needle`, ignoring ASCII case, without allocating.
///
/// Every key is ASCII, so this matches what `to_lowercase().contains(key)` would,
/// and it runs on every English sentence the normalizer is offered, including the
/// ones it then declines to touch. `needle` must not be empty.
fn contains_ignore_ascii_case(haystack: &str, needle: &str) -> bool {
    let needle = needle.as_bytes();
    haystack
        .as_bytes()
        .windows(needle.len())
        .any(|window| window.eq_ignore_ascii_case(needle))
}

#[cfg(test)]
#[path = "contractions_tests.rs"]
mod tests;
