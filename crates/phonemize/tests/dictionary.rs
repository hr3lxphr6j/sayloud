//! The dictionary protocol, tested through the registry the wasm
//! boundary is a thin wrapper around.
//!
//! Deliberately not through `Phonemizer`: its methods return `Result<_, JsValue>`,
//! and constructing a `JsValue` on a non-wasm target panics. The wrapper itself
//! is covered by the one test at the bottom, which only exercises the `Ok` path.

use std::fs;
use std::path::PathBuf;

use phonemize::dictionary::{primary_language, DictionaryError, DictionaryRegistry};
use phonemize::Phonemizer;

/// The Japanese dictionary's name, as `required_dictionaries` spells it.
const IPADIC: &str = "lindera-ipadic-ja";

/// The Chinese dictionary's name, as `required_dictionaries` spells it.
const JIEBA: &str = "jieba-zh-dict";

/// The English text-normalization grammars, as `required_dictionaries` spells
/// them.
///
/// Phase 9B. English's *phonemes* still need no dictionary — the CMU dictionary
/// is compiled in — but its numerals come from the vendored WeText engine, whose
/// grammars are 12 MB of OpenFST binary and therefore an asset.
const WETEXT_EN: [&str; 2] = ["wetext-en-tn-tagger", "wetext-en-tn-verbalizer"];

/// The Chinese ones (phase 9E).
///
/// Chinese and Japanese now fetch grammars as well as a word list, and that is
/// the shape every language has: this list is the *numeral* step, not the
/// phoneme step, so it is additive to whatever the phonemes need.
const WETEXT_ZH: [&str; 2] = ["wetext-zh-tn-tagger", "wetext-zh-tn-verbalizer"];

/// The Japanese ones (phase 9E).
const WETEXT_JA: [&str; 2] = ["wetext-ja-tn-tagger", "wetext-ja-tn-verbalizer"];

/// Everything `required_dictionaries("kokoro-v1", "ja-JP")` returns, in order:
/// the language's own dictionary first, then its two grammars.
const JA_REQUIRED: [&str; 3] = [IPADIC, WETEXT_JA[0], WETEXT_JA[1]];

/// Everything `required_dictionaries("kokoro-v1", "zh-CN")` returns.
const ZH_REQUIRED: [&str; 3] = [JIEBA, WETEXT_ZH[0], WETEXT_ZH[1]];

/// A path inside the repo, resolved from this crate rather than the cwd — `cargo
/// test` runs with the package directory as the working directory.
fn fixture(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/fixtures")
        .join(name)
}

fn fixture_bytes(name: &str) -> Vec<u8> {
    let path = fixture(name);
    fs::read(&path).unwrap_or_else(|error| panic!("could not read {}: {error}", path.display()))
}

/// A registry that has been told which frontend and language to prepare for.
fn declared(vocab: &str, lang: &str) -> DictionaryRegistry {
    let mut registry = DictionaryRegistry::new();
    registry
        .declare_required(vocab, lang)
        .unwrap_or_else(|error| panic!("declare_required({vocab}, {lang}): {error}"));
    registry
}

/// Feed every name in a list the transport fixture, then finish.
///
/// Any zstd frame does: the registry only checks that everything asked for
/// arrived, and it is `Phonemizer::finish_loading` — not the registry — that
/// parses it into something a pipeline can use.
fn load_fixture(registry: &mut DictionaryRegistry, names: &[&str]) {
    for name in names {
        registry
            .load(name, &fixture_bytes("test-dict.json.zst"))
            .unwrap_or_else(|error| panic!("{name}: {error}"));
    }
    registry.finish().unwrap_or_else(|error| panic!("{error}"));
}

#[test]
fn japanese_needs_the_ipadic_dictionary_and_two_grammars() {
    let registry = declared("kokoro-v1", "ja-JP");

    assert_eq!(registry.required(), JA_REQUIRED);
}

