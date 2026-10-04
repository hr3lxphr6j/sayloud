//! HeadTTS's letter-to-sound rules, against HeadTTS.
//!
//! Three things are checked here, and they are different questions:
//!
//! 1. **The rules are upstream's rules.** `headtts-en-parity.json` holds, for
//!    each of the 309 rules, the regular expression, the match length and the
//!    phonemes that *upstream's own constructor* computed. `rules.rs` is
//!    generated from that, and this test compares the two — so a transcription
//!    error is a failure here rather than a word that sounds slightly wrong.
//! 2. **The reading is upstream's reading.** The same fixture holds 296 words and
//!    what `Language#phonemizeWord` returned for each. The port has to return the
//!    same string, character for character.
//! 3. **The fixture is wide enough to mean something.** A parity corpus that
//!    exercises a third of the table pins a third of the table. A covering pass
//!    chose the words, and the four rules it could not reach are asserted to be
//!    exactly the four that cannot fire.
//!
//! The fixture is committed, so none of this needs a HeadTTS checkout or a
//! network. Regenerating it is `scripts/headtts-parity.mjs`; regenerating the
//! rules is `scripts/gen-headtts-rules.mjs`.
//!
//! **The expected values are not this repository's opinion.** They are a dump of
//! upstream, taken by running it — see that script for the provenance block it
//! records, which this file does not re-derive and cannot.

use phonemize::backends::headtts_en::{self, rules, to_ipa};
use serde_json::Value;

/// The fixture, parsed once. 58 KB of JSON is worth reading once per binary.
fn fixture() -> &'static Value {
    static FIXTURE: std::sync::OnceLock<Value> = std::sync::OnceLock::new();
    FIXTURE.get_or_init(|| {
        serde_json::from_str(include_str!("fixtures/headtts-en-parity.json"))
            .expect("the parity fixture parses")
    })
}

/// The reading the rules give, in HeadTTS's own notation.
fn native(word: &str) -> String {
    headtts_en::phonemize_native(word).unwrap_or_else(|| panic!("{word:?} has no reading"))
}

#[test]
fn the_rule_table_is_upstreams() {
    // Every field of every rule, in upstream's order. This is the test that makes
    // `rules.rs` a transcription rather than a claim to be one.
    let expected = fixture()["rules"].as_array().expect("rules is an array");
    assert_eq!(
        expected.len(),
        rules::RULES.len(),
        "the fixture and rules.rs disagree about how many rules there are"
    );

    for (index, row) in expected.iter().enumerate() {
        let row = row.as_array().expect("a rule is an array");
        let letter = row[0].as_str().expect("the group").chars().next().unwrap();
        let (regex, advance, phonemes) = (
            row[1].as_str().expect("the pattern"),
            row[2].as_u64().expect("the advance") as u8,
            row[3].as_str().expect("the phonemes"),
        );
        let rule = &rules::RULES[index];

        assert_eq!(
            rule.regex, regex,
            "rule {index} ({letter}) has the wrong pattern"
        );
        assert_eq!(
            rule.advance, advance,
            "rule {index} ({letter}) advances wrong"
        );
        assert_eq!(
            rule.phonemes, phonemes,
            "rule {index} ({letter}) says the wrong thing"
        );
        // And it is in the group upstream put it in, which is what decides which
        // rules are tried before it.
        assert!(
            rules::group(letter).is_some_and(|group| group.contains(rule)),
            "rule {index} is not reachable from {letter}"
        );
    }
}

#[test]
fn every_fixture_word_reads_the_way_headtts_reads_it() {
    // The port's whole claim. 296 words, character for character — including the
    // punctuated ones, because a hyphen is echoed and a digit is dropped.
    let words = fixture()["words"].as_array().expect("words is an array");
    assert!(
        words.len() >= 200,
        "the corpus should be wider than a sample"
    );

    let mut wrong = Vec::new();
    for entry in words {
        let word = entry["word"].as_str().expect("the word");
        let normalized = entry["normalized"].as_str().expect("the normalized form");
        let expected = entry["phonemes"].as_str().expect("the phonemes");

        // The word in the fixture is the *unnormalized* one; upstream was handed
        // the normalized form, and so is the port. Both are asserted, so a
        // difference in normalization cannot hide behind the rules agreeing.
        assert_eq!(
            headtts_en::normalize(word),
            *normalized,
            "{word:?} normalizes differently"
        );
        let actual = native(normalized);
        if actual != expected {
            wrong.push(format!("{word}: expected {expected:?}, got {actual:?}"));
        }
    }

    assert!(
        wrong.is_empty(),
        "{} of {} words differ from HeadTTS:\n{}",
        wrong.len(),
        words.len(),
        wrong.join("\n")
    );
}

