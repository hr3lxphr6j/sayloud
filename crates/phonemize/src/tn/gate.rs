//! A cheap filter in front of English text normalization.
//!
//! # Why there is a gate at all
//!
//! English TN is two weighted-FST compositions, and 92% of the cost is the
//! tagger: 33 ms for 710
//! characters of prose in a release build, growing linearly with the input. That
//! cost is paid on *every* English sentence, because upstream's English TN is
//! deliberately not gated on digits — `should_normalize` returns true for any
//! non-empty English text (the condition is `lang != "en"` in the Python
//! reference and in the vendored copy; see modification 5 in
//! `src/tn/wetext/NOTICE`). So the only place a cheaper decision can be
//! made is *before* the tagger.
//!
//! The gate answers one question — "could this text contain anything TN would
//! rewrite?" — and [`pipeline::phonemize_en`](crate::pipeline::phonemize_en)
//! returns the text unchanged when the answer is no.
//!
//! # It is an over-approximation, and it has to be
//!
//! Saying "skip" must never lose a rewrite; saying "run it" only costs the
//! composition that would have happened anyway. So every judgement here is
//! deliberately wide, and the widening is one-way: a new criterion is cheap, a
//! missed one is silent wrong audio.
//!
//! # It is not a second definition of what needs normalizing
//!
//! It cannot be, because it is not the authority — the normalizer is. What keeps
//! the two from drifting is a test rather than a promise:
//! `tests/tn_gate.rs` asserts, over a corpus, that a `false` from here implies
//! the tagger found nothing but `w` and `p` **and** that the whole normalizer
//! left the text alone. If the grammar gains a class this list does not cover,
//! that test goes red instead of the pipeline quietly getting worse.
//!
//! **The normalizer, not the tagger, because two of the criteria answer about the
//! steps around it.** English's configuration expands contractions and folds
//! full-width forms before and around the composition, so a sentence with an
//! apostrophe in it is one the normalizer changes whether or not the tagger has
//! anything to add — and the gate has to say so, because the composition is what
//! it is deciding about. The two predicates that answer for those steps name the
//! step they stand for, and `tn::engine`'s configuration is what makes them true.
//!
//! # Why a hand-written scan rather than a regex
//!
//! The criteria are all "does this character class occur" and "does this token
//! have this shape", which is a dozen lines of byte arithmetic. `regex` is
//! already in the dependency graph (the vendored engine's contraction tables use
//! it, and `piper-plus-g2p` links it), so it would cost no new dependency — but
//! it would cost a compiled automaton, and this runs on every English sentence
//! including the ones with nothing in them. The scan is one pass, no allocation,
//! and measures 4–5 µs for 710 characters against the 33 ms it decides about.
//!
//! # The one criterion that is not a shape
//!
//! `Mon`, `Mr`, `Ms`, `TV` and friends are rewritten by the grammar (`Mon` →
//! `Monday`, `Mr` → `Mister`) and have no distinguishing shape at all: they are
//! ordinary title-cased or all-caps words. They come from
//! `tn/english/data/whitelist/alternatives.tsv`, which the tagger reads as a
//! string map, and the only way to see them without running the tagger is to
//! know the words. [`SHAPE_LESS_ABBREVIATIONS`] is that list; the part of the same
//! class it cannot cover is quantified on it below.

/// Characters upstream's `tn/english/data/whitelist/symbol.tsv` maps to a spoken
/// word, plus the `/` that only ever appears next to one of them.
///
/// The grammar composes every visible character *except* `/` with this table, so
/// a `/` on its own is not a rewrite — but a `/` is never on its own in practice
/// (`and/or`, `km/h`, `w/o`) and a URL's `://` is the same character. Keeping it
/// makes the rule one character class instead of a class plus an exception, and
/// the cost of being wrong is one extra composition.
///
/// The table is 22 rows and the two degree signs are separate rows mapping to the
/// same word; all 22 are here, which is three more than the brief listed (`¥`,
/// `°` and `º` are also in it).
fn is_normalized_symbol(character: char) -> bool {
    matches!(
        character,
        '&' | '#'
            | '@'
            | '§'
            | '™'
            | '®'
            | '©'
            | '_'
            | '%'
            | '*'
            | '+'
            | '/'
            | '='
            | '^'
            | '|'
            | '~'
            | '$'
            | '£'
            | '€'
            | '₩'
            | '¥'
            | '°'
            | 'º'
    )
}