#[test]
fn english_needs_the_two_text_normalization_grammars() {
    // English used to be the case where `prepare` had nothing to fetch — the CMU
    // dictionary is compiled into the wasm — and it is the assertion
    // that changed in phase 9B, on purpose: the numeral step is the vendored
    // WeText engine, and its two grammars are fetched like every other
    // language's.
    //
    // Two names rather than one archive: the registry's unit is a single zstd
    // frame, and the tagger without the verbalizer can only fail.
    assert_eq!(declared("kokoro-v1", "en-US").required(), WETEXT_EN);
}

#[test]
fn chinese_needs_the_jieba_dictionary_and_two_grammars() {
    // The pinyin tables are compiled in, but the word list is not. This test was
    // written as a tripwire for exactly this decision — its comment said "if the
    // Chinese segmenter turns out to be lindera-cc-cedict rather than jieba-rs,
    // this is the assertion that has to change" — and what it caught was a
    // different answer to the same question: jieba-rs, with its dictionary
    // shipped as an asset rather than compiled in, because the crate's
    // `default-dict` feature cannot link for wasm (see
    // `scripts/setup-jieba-dict.sh`).
    //
    // Both frontends, because the choice of Chinese *script* is the frontend's
    // business and not the dictionary's: v1.0 and v1.1-zh read the same words.
    // Phase 9E added the two grammars to both.
    assert_eq!(declared("kokoro-v1", "zh-CN").required(), ZH_REQUIRED);
    assert_eq!(declared("kokoro-v11-zh", "zh-CN").required(), ZH_REQUIRED);
}

#[test]
fn the_frontend_decides_which_languages_are_speakable() {
    // v1.1-zh has no Japanese frontend.
    let error = DictionaryRegistry::new()
        .declare_required("kokoro-v11-zh", "ja-JP")
        .expect_err("v1.1-zh cannot speak Japanese");

    assert_eq!(
        error,
        DictionaryError::UnsupportedLanguage {
            vocab: "kokoro-v11-zh".to_string(),
            lang: "ja-JP".to_string(),
        }
    );
}

#[test]
fn an_unknown_frontend_is_an_error_rather_than_an_empty_list() {
    // The plan's version of this function had a `_ => {}` arm, which turns a
    // typo into "needs nothing, loads nothing, fails later for no visible
    // reason".
    let error = DictionaryRegistry::new()
        .declare_required("kokoro-v2", "en-US")
        .expect_err("kokoro-v2 is not a frontend");

    assert_eq!(
        error,
        DictionaryError::UnknownVocab {
            vocab: "kokoro-v2".to_string(),
        }
    );
}

#[test]
fn the_language_tag_is_reduced_to_its_primary_subtag() {
    assert_eq!(primary_language("ja-JP"), "ja");
    assert_eq!(primary_language("JA"), "ja");
    assert_eq!(primary_language("zh-Hant-TW"), "zh");
    assert_eq!(primary_language("zh_CN"), "zh");
    assert_eq!(primary_language("en"), "en");
    assert_eq!(primary_language(""), "");
}

#[test]
fn a_dictionary_is_decompressed_on_load() {
    let mut registry = declared("kokoro-v1", "ja-JP");

    registry
        .load(IPADIC, &fixture_bytes("test-dict.json.zst"))
        .unwrap();
    load_fixture(&mut registry, &WETEXT_JA);

    // The assertion that matters: what came back is the plaintext the reference
    // `zstd` CLI compressed, byte for byte. A `load` that stored the compressed
    // bytes would pass `finish` and fail here.
    assert_eq!(
        registry.get(IPADIC).unwrap(),
        fixture_bytes("test-dict.json").as_slice()
    );
}

#[test]
fn loading_a_dictionary_nobody_asked_for_is_an_error() {
    let mut registry = declared("kokoro-v1", "ja-JP");

    let error = registry
        .load("lindera-unidic-ja", &fixture_bytes("test-dict.json.zst"))
        .expect_err("unidic was never declared");

    // The message has to name what *was* declared, or the caller cannot tell a
    // typo from a version skew.
    assert_eq!(
        error,
        DictionaryError::UnknownDictionary {
            name: "lindera-unidic-ja".to_string(),
            declared: JA_REQUIRED.iter().map(|name| (*name).to_string()).collect(),
        }
    );
}

