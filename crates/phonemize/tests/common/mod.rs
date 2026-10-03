//! Shared setup for the tests that need the real IPADic dictionary.
//!
//! The asset is built by `scripts/setup-lindera-dict.sh`, which `pnpm install`
//! runs, and it is not committed: 8.5 MB of regenerable dictionary in git is not
//! worth it, and the same choice was already made for the kuromoji dictionaries.
//!
//! **Missing is a failure, not a skip.** These tests are the only thing that
//! verifies the Japanese pipeline, and a test that passes because its input was
//! absent is the false green this project keeps rediscovering — the `kubectl
//! exec` that exited 0 on an empty stdin, the mutation harness whose `str.replace`
//! matched nothing. So the default is to fail with the command that fixes it, and
//! skipping is something you have to ask for by name
//! (`PHONEMIZE_SKIP_DICT_TESTS=1`), which also prints what it skipped.

#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use phonemize::dictionary::IPADIC_JA;
use phonemize::{PhonemizeOptions, Phonemizer};

/// Where the dictionary asset lives, from this crate rather than the cwd —
/// `cargo test` runs with the package directory as the working directory.
pub fn dictionary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../public/dictionaries/lindera-ipadic-ja.bin.zst")
}

/// Whether the caller has explicitly accepted not testing the Japanese pipeline.
fn skipping_is_allowed() -> bool {
    std::env::var("PHONEMIZE_SKIP_DICT_TESTS").is_ok_and(|value| value == "1")
}

/// The compressed dictionary.
///
/// Panics when it is missing and skipping was not asked for; returns `None` only
/// when it was.
pub fn dictionary_bytes() -> Option<Vec<u8>> {
    let path = dictionary_path();
    match fs::read(&path) {
        Ok(bytes) => Some(bytes),
        Err(error) if skipping_is_allowed() => {
            eprintln!(
                "SKIPPING: no dictionary at {} ({error}), and PHONEMIZE_SKIP_DICT_TESTS=1",
                path.display()
            );
            None
        }
        Err(error) => panic!(
            "no dictionary at {} ({error}).\n\
             Run ./scripts/setup-lindera-dict.sh to build it, or set \
             PHONEMIZE_SKIP_DICT_TESTS=1 to skip the Japanese pipeline tests.",
            path.display()
        ),
    }
}

/// A phonemizer that has been through the whole `prepare` flow for Japanese.
///
/// Deliberately the production path — `required_dictionaries`, `load_dictionary`,
/// `finish_loading` — rather than calling the segmenter directly, so these tests
/// cover the protocol and the pipeline's use of it at the same time.
pub fn japanese_phonemizer() -> Option<Phonemizer> {
    let compressed = dictionary_bytes()?;

    let mut phonemizer = Phonemizer::new();
    phonemizer
        .required_dictionaries("kokoro-v1", "ja-JP")
        .expect("kokoro-v1 speaks ja");
    phonemizer
        .load_dictionary(IPADIC_JA, &compressed)
        .expect("the dictionary loads");
    phonemizer
        .finish_loading()
        .expect("the dictionary is complete");

    Some(phonemizer)
}

/// Options for the v1.0 Japanese frontend.
pub fn japanese_options() -> PhonemizeOptions {
    PhonemizeOptions {
        frontend: "kokoro-v1".to_string(),
        lang: "ja-JP".to_string(),
    }
}