/// Dot-less abbreviations whose *reading* the grammar changes and whose shape is
/// indistinguishable from an ordinary word.
///
/// The days, the titles and `Jr`, measured against the shipped grammars: `Mon` →
/// `Monday`, `Tu` → `Tuesday`, `Th` → `Thursday`, `Mr` → `Mister`, `Mrs` →
/// `Misses`, `Ms` → `Miss`, `Jr` → `junior`. The first 12 are upstream's
/// `tn/english/data/whitelist/alternatives.tsv` with its dot-less keys taken —
/// except that `Tue`, `Thu` and `Thurs` are in that table and are *not* tagged by
/// this build of the grammar, and are kept anyway, because the condition is one
/// the grammar would not have to announce and being early costs a false positive
/// rather than a wrong reading. `TV` is in the same table and is not here, because
/// its two capitals are already [`has_capital_run`]'s business. `Jr` is the one
/// entry that comes from `tts.tsv` instead.
///
/// # What this list is not
///
/// It is **not** a list of the grammar's abbreviations. Those are 3,050 rows of
/// upstream data (`tts.tsv`) and every one of them is tagged, because the tagger
/// reads the table as a string map and a string map has no shape. What is here is
/// the subset that has no dot, digit, symbol or capital run to be recognised by
/// *and* whose reading is a different word rather than the same word in capitals —
/// the subset that can be heard. What is missing from it: of the 1,127 shape-less
/// whitelist keys this gate skips, 182 change the phonemes and the other 945 are
/// proper nouns (`Acis`, `Uusi`, `Vrtis`) whose
/// capitalisation the pipeline's G2P spells out the same way either way.
const SHAPE_LESS_ABBREVIATIONS: [&str; 15] = [
    // Days.
    "Mon", "Tue", "Wed", "Thu", "Thur", "Thurs", "Fri", "Sat", "Sun", "Tu", "Th",
    // Titles.
    "Mr", "Mrs", "Ms", "Jr",
];

/// Whether English text normalization could change `text`.
///
/// A `false` is a promise that the normalizer would have returned the text
/// unchanged; a `true` costs one composition that may still find nothing to do.
/// Which criteria are in it, and why, is the module documentation; the test that
/// holds the promise is `tests/tn_gate.rs`.
///
/// The last two criteria are not about the *tagger* at all: they are about the two
/// steps the configuration runs around it, which upstream's gate has no term for
/// because upstream leaves both switches off. `step_rewrites_an_apostrophe` and
/// `step_rewrites_a_full_width_form` name the step each one stands for, so that a
/// switch turned on in `tn::engine` and a criterion added here are recognisably
/// the same decision.
pub fn needs_normalization(text: &str) -> bool {
    text.bytes().any(|byte| byte.is_ascii_digit())
        || text.chars().any(is_normalized_symbol)
        || has_capital_run(text)
        || has_terminated_abbreviation(text)
        || contains_shape_less_abbreviation(text)
        || text.chars().any(step_rewrites_an_apostrophe)
        || text.chars().any(step_rewrites_a_full_width_form)
}

/// An apostrophe the `fix_contractions` step will expand.
///
/// Not a shape to be recognised but a fact about the shipped tables: they are
/// keyed under both spellings of the apostrophe (`tn::wetext::contractions`), so
/// either one makes `We'll` / `We’ll` a rewrite — `we will`. It is the same
/// question the normalizer's own guard asks, and it has to be, or the gate and the
/// step disagree and the disagreeing direction is a contraction that silently does
/// not expand.
///
/// **Counting apostrophes as a reason to run the tagger is the cost of this
/// criterion.** English prose uses them constantly, so sentences that used to be
/// skipped wholesale now pay the composition — the price of the reading being
/// right, and the reason `We'll go` was `wiːˈɛl ˈɛl ɡˈoʊ` instead of
/// `wiː wɪl ɡˈoʊ`.
fn step_rewrites_an_apostrophe(character: char) -> bool {
    character == '\'' || character == '\u{2019}'
}

/// A character the `full_to_half` step will fold to its ASCII form.
///
/// The foldable range is U+FF01–U+FF5E, measured against the shipped FST: 91 of
/// the 239 characters in the whole width block move, and the ones that do not are
/// the half-width katakana and hangul and the currency signs, which this step
/// leaves alone and `text.rs` drops anyway. The criterion is deliberately the
/// *wider* block, so that a `＃` — one of the three the FST does not fold — costs
/// a composition instead of being missed, and the two curly double quotes, which
/// the FST does fold to `"`.
///
/// It has to be *here* rather than only in the FST: the preprocessor runs inside
/// `tn::normalize`, which is a call this gate can prevent. `ＡＢＣ` returned
/// `false` before this criterion existed, and the sentence it was in lost its
/// Latin — `Ｈｅｌｌｏ world` phonemized to `wˈɜːld`.
fn step_rewrites_a_full_width_form(character: char) -> bool {
    matches!(character, '\u{ff01}'..='\u{ff5e}' | '\u{201c}' | '\u{201d}')
}

