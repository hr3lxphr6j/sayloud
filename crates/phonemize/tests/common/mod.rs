//! Shared setup for the tests that need the real dictionaries.
//!
//! The assets are built by `scripts/setup-lindera-dict.sh` and
//! `scripts/setup-jieba-dict.sh`, which `pnpm install` runs, and they are not
//! committed: megabytes of regenerable dictionary in git is not worth it, and
//! the same choice was already made for the kuromoji dictionaries.
//!
//! **Missing is a failure, not a skip.** These tests are the only thing that
//! verifies the Japanese and Chinese pipelines, and a test that passes because
//! its input was absent is the false green this project keeps rediscovering —
//! the `kubectl exec` that exited 0 on an empty stdin, the mutation harness whose
//! `str.replace` matched nothing. So the default is to fail with the command that
//! fixes it, and skipping is something you have to ask for by name
//! (`PHONEMIZE_SKIP_DICT_TESTS=1`), which also prints what it skipped.

#![allow(dead_code)]

use std::fs;
use std::path::PathBuf;

use phonemize::dictionary::{IPADIC_JA, JIEBA_ZH};
use phonemize::{PhonemizeOptions, Phonemizer};

/// Where the Japanese dictionary asset lives, from this crate rather than the
/// cwd — `cargo test` runs with the package directory as the working directory.
pub fn dictionary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../public/dictionaries/lindera-ipadic-ja.bin.zst")
}

/// Where the Chinese dictionary asset lives.
pub fn jieba_dictionary_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../public/dictionaries/jieba-zh-dict.bin.zst")
}

/// Whether the caller has explicitly accepted not testing the pipelines.
fn skipping_is_allowed() -> bool {
    std::env::var("PHONEMIZE_SKIP_DICT_TESTS").is_ok_and(|value| value == "1")
}

/// Read one dictionary asset, or explain how to build it.
fn asset(path: &PathBuf, script: &str) -> Option<Vec<u8>> {
    match fs::read(path) {
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
             Run {script} to build it, or set \
             PHONEMIZE_SKIP_DICT_TESTS=1 to skip the pipeline tests.",
            path.display()
        ),
    }
}

/// The compressed Japanese dictionary.
///
/// Panics when it is missing and skipping was not asked for; returns `None` only
/// when it was.
pub fn dictionary_bytes() -> Option<Vec<u8>> {
    asset(&dictionary_path(), "./scripts/setup-lindera-dict.sh")
}

/// The compressed Chinese dictionary, under the same rule.
pub fn jieba_dictionary_bytes() -> Option<Vec<u8>> {
    asset(&jieba_dictionary_path(), "./scripts/setup-jieba-dict.sh")
}

/// A phonemizer that has been through the whole `prepare` flow for Japanese.
///
/// Deliberately the production path — `required_dictionaries`, `load_dictionary`,
/// `finish_loading` — rather than calling the segmenter directly, so these tests
/// cover the protocol and the pipeline's use of it at the same time.
pub fn japanese_phonemizer() -> Option<Phonemizer> {
    prepare(dictionary_bytes()?, "ja-JP", IPADIC_JA)
}

/// A phonemizer that has been through the whole `prepare` flow for Chinese.
pub fn chinese_phonemizer() -> Option<Phonemizer> {
    prepare(jieba_dictionary_bytes()?, "zh-CN", JIEBA_ZH)
}

/// The `prepare` flow, once the bytes are in hand.
fn prepare(compressed: Vec<u8>, lang: &str, name: &str) -> Option<Phonemizer> {
    let mut phonemizer = Phonemizer::new();
    phonemizer
        .required_dictionaries("kokoro-v1", lang)
        .unwrap_or_else(|_| panic!("kokoro-v1 speaks {lang}"));
    phonemizer
        .load_dictionary(name, &compressed)
        .unwrap_or_else(|_| panic!("{name} loads"));
    phonemizer
        .finish_loading()
        .unwrap_or_else(|_| panic!("{name} is complete"));

    Some(phonemizer)
}

/// Options for the v1.0 Japanese frontend.
pub fn japanese_options() -> PhonemizeOptions {
    PhonemizeOptions {
        frontend: "kokoro-v1".to_string(),
        lang: "ja-JP".to_string(),
    }
}

/// Options for the v1.0 Chinese frontend.
pub fn chinese_options() -> PhonemizeOptions {
    PhonemizeOptions {
        frontend: "kokoro-v1".to_string(),
        lang: "zh-CN".to_string(),
    }
}
