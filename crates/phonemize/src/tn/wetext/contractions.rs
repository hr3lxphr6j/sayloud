//! English contractions expansion
//!
//! This module provides English contractions expansion functionality,
//! equivalent to Python's `contractions` package.
//!
//! The contraction rules are embedded at compile time from JSON files
//! copied from the Python `contractions` package. Those files are MIT and the rest
//! of this directory is Apache-2.0, so the licence, the version they were copied
//! from and the hashes that make "copied unchanged" checkable live in
//! `data/contractions-NOTICE.txt` beside them.
//!
//! # The engine: one automaton over the keys, not one regex per key
//!
//! Upstream's Python delegates this step to the `contractions` package, which
//! matches the keys with `textsearch` — a literal multi-string engine that takes
//! the longest key at each position. This module used to emulate that with one
//! `(?i)\b…\b` [`Regex`](regex::Regex) per key, applied in a loop; it now matches
//! with one [`AhoCorasick`] automaton over the same keys, which is the same object
//! `TextSearch` builds (and the same one an FST compiled from these literals would
//! have, minus the weight arithmetic and the OpenFST file format).
//!
//! The swap was made for the *build*, not for the scan. Measured in a release
//! build over the shipped 412 keys:
//!
//! | | 412 `Regex`, built lazily | one automaton, built in `prepare` |
//! |---|---|---|
//! | build | 56 ms, on the first call | 0.73 ms |
//! | resident heap | 6.7 MB | 89 KB |
//! | `fix_contractions`, an 86-character sentence | 30 µs | 2.2 µs |
//! | `fix_contractions`, an 860-character paragraph | 80 µs | 14 µs |
//! | wasm | — | +3.7 KB, and the crate was already linked through `regex` |
//!
//! The per-sentence scan was never the problem — synthesis is 500–750 ms a sentence,
//! so 30 µs is nothing and 2.2 µs is less of nothing. The build was: it is lazy, and
//! the first call is the first sentence containing an apostrophe, which is usually the
//! first sentence of an article. 6.7 MB of compiled patterns in a worker already
//! carrying ~30 MB of dictionaries was the other half.
//!
//! [`warm_up`] is what moves the build to `prepare`, where [`crate::tn::engine`]
//! calls it beside the FST parses it already pays for.
//!
//! **One automaton, not two — and the second one existed until the early exit in
//! [`Tables::expand`] made it unnecessary.** That is where the shape of the scan, the
//! three wrong ways to write it, and the measurement behind each of them live; this
//! comment and that one are deliberately the same argument, because the numbers are
//! what chose the shape.
//!
//! # What the automaton cannot know, and this module therefore says
//!
//! A multi-string automaton matches literals; it has no notion of the word
//! boundaries or the case rules that the patterns used to carry. Those are three
//! fields on [`Rule`], and they are the whole of what makes this a reimplementation
//! rather than a swap:
//!
//! - `trailing_boundary` — whether the key has to end on a word boundary. Only the
//!   month abbreviations do not, which is upstream's own definition of those keys
//!   (`jan.` is expected to be followed by a space).
//! - `exact_case` — the seven text-speak keys, which are matched exactly. See the
//!   note on the table below.
//! - the first and last character of the key, for the boundary test itself.
//!
//! Which key wins where two overlap is **not** the automaton's answer either, even
//! though it is the obvious place to look for it: see [`Tables`] for the measurement
//! that rules out letting it decide.

use std::collections::{HashMap, HashSet};

use aho_corasick::{AhoCorasick, Input, Match, MatchKind};
use once_cell::sync::Lazy;

/// Contractions data embedded at compile time
///
/// These JSON files are copied from Python `contractions` package:
/// - contractions_dict.json: Standard contractions (~180 rules)
/// - leftovers_dict.json: Leftover suffixes (~17 rules)
/// - slang_dict.json: Slang contractions (~50 rules)
// The paths are module-relative rather than the crate-relative ones upstream
// uses: this file sits inside `tn/wetext/`, so its data directory is a
// sibling rather than a crate-root `../data`.
const CONTRACTIONS_JSON: &str = include_str!("data/contractions_dict.json");
const LEFTOVERS_JSON: &str = include_str!("data/leftovers_dict.json");
const SLANG_JSON: &str = include_str!("data/slang_dict.json");

/// Month abbreviations (added dynamically like Python version)
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

