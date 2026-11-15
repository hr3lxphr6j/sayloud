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