#[test]
fn bytes_that_are_not_a_zstd_frame_are_rejected_by_the_magic_number() {
    let mut registry = declared("kokoro-v1", "ja-JP");

    // A gzip file where a zstd one belongs — the mistake a build script makes.
    let error = registry
        .load(IPADIC, &[0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00])
        .expect_err("gzip is not zstd");

    assert_eq!(
        error,
        DictionaryError::NotZstd {
            name: IPADIC.to_string(),
            leading: vec![0x1f, 0x8b, 0x08, 0x00],
        }
    );
    // The message carries the bytes, because "not zstd" alone does not say
    // whether the file was gzip, plain text or a redirect page.
    assert!(error.to_string().contains("1f 8b 08 00"), "{error}");
}

#[test]
fn an_empty_dictionary_is_rejected_rather_than_panicking() {
    let mut registry = declared("kokoro-v1", "ja-JP");

    // A zero-byte file is what a truncated fetch or a botched build leaves
    // behind, and slicing the first four bytes would panic on it.
    let error = registry.load(IPADIC, &[]).expect_err("empty is not zstd");

    assert_eq!(
        error,
        DictionaryError::NotZstd {
            name: IPADIC.to_string(),
            leading: vec![],
        }
    );
}

#[test]
fn a_frame_that_cannot_be_decoded_is_reported_as_a_decompression_failure() {
    let mut registry = declared("kokoro-v1", "ja-JP");

    // A real magic number, then noise: the header parses far enough to be
    // recognisably zstd and then does not survive decoding. This is the shape of
    // a file corrupted after it was compressed.
    let mut corrupt = vec![0x28, 0xB5, 0x2F, 0xFD];
    corrupt.extend_from_slice(&[0xff; 32]);

    let error = registry
        .load(IPADIC, &corrupt)
        .expect_err("noise is not a frame");

    assert!(
        matches!(error, DictionaryError::Decompress { ref name, .. } if name == IPADIC),
        "{error:?}"
    );
}

#[test]
fn finishing_before_every_dictionary_arrived_names_the_missing_ones() {
    let registry = declared("kokoro-v1", "ja-JP");

    let error = registry.finish().expect_err("nothing was loaded");

    assert_eq!(
        error,
        DictionaryError::Missing {
            names: JA_REQUIRED.iter().map(|name| (*name).to_string()).collect(),
        }
    );
    assert!(error.to_string().contains(IPADIC), "{error}");
}

#[test]
fn feeding_the_same_dictionary_twice_keeps_the_first_copy() {
    let mut registry = declared("kokoro-v1", "ja-JP");
    registry
        .load(IPADIC, &fixture_bytes("test-dict.json.zst"))
        .unwrap();

    // The second feed is garbage, and has to be *ignored* rather than decoded:
    // `prepare` runs again every time the user switches voices, and
    // re-decompressing 45.3 MB to get the same bytes back is the one cost this
    // protocol can avoid for free. Rejecting the garbage is what proves the
    // bytes were not decoded again.
    registry.load(IPADIC, b"not a frame at all").unwrap();

    assert_eq!(
        registry.get(IPADIC).unwrap(),
        fixture_bytes("test-dict.json").as_slice()
    );
}

#[test]
fn switching_language_back_does_not_demand_the_dictionary_again() {
    let mut registry = declared("kokoro-v1", "ja-JP");
    registry
        .load(IPADIC, &fixture_bytes("test-dict.json.zst"))
        .unwrap();
    load_fixture(&mut registry, &WETEXT_JA);

    // A voice switch to English is now two more fetches rather than none, and
    // since phase 9E a switch *from* Japanese is also three. The bytes here are
    // the transport fixture: `finish` checks that everything asked for arrived,
    // and it is `Phonemizer::finish_loading` — not the registry — that parses
    // them, so any zstd frame does for this test.
    registry.declare_required("kokoro-v1", "en-US").unwrap();
    load_fixture(&mut registry, &WETEXT_EN);

    // And back. `load` is skipped by the wrapper here only if the bytes are
    // already there — which `finish` is what checks.
    registry.declare_required("kokoro-v1", "ja-JP").unwrap();
    registry.finish().unwrap();
}