/// One key: what it expands to, and the two things the automaton cannot hold.
///
/// Indexed by the automaton's `PatternID`, so the order of this vector is the order
/// the automaton's patterns were added in — [`Tables::new`] builds both.
#[derive(Debug)]
struct Rule {
    /// The words the key becomes, verbatim from the table. Lower case, which is
    /// where a `(?i)` match's replacement has always come from.
    expansion: String,
    /// Whether the key has to end on a word boundary.
    ///
    /// False only for [`MONTH_ABBREVS`], because upstream's key for January is
    /// `jan.` *including* the dot and it expects the space that follows: the
    /// pattern is `\bjan\.` with no trailing boundary, so `jan. 15` expands and
    /// `jan.15` does too (the two are separate divergences from the reference —
    /// see `the_regex_rules_differ_from_the_reference_in_these_places`).
    trailing_boundary: bool,
    /// Whether the key is a writing convention rather than a word, and therefore
    /// has to be matched in exactly the case the table writes it in.
    exact_case: bool,
    /// Whether the key's first and last characters are word characters, which is
    /// what the boundary test compares its neighbours against. See [`is_word`].
    first_is_word: bool,
    last_is_word: bool,
}

impl Rule {
    /// Whether a match of this key, at this place in this text, is one of the
    /// key's occurrences.
    ///
    /// This is the `\b…\b` the patterns used to carry, written out. A `\b` is a
    /// change of word-character-ness, so the leading test is "the character before
    /// the match is a word character exactly when the key's first character is
    /// not", and the trailing test is the mirror of it. Both ends of the text count
    /// as non-word characters, which is what makes `\b` fire at a string's edge.
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

/// Whether `character` is a word character, the way `\b` counts them.
///
/// `None` is the edge of the string, which `\b` treats as a non-word character.
///
/// # An approximation of the `regex` crate's `\w`
///
/// The patterns this replaced asked a Unicode-aware `\b`, whose word class is
/// `\p{Word}` — alphabetics, marks, decimal digits, connector punctuation and join
/// controls. This asks [`char::is_alphanumeric`] plus `_`, which agrees with
/// `\p{Word}` on every ASCII character and differs for the categories `\p{Word}`
/// has and `is_alphanumeric` does not (combining marks, join controls) and the
/// reverse (`No` and `Nl`: `①`, `Ⅷ`, and the six that sit inside Latin-1, `²³¹¼½¾`).
/// Measured rather than asserted:
/// `is_word_agrees_with_the_regex_word_class_over_these_code_points` compares the
/// two over the first three Unicode blocks and pins both the exceptions and the
/// counts.
///
/// It matters only for a *neighbour* of a match: every key in the tables is ASCII,
/// so this is asked about the character before and after an occurrence of one of
/// them.
fn is_word(character: Option<char>) -> bool {
    character.is_some_and(|c| c.is_alphanumeric() || c == '_')
}

/// The tables and the automaton over them.
///
/// **One automaton, and it has to be a `Standard` one.** `Standard` is the only
/// match kind that reports *every* match — `LeftmostFirst` and `LeftmostLongest`
/// refuse the overlapping iteration [`Tables::expand`] needs — and it is the only
/// one whose report the scan can filter. It is deliberately *not* the thing that
/// decides which key wins: measured, `Standard` resolves two keys that match at the
/// same position by taking the one that ends **first**, so a search of it on
/// `o'clocks` answers `o'` where the tables want `o'clock`. The scan does that part
/// itself.
struct Tables {
    /// Every match, including the shorter ones inside a longer one.
    automaton: AhoCorasick,
    /// Indexed by `PatternID`.
    rules: Vec<Rule>,
    /// The longest key, in bytes. It is what lets [`Tables::expand`] stop
    /// enumerating: nothing longer than this can be hiding.
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
                // Upstream's month keys carry their dot and no trailing boundary;
                // every other key is `\b`-delimited on both sides.
                trailing_boundary: !key.ends_with('.'),
                exact_case: conventions.contains(&key),
                first_is_word: is_word(Some(first)),
                last_is_word: is_word(Some(last)),
            };
            entries.push((key, rule));
        }

        // Deterministic order, so the automaton and `rules` are a function of the
        // tables rather than of `HashMap`'s iteration order. Not load-bearing — the
        // scan decides which key wins, not the pattern order — but a build that is
        // reproducible is one that can be compared when it changes.
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

    /// One scan: every key in `text` becomes its expansion.
    ///
    /// # The rule
    ///
    /// The match to take is the **leftmost, then longest, among the matches the
    /// tables accept** — upstream's `TextSearch`, and what the loop of sorted patterns
    /// this replaced was emulating. The automaton gives "leftmost" and it gives
    /// "longest" separately, but it knows nothing about boundaries or case — those are
    /// [`Rule::accepts`] — and asking it for one match per step and filtering does not
    /// work, in four different ways.
    ///
    /// # Four ways to get it wrong, measured
    ///
    /// Each shape below was run over a 2481-input corpus (every key in six carriers,
    /// plus prose and the adversarial overlaps) against [`tests::reference`], the regex
    /// implementation this module replaced — the corpus and the reference of
    /// `the_engine_swap_changes_nothing_over_these_inputs`, which is what makes these
    /// counts reproducible: substitute a shape's body for `expand`'s and run it. "Wrong"
    /// counts inputs whose output differs; the examples are inputs it is wrong on, and
    /// each of them is in that corpus.
    ///
    /// | shape | wrong | what it misses |
    /// |---|---|---|
    /// | `LeftmostLongest`, one match per step, reject and move on | 260 | the matches a rejected one skipped over: `awe'll` comes back unchanged, where the key is `'ll` → `" will"` and the rejected `we'll` took the scan past it |
    /// | the same, restarting one character into a rejected match | 46 | a match at the *same* start as the rejected one: `o'clocks` comes back unchanged, where `o'clock` is rejected there and `o'` → `of` begins where it did |
    /// | `Standard`, one match per step | 525 | the longer of two matches at one position — it answers with the one that ends *first*: `that’d’ve` becomes `that would’ve`, `o'er` becomes `ofer` |
    /// | `Standard`, every match, no early exit | **0** | nothing at all — but it scans to the end of the text once per replacement: 112 iterator steps against 28 on a 208-character paragraph, and 174 µs against 16 µs on an 860-character one |
    ///
    /// So the scan cannot be a search with a filter. It enumerates every match and picks
    /// the best accepted one, and the early exit below is what makes that affordable —
    /// it is the difference between the last row and what ships.
    ///
    /// # Why the early exit is sound
    ///
    /// The iterator reports matches in the order of their **end** offsets — the
    /// crate's own example for `append the app to the appendage` yields `0..3` before
    /// `0..6` before `11..14` — and every key is at most [`max_key_len`](Tables::max_key_len)
    /// bytes. So once a match ends more than `max_key_len` past `best`'s start, no
    /// match still to come can start at or before `best`'s start:
    ///
    /// ```text
    /// later.start >= later.end - max_key_len     (a key is at most max_key_len long)
    ///             >= found.end - max_key_len     (matches come in end order)
    ///             >  best.start                  (the exit condition)
    /// ```
    ///
    /// which settles both halves of the rule at once: nothing later can be further
    /// left, and nothing later can be a longer match at `best`'s own start. The check
    /// runs *before* the match is filtered, which is what keeps a rejected match from
    /// walking the rest of the text — and it is safe there for the same reason: a
    /// match that trips the condition starts right of `best`, so considering it could
    /// not have changed the answer.
    ///
    /// A trace of `I'd've said so, and we'll see.` is the shape of it. For the first
    /// replacement the iterator yields `i'd` (accepted, so far the best), `'d` inside it
    /// (accepted, not better) and `i'd've` (accepted, longer at the same start, now the
    /// best), and then `we'll` — whose end is past `0 + max_key_len`, and that is the
    /// exit: the rest of the sentence is never looked at. The second replacement takes
    /// two matches (`we'll`, then `'ll` inside it) and the text ends. Over a
    /// 128-character paragraph with six replacements that is 2.8 iterator steps per
    /// replacement; without the exit the same paragraph takes 112 steps for 28, because
    /// every replacement rescans to the end of the text.
    ///
    /// Measured, this shape against the two-automaton one it replaced (fast path plus
    /// a correction walk) on the same sentence and paragraph: 1.56 µs against 0.92 µs,
    /// and 15.8 µs against 8.6 µs. Both are noise against a 500–750 ms synthesis, and
    /// this one is a single automaton, a single loop and no correction path — the
    /// trade the `NOTICE` records. What it gives up is the sub-microsecond case; what
    /// it keeps is the rule.
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
                // Settled: see the module's proof. `MAX - end` in the comparison below
                // is how "longer is better" is spelled for an ordering that reads
                // left to right.
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
                    // Leftmost first, then longest: the whole rule.
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