/// Two ASCII capitals in a row: `TV`, `USA`, `II`, and the initials of a name.
///
/// Upstream tags this shape directly — the tagger has an `UPPER (("." | ". ")
/// UPPER){2,}` rule — and it is also how `U.S.A.` is reached, where the capitals
/// are separated by dots rather than adjacent (that one [`has_terminated_abbreviation`]
/// catches first). `IV` and `III` are caught here as *false* positives: upstream
/// ships a Roman rule but deliberately leaves it out of the default English
/// pipeline, so those are `w` and this is a wasted composition.
fn has_capital_run(text: &str) -> bool {
    let bytes = text.as_bytes();
    bytes
        .windows(2)
        .any(|pair| pair[0].is_ascii_uppercase() && pair[1].is_ascii_uppercase())
}

/// A `.` that closes a 1–5 letter token which has something after it.
///
/// This is the shape of `Dr. Smith`, `Ph.D.` and `U.S.A.`, all of which the
/// grammar tags `whitelist`; the 1–5 bound is upstream's (`Dr`, `Mrs`, `Prof`,
/// `Co`, `Inc`, `Ltd`, `Ph`), and the trailing-text condition is what keeps the
/// rule from firing on every sentence that ends in a short word — `the mat.` is
/// a period, not an abbreviation.
///
/// **A sentence-final `Dr.` is the case that condition gets wrong.** The grammar
/// does tag it, so `Contact Dr.` is read `Contact doctor` and this returns
/// `false`. It is left that way on purpose: the alternative is to fire on prose
/// whose sentences end in any word of five letters or fewer, which is a large
/// fraction of real input, and the cost of this one is a miss on a shape that is
/// rare at the end of a sentence.
fn has_terminated_abbreviation(text: &str) -> bool {
    let bytes = text.as_bytes();
    for (dot, byte) in bytes.iter().enumerate() {
        if *byte != b'.' || dot + 1 == bytes.len() {
            continue;
        }
        let mut start = dot;
        while start > 0 && bytes[start - 1].is_ascii_alphabetic() {
            start -= 1;
        }
        if (1..=5).contains(&(dot - start)) {
            return true;
        }
    }
    false
}

/// Whether `text` contains one of [`SHAPE_LESS_ABBREVIATIONS`] as a whole word.
///
/// A 15-entry linear scan with a boundary check on both ends. Case-sensitive, the
/// way the grammar is: `mon` is not a rewrite, `Mon` is.
fn contains_shape_less_abbreviation(text: &str) -> bool {
    let bytes = text.as_bytes();
    SHAPE_LESS_ABBREVIATIONS.iter().any(|word| {
        let word = word.as_bytes();
        bytes
            .windows(word.len())
            .enumerate()
            .any(|(start, window)| {
                window == word
                    && !bytes
                        .get(start.wrapping_sub(1))
                        .is_some_and(|byte| byte.is_ascii_alphanumeric())
                    && !bytes
                        .get(start + word.len())
                        .is_some_and(|byte| byte.is_ascii_alphanumeric())
            })
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The criteria, one case each, in the shape the pipeline will see.
    #[test]
    fn fires_on_every_criterion() {
        // A digit.
        assert!(needs_normalization("I have 3 cats"));
        // A symbol from the whitelist table.
        for symbol in "&#@§™®©_%*+/=^|~$£€₩¥°º".chars() {
            assert!(
                needs_normalization(&format!("a {symbol} b")),
                "{symbol} is in symbol.tsv"
            );
        }
        // A capital run, and the two-dot initialism it does not catch on its own.
        assert!(needs_normalization("watching TV"));
        assert!(needs_normalization("the U.S.A."));
        // A terminated abbreviation.
        assert!(needs_normalization("Dr. Smith"));
        assert!(needs_normalization("Ph.D. in physics"));
        // A shape-less alternative.
        assert!(needs_normalization("see you on Mon morning"));
    }

    /// And the negative side: prose with none of the above is skipped.
    #[test]
    fn stays_quiet_on_prose_with_nothing_in_it() {
        for prose in [
            "the quick brown fox jumps over the lazy dog",
            "Hello there, how are you?",
            "This is a sentence, and another one follows it.",
            "a well-known fact about the world",
        ] {
            assert!(!needs_normalization(prose), "{prose:?}");
        }
    }

    /// A sentence-final period is not an abbreviation, and that is the whole
    /// reason the trailing-text condition exists.
    #[test]
    fn a_sentence_final_period_is_not_an_abbreviation() {
        assert!(!needs_normalization("The cat sat on the mat."));
        assert!(!needs_normalization("It is done."));
        // But the same shape mid-sentence is one, because that is `Dr. Smith`.
        assert!(needs_normalization("the mat. Then it ended"));
    }

    /// The shape-less list matches whole words only.
    #[test]
    fn the_shape_less_list_matches_whole_words() {
        assert!(needs_normalization("I saw Mrs Smith"));
        assert!(needs_normalization("Mrs. Smith"));
        // Not a word: `Money` and `Sunshine` contain `Mon`/`Sun`.
        assert!(!needs_normalization("save your money"));
        assert!(!needs_normalization("the sunshine was lovely"));
    }
}