#[test]
fn the_fixture_reaches_all_but_the_four_rules_that_cannot_fire() {
    // A parity corpus is only as good as its coverage, and the coverage is
    // measured rather than assumed: the covering pass in
    // `scripts/headtts-parity.mjs` chose the words, so every rule that a spelling
    // can reach is reached here.
    //
    // The four that are not are shadowed by an earlier rule in their own group,
    // and no word reaches them — which is a property of upstream's table, not of
    // the corpus. Kept as data (`rules.rs` transcribes the table whole) and
    // asserted here, so the claim is checked rather than repeated.
    let words = fixture()["words"].as_array().expect("words is an array");
    let mut exercised: Vec<(char, usize)> = words
        .iter()
        .flat_map(|entry| {
            let normalized = entry["normalized"].as_str().expect("the normalized form");
            headtts_en::trace(normalized).expect("every fixture word traces")
        })
        .collect();
    exercised.sort_unstable();
    exercised.dedup();

    let all: Vec<(char, usize)> = ('A'..='Z')
        .flat_map(|letter| {
            let group = rules::group(letter).expect("every letter has a group");
            (0..group.len()).map(move |offset| (letter, offset))
        })
        .collect();
    assert_eq!(all.len(), rules::RULES.len());

    let uncovered: Vec<String> = all
        .iter()
        .filter(|rule| !exercised.contains(rule))
        .map(|(letter, offset)| format!("{letter}#{offset}"))
        .collect();

    assert_eq!(uncovered, ["E#12", "E#20", "I#10", "O#10"]);
    assert_eq!(exercised.len(), rules::RULES.len() - 4);
    assert_eq!(
        fixture()["counts"]["rulesExercised"].as_u64(),
        Some(exercised.len() as u64),
    );
}

#[test]
fn the_vocabulary_keeps_every_phoneme_the_rules_can_emit() {
    // The rules write misaki's notation and the pipeline writes IPA, but they
    // have to agree about which symbols exist: the vocabulary gate is what turns a
    // symbol the model cannot use into an error, and an OOV word taken from real
    // text is exactly where an unexpected one would turn up.
    use phonemize::vocab::Vocab;

    let words = fixture()["words"].as_array().expect("words is an array");
    let vocab = Vocab::V1_0;
    let mut missing: Vec<String> = Vec::new();
    for entry in words {
        let word = entry["word"].as_str().expect("the word");
        // The hyphenated and apostrophized words are left out, and they are the
        // only thing this test leaves out: the engine echoes a hyphen and an
        // apostrophe the way upstream does, and neither is in the vocabulary —
        // `keep_punctuation` deletes them before the gate ever sees them, which is
        // what the pipeline has always done with a hyphen (`twenty-four` →
        // `twˈɛntifoʊɹ`). A Latin run cannot contain one either: `segment_text`
        // emits `[A-Za-z]+`.
        if !word
            .chars()
            .all(|character| character.is_ascii_alphabetic())
        {
            continue;
        }
        let ipa = headtts_en::phonemize(entry["normalized"].as_str().unwrap()).expect("reads");
        for character in ipa.chars() {
            if character.is_whitespace() || vocab.characters().any(|kept| kept == character) {
                continue;
            }
            missing.push(format!("{word}: {}", character.escape_debug()));
        }
    }
    missing.dedup();
    assert!(missing.is_empty(), "{}", missing.join("\n"));
}

// ---------------------------------------------------------------------------
// The words worth naming, one at a time
//
// The parity test above covers all 296 by construction; these are the ones whose
// *reading* is the point, so that a regression names the word instead of dumping
// a diff of the corpus. Every expectation here is also in the fixture — these are
// the fixture read out loud.
// ---------------------------------------------------------------------------