/// Whether `text` contains an apostrophe one of the tables is keyed with.
///
/// `'` (U+0027) and `’` (U+2019), because [`merged_tables`] holds every
/// apostrophe-bearing key under both spellings. That duplication is upstream's —
/// the Python `contractions` package does
/// `contractions_dict.update({k.replace("'", "’"): v …})` — and it is what makes
/// a curly apostrophe work at all.
///
/// **The predicate lives here, beside the tables, because the caller that guards
/// the call has to ask the question the tables answer.** `normalizer.rs` used to
/// test `text.contains('\'')`, which is upstream's own guard, so a curly
/// apostrophe never reached [`fix_contractions`] — the `’` keys were unreachable
/// in the Python reference too. See `Normalizer::normalize_with_config`.
pub fn has_apostrophe(text: &str) -> bool {
    text.contains('\'') || text.contains('\u{2019}')
}

/// Build the automaton now, so that no sentence has to.
///
/// Called by `crate::tn::engine::english`, which runs in `finish_loading` — the
/// seam where this crate already pays for everything expensive once per worker
/// (English's two FSTs are 70 ms of parsing beside this 0.7 ms). Without it the
/// build would land on whichever sentence first contains an apostrophe, which the
/// measurement in the module comment is about.
pub fn warm_up() {
    Lazy::force(&TABLES);
}