#[test]
fn a_voice_switch_between_two_languages_that_need_dictionaries() {
    // The case the registry exists for: Japanese and Chinese both want bytes, and
    // the bytes arrive while the other language's request is in flight. `load` is
    // not scoped to the current declaration for that reason — see
    // `a_dictionary_stays_loadable_after_the_required_set_moved_on`.
    let mut registry = declared("kokoro-v1", "ja-JP");
    registry
        .load(IPADIC, &fixture_bytes("test-dict.json.zst"))
        .unwrap();
    load_fixture(&mut registry, &WETEXT_JA);

    // Six names, and `load` accepts all of them even though the last declaration
    // was Japanese's — which is what the test after this one pins on purpose.
    registry.declare_required("kokoro-v1", "zh-CN").unwrap();
    registry
        .load(JIEBA, &fixture_bytes("test-dict.json.zst"))
        .unwrap();
    load_fixture(&mut registry, &WETEXT_ZH);

    assert_eq!(
        registry.get(JIEBA),
        Some(fixture_bytes("test-dict.json").as_slice())
    );
}

#[test]
fn a_dictionary_stays_loadable_after_the_required_set_moved_on() {
    let mut registry = declared("kokoro-v1", "ja-JP");

    // Two `prepare` calls in flight at once — the caller has already asked about
    // Chinese by the time Japanese's bytes arrive. The bytes are still wanted,
    // so they must not be refused as unknown.
    registry.declare_required("kokoro-v1", "zh-CN").unwrap();
    registry
        .load(IPADIC, &fixture_bytes("test-dict.json.zst"))
        .expect("declared earlier, still accepted");

    // And the mirror image, so the test is about the rule and not about one
    // direction of it: Chinese's bytes arriving after the question moved back to
    // Japanese are accepted too.
    registry.declare_required("kokoro-v1", "ja-JP").unwrap();
    registry
        .load(JIEBA, &fixture_bytes("test-dict.json.zst"))
        .expect("declared earlier, still accepted");
}

#[test]
fn every_failure_has_a_stable_code_for_the_javascript_side() {
    // `lib/models/phonemize-dict.ts` switches on these, so a rename here is a
    // silent behaviour change over there. Pinned deliberately.
    let codes = [
        (
            DictionaryError::UnknownVocab {
                vocab: String::new(),
            },
            "unknown-vocab",
        ),
        (
            DictionaryError::UnsupportedLanguage {
                vocab: String::new(),
                lang: String::new(),
            },
            "unsupported-language",
        ),
        (
            DictionaryError::UnknownDictionary {
                name: String::new(),
                declared: Vec::new(),
            },
            "unknown-dictionary",
        ),
        (
            DictionaryError::NotZstd {
                name: String::new(),
                leading: Vec::new(),
            },
            "dictionary-format",
        ),
        (
            DictionaryError::Decompress {
                name: String::new(),
                detail: String::new(),
            },
            "dictionary-decompress",
        ),
        (
            DictionaryError::Missing { names: Vec::new() },
            "missing-dictionaries",
        ),
    ];

    for (error, code) in codes {
        assert_eq!(error.code(), code);
        assert!(error.to_string().starts_with(code), "{error}");
    }
}

#[test]
fn the_wasm_boundary_exposes_the_protocol() {
    // The only test that goes through `Phonemizer`, and it stays on the `Ok`
    // path: an `Err` there would build a `JsValue`, which panics off wasm.
    let mut phonemizer = Phonemizer::new();

    assert_eq!(
        phonemizer
            .required_dictionaries("kokoro-v1", "ja-JP")
            .unwrap(),
        JA_REQUIRED
    );
    assert_eq!(
        phonemizer
            .required_dictionaries("kokoro-v1", "en-US")
            .unwrap(),
        WETEXT_EN
    );
}