/// The reading the rules give, as IPA, for a word the dictionary does not have.
fn ipa(word: &str) -> String {
    headtts_en::phonemize(word).unwrap_or_else(|| panic!("{word:?} has no reading"))
}

#[test]
fn product_names_that_used_to_be_spelled_letter_by_letter() {
    // The words this phase exists for. Before it, each of these was six or eight
    // letters read as six or eight letters.
    assert_eq!(ipa("Kokoro"), "kɑkɔɹoʊ");
    assert_eq!(ipa("OpenAI"), "oʊpɛneɪ");
    assert_eq!(ipa("GitHub"), "ɡɪθəb");
    assert_eq!(ipa("TypeScript"), "tɪpɛskɹɪpt");
    assert_eq!(ipa("PyTorch"), "paɪtɔɹtʃ");
    assert_eq!(ipa("YouTube"), "jutub");
    assert_eq!(ipa("iPhone"), "ɪfoʊn");
    assert_eq!(ipa("localhost"), "lˈoʊkɔlhoʊst");
    assert_eq!(ipa("kubectl"), "kjubɛktl");
}

#[test]
fn a_stress_mark_before_a_diphthong_survives_translation() {
    // The stress marks are their own phonemes in HeadTTS's output and are written
    // *before* the vowel, which is also where the dictionary side puts them — so
    // the translation keeps that order rather than reordering anything.
    assert_eq!(native("KOKORO"), "kɑkɔɹO");
    assert_eq!(to_ipa("kɑkɔɹO"), "kɑkɔɹoʊ");
    assert_eq!(ipa("localhost"), "lˈoʊkɔlhoʊst");
}

#[test]
fn surnames_and_place_names() {
    assert_eq!(ipa("wojciechowski"), "wɑdʒsiɛtʃoʊskɪ");
    assert_eq!(ipa("srinivasan"), "sɹɪnɪvæzæn");
    assert_eq!(ipa("nakamura"), "nækæmjʊɹə");
    assert_eq!(ipa("reykjavik"), "ɹikdʒævɪk");
    assert_eq!(ipa("ljubljana"), "ldʒəbldʒænə");
    assert_eq!(ipa("yosemite"), "joʊzɛmɪt");
}

#[test]
fn the_irregular_spellings_the_report_was_written_for() {
    // The `-ough` family, which is the standard demonstration that English needs
    // rules and not a letter table: seven words, seven different vowels. That
    // `cough` is right and `laugh` is not is the honest summary of a 1976 rule
    // table — see `readings_that_are_wrong_and_are_kept_anyway` below.
    assert_eq!(ipa("tough"), "təf");
    assert_eq!(ipa("through"), "θɹu");
    assert_eq!(ipa("thorough"), "θɜɹoʊ");
    assert_eq!(ipa("bought"), "bɔt");
    assert_eq!(ipa("though"), "ðoʊ");
    assert_eq!(ipa("cough"), "kəf");
    assert_eq!(ipa("enough"), "ɛnəf");
    assert_eq!(ipa("rough"), "ɹəf");
    assert_eq!(ipa("borough"), "bɜɹoʊ");
}

#[test]
fn the_rules_are_not_an_initialism_reader() {
    // "Not an initialism reader" is a claim about this module in the same breath
    // as it is a limitation, and the limitation is pinned here: asked for an
    // all-capitals run, the rules offer something worse than the letters, and
    // that is why the pipeline never asks. `http` loses its `h` to `[TH]` in a
    // word that starts with `H`, and `xyz` is one syllable.
    //
    // The pipeline's capitals rule is in `EnglishG2p`, and `tests/en_g2p.rs`
    // asserts that `HTTP` still comes out as the letters.
    assert_eq!(ipa("HTTP"), "ttp");
    assert_eq!(ipa("XYZ"), "sɪz");
    assert_eq!(ipa("JSON"), "dʒsən");
    assert_eq!(ipa("SQL"), "skl");
}