/// The three tables merged the way upstream merges them, plus the month keys.
///
/// Shared with the tests, which keep the regex implementation this module used to
/// be so that the engine swap can be diffed rather than believed.
fn merged_tables() -> HashMap<String, String> {
    let mut map = HashMap::new();

    let parse_json = |json: &str| -> HashMap<String, String> {
        serde_json::from_str::<HashMap<String, String>>(json).unwrap_or_default()
    };

    // Load standard contractions
    for (k, v) in parse_json(CONTRACTIONS_JSON) {
        map.insert(k.to_lowercase(), v);
    }

    // Load leftovers
    for (k, v) in parse_json(LEFTOVERS_JSON) {
        if !v.is_empty() {
            // Skip empty mappings like "'all" → ""
            map.insert(k.to_lowercase(), v);
        }
    }

    // Load slang (optional, can be disabled)
    for (k, v) in parse_json(SLANG_JSON) {
        map.insert(k.to_lowercase(), v);
    }

    // Add month abbreviations
    for (abbrev, full) in MONTH_ABBREVS {
        map.insert(abbrev.to_string(), full.to_string());
    }

    // Handle apostrophe variants: ' (U+0027) vs ' (U+2019 curly apostrophe)
    // Add curly apostrophe variants for keys that contain straight apostrophe
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

/// The slang keys that are writing conventions rather than words, and are matched
/// case-**sensitively**.
///
/// Seven of the shipped table's forty-eight entries are text-speak — `b4`, `bc`,
/// `kk`, `r `, `rn`, `u`, `ur` — and every one of them collides with a capitalised
/// word or initialism in ordinary prose. Measured through the shipped pipeline,
/// with the tables running because the sentence happens to contain an apostrophe:
///
/// | text | with `(?i)` on every key | what it should be |
/// |------|--------------------------|-------------------|
/// | `It's 500 BC` | `it is five hundred because` | `five hundred B C` |
/// | `It's the U.S. Army` | `it is the you.S. Army` | `the U S Army` |
///
/// The other direction is why the keys are kept rather than dropped: `It's 4 u`
/// is `four you` and `It's b4 noon` is `before noon`, which is what those
/// conventions are for. Matching them exactly keeps both, because the conventions
/// are only ever written in lower case, while what they collide with is only ever
/// written in upper case — `BC` (before Christ), `U.S.`, `U` (uranium), `Ur` (the
/// city), `RN` (registered nurse), `B4` (the paper size), `R` (the letter).
///
/// **Upstream has the same collision** — `contractions.fix("It's 500 BC")` is
/// `It's 500 BECAUSE`, straight from the table — so this is a divergence from the
/// reference on purpose. It is pinned in `tests`, including the row in
/// [`tests::the_regex_rules_differ_from_the_reference_in_these_places`].
fn convention_keys() -> HashSet<String> {
    serde_json::from_str::<HashMap<String, String>>(SLANG_JSON)
        .unwrap_or_default()
        .into_keys()
        .map(|key| key.to_lowercase())
        .filter(|key| is_a_convention_rather_than_a_word(key))
        .collect()
}

/// Whether a slang key is a writing convention rather than a word.
///
/// "Two characters or fewer, or containing a digit" is the rule, and it is a rule
/// rather than the seven names it currently picks out so that a table bump which
/// adds `gr8` or `2day` gets the same treatment without anyone remembering to.
fn is_a_convention_rather_than_a_word(key: &str) -> bool {
    key.chars().count() <= 2 || key.chars().any(|c| c.is_ascii_digit())
}

/// Expand English contractions in text
///
/// This function is equivalent to Python's `contractions.fix(text)`.
/// It handles standard contractions, leftovers, and slang.
///
/// # Arguments
/// * `text` - Input text with potential contractions
///
/// # Returns
/// Text with contractions expanded
///
/// # Example
/// ```rust,ignore
/// use phonemize::tn::wetext::contractions::fix_contractions;
///
/// assert_eq!(fix_contractions("I don't know"), "I do not know");
/// assert_eq!(fix_contractions("It's gonna be fine"), "It is going to be fine");
/// assert_eq!(fix_contractions("Jan. 15th"), "january 15th");
/// ```
pub fn fix_contractions(text: &str) -> String {
    // Quick check: if no apostrophe-like chars and no known patterns, skip. With the
    // automaton this costs nothing to *run* (one pass either way), so the check is
    // here for the allocation, not for the scan.
    if !has_apostrophe(text) && !needs_expansion(text) {
        return text.to_string();
    }

    TABLES.expand(text)
}

/// Quick check for common patterns that need expansion (optimization)
fn needs_expansion(text: &str) -> bool {
    let lower = text.to_lowercase();
    // Check for common slang that doesn't contain apostrophes
    lower.contains("gonna")
        || lower.contains("wanna")
        || lower.contains("gotta")
        || lower.contains("dunno")
        || lower.contains("gimme")
        || lower.contains("lemme")
        // Check for month abbreviations
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

/// Expand contractions with configuration options
///
/// # Arguments
/// * `text` - Input text
/// * `_include_slang` - Whether to expand slang (default: true in Python)
///
/// Note: For simplicity, this implementation always includes slang.
/// If you need the option to exclude slang, rebuild PATTERNS without slang entries.
#[allow(dead_code)]
pub fn fix_contractions_with_options(text: &str, _include_slang: bool) -> String {
    // Current implementation always includes slang for simplicity
    // To support this option properly, would need separate pattern sets
    fix_contractions(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// **The old regex implementation, kept so the engine swap can be diffed.**
    ///
    /// This is `fix_contractions` as it was before the automaton: one
    /// `(?i)\b…\b` (or `\b…` for a month key, or exactly-cased for a convention)
    /// `Regex` per key, applied in a loop over the mutating string, longest key
    /// first. It exists only for the test below — the shipped path is the
    /// automaton — and it is deliberately not tidied: a reference that has been
    /// rewritten is no longer a reference.
    fn reference(text: &str) -> String {
        use std::sync::OnceLock;

        /// Built once, like the `Lazy` the shipped module used to hold: compiling
        /// 412 patterns per call is what made this test take twelve minutes the
        /// first time it ran.
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

    /// **The engine swap changed nothing, and this is the diff that says so.**
    ///
    /// Every key in the tables inside eleven carriers — word boundaries, text
    /// edges, letters, digits, quotes, dots — plus prose and the adversarial
    /// overlaps (`he'll've`, `I'd've`, `y'all'll`), run through the automaton and
    /// through [`reference`], which is the regex implementation the automaton
    /// replaced.
    ///
    /// The corpus is ASCII, which is the whole practical domain, and the one input
    /// class it therefore cannot cover is the one the two engines cannot agree on:
    /// `(?i)` is Unicode case folding and `ascii_case_insensitive` is not, so a long
    /// s (`ſ`) is an `s` to the reference and not to the automaton. That is asserted
    /// on its own in
    /// `the_regex_rules_differ_from_the_reference_in_these_places`, together with the
    /// reading it produces, and it is a step *towards* upstream rather than away from
    /// it.
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
            // Long enough that several matches land in one text and the early exit is
            // exercised where there is a great deal after each match.
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
        // A corpus that stopped covering the tables would pass the assertion above
        // and prove nothing.
        assert!(carriers.len() > 4000, "only {} inputs", carriers.len());
    }

    /// **What `is_word` is not: the regex crate's `\w`, measured.**
    ///
    /// The patterns this module replaced asked a Unicode-aware `\b`; the boundary
    /// predicates here ask [`char::is_alphanumeric`] plus `_`. The claim in [`is_word`]
    /// is that the two agree on every ASCII and Latin-1 character and part company in
    /// two categories, and this is the measurement rather than the assertion of it:
    ///
    /// - `\p{Word}` includes the combining marks and the join controls, which
    ///   `is_alphanumeric` does not — 432 characters below U+3000, starting at U+0300.
    /// - `is_alphanumeric` includes `No` and `Nl`, which `\p{Word}` does not — 235
    ///   characters below U+3000, starting at `²` and including `①` and `⅐`.
    ///
    /// **Nothing in either list is ASCII**, which is the whole reason this approximation
    /// is acceptable here: the keys are ASCII, so the predicate is only ever asked about
    /// a *neighbour* of one of them. Latin-1 is not as clean as it looked — the six `No`
    /// characters `²³¹¼½¾` are word characters here and not to `\w` — so the exception
    /// is pinned by name rather than by a range. The counts are pinned too, so that a
    /// change to either side of the comparison surfaces here.
    #[test]
    fn is_word_agrees_with_the_regex_word_class_over_these_code_points() {
        let theirs = regex::Regex::new(r"^\w$").expect("the pattern compiles");
        let (mut only_mine, mut only_theirs, mut ascii_differing, mut latin1) =
            (0, 0, 0, Vec::new());

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
                only_mine += 1;
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
        assert_eq!(only_mine, 235, "`No`/`Nl`, which \\p{{Word}} excludes");
        assert_eq!(
            only_theirs, 432,
            "marks and join controls, which \\w includes"
        );

        // The shapes behind the counts, so that a swap of one category for another
        // cannot pass by keeping the totals.
        for (character, mine) in [
            ('½', true),         // No — a word character here, not to `\w`
            ('①', true),         // No
            ('Ⅷ', true),         // Nl
            ('é', true),         // agreed: a letter either way
            ('_', true),         // agreed: connector punctuation that both have
            ('\u{0301}', false), // Mn — a word character to `\w`, not here
            ('\u{200d}', false), // Cf (join control) — the same
            ('\u{203f}', false), // Pc, which `\w` has and `_` above does not stand for
        ] {
            assert_eq!(
                is_word(Some(character)),
                mine,
                "{character:?} ({:#06x})",
                character as u32
            );
        }
    }

    /// **The early exit keeps the longest match at a position, and the one inside.**
    ///
    /// [`Tables::expand`] stops enumerating as soon as nothing later can beat the best
    /// it has, on the strength of the automaton's end-offset ordering and
    /// [`max_key_len`](Tables::max_key_len). A bound that stopped too *early* would not
    /// fail loudly — it would quietly take the shorter of two matches at the same
    /// position, or lose the one hiding inside a rejected match — so both are pinned
    /// here, next to the rule they protect. (A bound that stopped too *late* is only
    /// slower, and the equivalence harness would not see it either.)
    ///
    /// The length that matters: the longest key in the tables is
    /// `MAX_KEY_LEN`-ish, so the window is wide enough for the pairs below.
    #[test]
    fn the_early_exit_keeps_the_longest_match_at_a_position() {
        // Longest at one position, where the shorter key is accepted too: `o'` → `of`
        // and `o'clock` → `of the clock` both match `o'clock`, and the tables want the
        // longer one. A bound of "stop once something ends past the best's start" would
        // answer `ofclock`.
        assert_eq!(fix_contractions("o'clock"), "of the clock");
        assert_eq!(fix_contractions("o'clock today"), "of the clock today");

        // The same shape with the apostrophe leftovers: `I` + `'d` → ` would`, and
        // `I'd've` → `I would have`, at one position.
        assert_eq!(fix_contractions("I'd've"), "I would have");
        assert_eq!(fix_contractions("he'll've"), "he will have");

        // And the matches *inside* a rejected one, which is what the enumeration is for:
        // `o'clock` is rejected inside `o'clocks` (trailing boundary), and `o'` is the key
        // that fires; `you’d` is rejected inside `ayou’d` (leading boundary), and `’d` is.
        assert_eq!(fix_contractions("o'clocks"), "ofclocks");
        assert_eq!(fix_contractions("ayou’d"), "ayou would");

        // Several matches in one text, so the exit has to be right more than once — and
        // a paragraph, because the bound is only load-bearing when there is text after
        // the match.
        assert_eq!(
            fix_contractions("It's John's, and it's not what's-his-name's."),
            "it is John's, and it is not what is-his-name's."
        );
        let paragraph = "It's the best of times, and we'll see whether they don't mind \
             that she's already gone. I'd've said so, and he'd not have minded, 'cause \
             nothin' works the way it should.";
        assert_eq!(
            fix_contractions(paragraph),
            // `'cause` and `nothin'` are left alone, and not by accident: a key that
            // starts with an apostrophe needs a *word* character before it and one that
            // ends with one needs a *word* character after it, so `'cause` after a comma
            // and `nothin'` before a space are not occurrences of those keys. That is the
            // `doin' it` row of
            // `the_regex_rules_differ_from_the_reference_in_these_places` — the shape
            // this module has always had, and the half of it the reference reads the
            // other way round.
            "it is the best of times, and we will see whether they do not mind that she \
             is already gone. I would have said so, and he would not have minded, 'cause \
             nothin' works the way it should."
        );
    }

    #[test]
    fn test_basic_contractions() {
        assert_eq!(fix_contractions("I don't know"), "I do not know");
        // Note: regex replacement outputs lowercase expansion
        assert_eq!(fix_contractions("It's fine"), "it is fine");
        assert_eq!(fix_contractions("we're here"), "we are here");
    }

    #[test]
    fn test_slang() {
        // "I'm" is mapped to "I am" (preserves case in JSON)
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
        // Test both straight and curly apostrophes
        assert_eq!(fix_contractions("don't"), "do not");
        assert_eq!(fix_contractions("don’t"), "do not"); // curly apostrophe
    }

    /// **A specific key beats the general one it overlaps with.**
    ///
    /// `we'll` → `we will` rather than `We` + `'ll` → `" will"`, which is what
    /// the leftovers table would give and what an unordered walk of
    /// [`CONTRACTIONS`] gave *sometimes* — see [`PATTERNS`] for the measurement.
    /// The two readings phonemize the same today, so this is a pin on the reading
    /// rather than on an audible difference: it is here because it is the only
    /// thing that would go red if the sort were dropped, and because a word-level
    /// expectation that flips between runs is worse than no expectation at all.
    #[test]
    fn a_specific_contraction_wins_over_the_leftover_that_overlaps_it() {
        assert_eq!(fix_contractions("We'll go"), "we will go");
        assert_eq!(fix_contractions("We’ll go"), "we will go");
        assert_eq!(fix_contractions("I'll go"), "I will go");
        // The general key still answers where it is the only match — the case it
        // exists for.
        assert_eq!(fix_contractions("John'll go"), "John will go");
    }

    /// **Where these rules differ from the package the tables come from.**
    ///
    /// This file is a *regex* implementation of what upstream does with a
    /// literal-string engine (`TextSearch`), and five behaviours fall out of that
    /// difference. Each is asserted here with the upstream value beside it, so a
    /// reader comparing the two has the disagreement in front of them rather than in
    /// a commit message — and so that a rewrite (a single `aho-corasick` automaton,
    /// which is what would replace 412 compiled regexes) is a change of *decisions*
    /// rather than a change of behaviour nobody had written down.
    ///
    /// Measured against `contractions.fix` from `pip install contractions`, version
    /// 0.1.73 — the same version these tables are byte-identical to:
    ///
    /// | input | here | upstream |
    /// |-------|------|----------|
    /// | `doin' it` | `doin' it` | `doing it` |
    /// | `doin'it` | `doingit` | `doin'it` |
    /// | `jan.15` | `january15` | `jan.15` |
    /// | `whats up` | `whats up` | `what is up` |
    /// | `ſhe's here` | `ſhe's here` | `ſhe is here` |
    /// | `We'll go` | `we will go` | `We will go` |
    /// | `It's 500 BC` | `it is 500 BC` | `It is 500 BECAUSE` |
    #[test]
    fn the_regex_rules_differ_from_the_reference_in_these_places() {
        // 1. A key that ends in an apostrophe (`doin'`) is written `\bdoin'\b`, and
        //    a `\b` after a non-word character needs a word character to follow it.
        //    So the apostrophe form expands only when a letter comes next — exactly
        //    inverted from upstream, which takes the whole word `doin'` and leaves
        //    `doin'it` alone.
        assert_eq!(fix_contractions("doin' it"), "doin' it");
        assert_eq!(fix_contractions("doin'it"), "doingit");

        // 2. A month abbreviation is written `\bjan.` with no trailing boundary, on
        //    purpose — upstream's key is `jan.` and expects the space after it — so
        //    `jan.15` matches here and not there.
        assert_eq!(fix_contractions("jan. 15"), "january 15");
        assert_eq!(fix_contractions("jan.15"), "january15");

        // 3. `needs_expansion`, the quick check in front of the loop, does not list
        //    the two apostrophe-less leftovers, so the same word expands or does not
        //    depending on whether *some other part* of the sentence has an
        //    apostrophe.
        assert_eq!(fix_contractions("whats up"), "whats up");
        assert_eq!(fix_contractions("It's whats"), "it is what is");

        // 4. `ascii_case_insensitive` is ASCII case folding where the regex this
        //    replaced asked Unicode's `(?i)` and turned a long s into an `s`. The
        //    automaton does not, which is what upstream does too — so this is the
        //    one row in this table where the two engines *disagree* and the
        //    automaton is the closer to the reference. See
        //    `the_engine_swap_changes_nothing_over_these_inputs` for why this row is
        //    not in that diff.
        assert_eq!(fix_contractions("ſhe's here"), "ſhe's here");

        // 5. The replacement is the table's own lowercase value, where upstream
        //    keeps the case of the text it matched. Inaudible in English — the CMU
        //    lookup and the IPA are the same either way — but visible in the text
        //    this step hands to the tagger, so it is pinned.
        assert_eq!(fix_contractions("We'll go"), "we will go");

        // 6. The seven convention keys from the slang table are matched exactly
        //    here and case-insensitively there, where `BC` really does become
        //    `BECAUSE`. See `SMS_STYLE_KEYS`, and
        //    `a_convention_is_matched_exactly_so_prose_survives` for the rule.
        assert_eq!(fix_contractions("It's 500 BC"), "it is 500 BC");
    }

    /// **The text-speak keys are matched exactly, so ordinary prose survives.**
    ///
    /// Seven of the slang table's entries are conventions rather than words
    /// (`b4`, `bc`, `kk`, `r `, `rn`, `u`, `ur`), and with the whole table
    /// case-insensitive every one of them ate a capitalised word or initialism.
    /// Both directions are asserted here, because both are why the rule is
    /// "exact case" rather than "drop the table":
    ///
    /// - the sentence has to keep `BC` and `U.S.` — the initialisms the
    ///   conventions collide with, and the reason this fix exists at all. (That
    ///   `500` becomes `five hundred` is the *tagger's* work, not this step's, so
    ///   the pipeline-level version of these rows lives in `tests/wetext_en.rs`.)
    /// - and `4 u` / `b4` / `kk` / `rn` still expand, which is what the table is
    ///   for.
    ///
    /// Note what the first four rows have in common: they run only because the
    /// sentence contains an apostrophe (`Normalizer::normalize_with_config`'s
    /// guard), which is also why the last two are unchanged — `Normalizer`'s
    /// documented inconsistency, not this rule's doing.
    #[test]
    fn a_convention_is_matched_exactly_so_prose_survives() {
        assert_eq!(fix_contractions("It's 500 BC"), "it is 500 BC");
        assert_eq!(
            fix_contractions("It's the U.S. Army"),
            "it is the U.S. Army"
        );
        assert_eq!(fix_contractions("It's the RN"), "it is the RN");
        assert_eq!(fix_contractions("It's ancient Ur"), "it is ancient Ur");
        // The conventions themselves still work, which is the other half.
        assert_eq!(fix_contractions("It's 4 u"), "it is 4 you");
        assert_eq!(fix_contractions("It's b4 noon"), "it is before noon");
        assert_eq!(fix_contractions("It's kk"), "it is okay");
        assert_eq!(fix_contractions("It's rn"), "it is right now");
        // And the rule that picks them out, over the shipped table: only the
        // conventions, never a word, and never nothing.
        let mut picked: Vec<String> = convention_keys().into_iter().collect();
        picked.sort_unstable();
        assert_eq!(picked, ["b4", "bc", "kk", "r ", "rn", "u", "ur"]);
        assert!(!is_a_convention_rather_than_a_word("y'all"));
        assert!(!is_a_convention_rather_than_a_word("gonna"));
    }

    /// The guard and the tables have to agree about which apostrophes count.
    ///
    /// A `false` here means the caller skips the call, so a character the tables
    /// are keyed with but this predicate did not know would be a contraction that
    /// silently does not expand — which is the bug this predicate was extracted
    /// for. The list on the left is every apostrophe Unicode offers; the assertion
    /// is that whatever the tables actually use, the guard knows.
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
        // Regex case-insensitive matching replaces with lowercase expansion
        assert_eq!(fix_contractions("DON'T SHOUT"), "do not SHOUT");
        assert_eq!(fix_contractions("It's OK"), "it is OK");
    }
}