#[test]
fn the_headtts_test_suites_own_samples() {
    // `tests/language-en-us.test.mjs` in the HeadTTS checkout, which is the only
    // expectation in this file that upstream also asserts.
    assert_eq!(ipa("AND"), "ænd");
    assert_eq!(ipa("MERCHANDISE"), "mɜɹtʃændaɪz");
    assert_eq!(ipa("NOTINDICTIONARY"), "nɑtaɪndɪkʃənɛɹi");
}

#[test]
fn the_rules_handle_ordinary_spellings_too() {
    // Not the path a dictionary word takes — every one of these is in CMU Dict and
    // would be looked up — but an OOV word has to read like a word, and these are
    // the ordinary spellings a surname is built out of.
    //
    // The stress marks come from upstream's own table: `[PEOP]=P IY1 P` is a
    // stressed vowel mid-word, so `people` arrives with one and `cat` does not.
    for (word, expected) in [
        ("cat", "kæt"),
        ("dog", "dɑɡ"),
        ("house", "haʊz"),
        ("water", "wɑtɜɹ"),
        ("people", "pˈipəl"),
        ("school", "skul"),
        ("night", "naɪt"),
        ("knight", "naɪt"),
        ("question", "kwɛstʃən"),
        ("nature", "nætʃɜɹ"),
        ("vision", "vɪʒən"),
        ("chemistry", "tʃɛmɪstɹi"),
        ("morning", "mɔɹnɪŋ"),
        ("computer", "kɑmpjutɜɹ"),
        ("garden", "ɡɑɹdɛn"),
        ("yellow", "jɛloʊ"),
    ] {
        assert_eq!(ipa(word), expected, "{word}");
    }
}

#[test]
fn readings_that_are_wrong_and_are_kept_anyway() {
    // A rule table is an approximation and this phase does not pretend otherwise.
    // These are the readings that are wrong, pinned so that they are a known cost
    // of the fallback rather than a surprise — and so that a future phase that
    // fixes one has to say so.
    //
    // `laugh` loses its `f` to `[AU]=AO` plus a silent `[GH]`, where the CMU
    // dictionary has `L AE1 F` — the dictionary path is why nobody hears this.
    // `psychology` voices the `p`, which English does not. `chemistry` keeps the
    // `h` out but gets the `ch` right, which is the luck of the table.
    assert_eq!(ipa("laugh"), "lɔ");
    assert_eq!(ipa("psychology"), "psɪtʃɑlɑdʒi");
    // `window` and `orange` are the same kind of miss: an `-ow` read as a long
    // `i` plus `oʊ` where English says `ɪ`, and an `-ange` read as `eɪ` where
    // English says `æ`.
    assert_eq!(ipa("window"), "waɪndoʊ");
    assert_eq!(ipa("orange"), "ɔɹeɪndʒ");
    // `ChatGPT` is the one to know about: the `Chat` half is right and the `GPT`
    // half is a consonant cluster with no vowel. It is a word the dictionary does
    // not have and an initialism read as a word, and the pipeline's answer —
    // spelled out, because it is not all capitals — is the other half of the
    // problem.
    assert_eq!(ipa("ChatGPT"), "tʃætɡpt");
}

#[test]
fn a_word_of_silent_letters_reads_as_nothing_rather_than_failing() {
    // `[H]=` is upstream's answer for a bare `h`, and it is a real answer: an
    // empty reading is what `H` sounds like. The caller decides what to do with
    // one — the pipeline spells such a word out — but this module must not
    // confuse "silent" with "no idea", which is `None`.
    assert_eq!(
        phonemize::backends::headtts_en::phonemize("hhh"),
        Some(String::new())
    );
    assert_eq!(native("hhh"), "");
}

#[test]
fn the_fixture_records_where_it_came_from() {
    // Provenance, asserted rather than trusted, because `rules.rs` quotes these
    // strings in its own header and the two are generated separately.
    let source = &fixture()["source"];
    assert_eq!(source["url"], "https://github.com/met4citizen/HeadTTS");
    assert_eq!(source["license"], "MIT (c) 2025 Mika Suominen");
    assert_eq!(
        source["sha256"].as_str().map(str::len),
        Some(64),
        "the fixture should name the upstream revision it was dumped from"
    );
}
