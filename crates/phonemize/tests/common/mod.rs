//! Shared setup for the tests that need the real dictionaries.
//!
//! The assets are built by `scripts/setup/setup-lindera-dict.sh`,
//! `scripts/setup/setup-jieba-dict.sh` and `scripts/setup/setup-wetext-fsts.sh`, which `pnpm
//! install` runs, and they are not committed: megabytes of regenerable dictionary
//! in git is not worth it, and the same choice was already made for the kuromoji
//! dictionaries.
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
use std::io::Read;
use std::path::PathBuf;

use phonemize::dictionary::{
    IPADIC_JA, JIEBA_ZH, WETEXT_EN_TN_TAGGER, WETEXT_EN_TN_VERBALIZER, WETEXT_JA_TN_TAGGER,
    WETEXT_JA_TN_VERBALIZER, WETEXT_TN_FULL_TO_HALF, WETEXT_ZH_TN_TAGGER,
    WETEXT_ZH_TN_TRADITIONAL_TO_SIMPLE, WETEXT_ZH_TN_VERBALIZER,
};
use phonemize::tn;
use phonemize::tn::wetext::{Normalizer, WeTextError};
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
    asset(&dictionary_path(), "./scripts/setup/setup-lindera-dict.sh")
}

/// The compressed Chinese dictionary, under the same rule.
pub fn jieba_dictionary_bytes() -> Option<Vec<u8>> {
    asset(
        &jieba_dictionary_path(),
        "./scripts/setup/setup-jieba-dict.sh",
    )
}

/// A phonemizer that has been through the whole `prepare` flow for Japanese.
///
/// Deliberately the production path — `required_dictionaries`, `load_dictionary`,
/// `finish_loading` — rather than calling the segmenter directly, so these tests
/// cover the protocol and the pipeline's use of it at the same time. That flow
/// includes the two text-normalization grammars, which is also the only way the
/// shipped numerals are exercised.
pub fn japanese_phonemizer() -> Option<Phonemizer> {
    prepared("ja-JP", [(IPADIC_JA, dictionary_bytes()?)], WETEXT_JA_NAMES)
}

/// A phonemizer that has been through the whole `prepare` flow for Chinese.
pub fn chinese_phonemizer() -> Option<Phonemizer> {
    prepared(
        "zh-CN",
        [(JIEBA_ZH, jieba_dictionary_bytes()?)],
        WETEXT_ZH_NAMES,
    )
}

/// A phonemizer that has been through the whole `prepare` flow for English.
///
/// That is not a no-op: English's *phonemes* still need no
/// dictionary, but its numerals go through the WeText grammars, and they arrive
/// the same way IPADic and jieba's word list do.
pub fn english_phonemizer() -> Option<Phonemizer> {
    prepared("en-US", [], WETEXT_EN_NAMES)
}

/// The `prepare` flow: declare, load everything declared, finish.
///
/// `language_assets` are the language's own dictionaries — IPADic, jieba's word
/// list — and `tn_names` are the FSTs that language declares, tagger first. All of
/// them, because `required_dictionaries` lists all of them and `finish` refuses a
/// partial load — which is what makes this helper the one place the declaration
/// and the load cannot disagree.
fn prepared<const N: usize>(
    lang: &str,
    language_assets: [(&str, Vec<u8>); N],
    tn_names: &[&str],
) -> Option<Phonemizer> {
    let mut phonemizer = Phonemizer::new();
    phonemizer
        .required_dictionaries("kokoro-v1", lang)
        .unwrap_or_else(|_| panic!("kokoro-v1 speaks {lang}"));

    for (name, compressed) in language_assets {
        phonemizer
            .load_dictionary(name, &compressed)
            .unwrap_or_else(|_| panic!("{name} loads"));
    }
    for (name, compressed) in wetext_compressed(tn_names)? {
        phonemizer
            .load_dictionary(&name, &compressed)
            .unwrap_or_else(|_| panic!("{name} loads"));
    }
    phonemizer
        .finish_loading()
        .unwrap_or_else(|_| panic!("everything {lang} asked for arrived"));

    Some(phonemizer)
}

/// The English text-normalization assets, by the registry's names.
///
/// The FSTs one language declares, in the order its builder takes them:
/// `[tagger, verbalizer, …preprocessors]`. The lists are per language rather than
/// one list because `required_dictionaries` is per language — `full_to_half` is
/// the shared one, so it appears in all three, and Chinese's
/// `traditional_to_simple` appears only in Chinese's.
pub const WETEXT_EN_NAMES: &[&str] = &[
    WETEXT_EN_TN_TAGGER,
    WETEXT_EN_TN_VERBALIZER,
    WETEXT_TN_FULL_TO_HALF,
];

/// The Chinese ones — the two grammars and the traditional-to-simplified
/// preprocessor, and no `full_to_half`: Chinese's fold is the pipeline's.
pub const WETEXT_ZH_NAMES: &[&str] = &[
    WETEXT_ZH_TN_TAGGER,
    WETEXT_ZH_TN_VERBALIZER,
    WETEXT_ZH_TN_TRADITIONAL_TO_SIMPLE,
];

/// The Japanese ones.
pub const WETEXT_JA_NAMES: &[&str] = &[
    WETEXT_JA_TN_TAGGER,
    WETEXT_JA_TN_VERBALIZER,
    WETEXT_TN_FULL_TO_HALF,
];

/// Where one grammar lives.
pub fn wetext_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../public/dictionaries/{name}.bin.zst"))
}

/// The compressed bytes of one language's assets, in the order the list gives.
///
/// All of them or none: a tagger with no verbalizer can only fail, and so can a
/// configuration whose preprocessor was never supplied — so a missing file is the
/// same failure as a missing whole.
pub fn wetext_compressed(names: &[&str]) -> Option<Vec<(String, Vec<u8>)>> {
    let mut out = Vec::new();
    for name in names {
        out.push((
            name.to_string(),
            asset(&wetext_path(name), "./scripts/setup/setup-wetext-fsts.sh")?,
        ));
    }
    Some(out)
}

/// One language's assets, **decompressed**: tagger, verbalizer, then the
/// preprocessors, in the order the list gives.
///
/// The registry unpacks inside the wasm, and the wrapper that hands it the bytes
/// only ever passes them along. These tests want the FSTs themselves — to feed
/// the normalizer directly and assert on the words it produces rather than on
/// the phonemes those words become.
///
/// `ruzstd` rather than a call into the crate: the decompressor is private, and
/// a test that reached it would be testing the transport it is trying to get
/// past.
pub fn wetext_fsts(names: &[&str]) -> Option<Vec<Vec<u8>>> {
    let decompress = |compressed: &[u8]| -> Vec<u8> {
        let mut decoder =
            ruzstd::decoding::StreamingDecoder::new(compressed).expect("the asset is a zstd frame");
        let mut raw = Vec::new();
        decoder
            .read_to_end(&mut raw)
            .expect("the frame decompresses");
        raw
    };

    Some(
        wetext_compressed(names)?
            .into_iter()
            .map(|(_, bytes)| decompress(&bytes))
            .collect(),
    )
}

/// The text normalizer one language's shipped FSTs build.
///
/// What the pipelines get from `finish_loading`, for the tests that want to drive
/// a pipeline directly rather than through [`Phonemizer`] — `zh_pipeline.rs` and
/// `ja_pipeline.rs` both do, to compare against the JavaScript corpora.
fn normalizer(
    names: &[&str],
    build: fn(&[&[u8]]) -> Result<Normalizer, WeTextError>,
) -> Option<Normalizer> {
    let fsts = wetext_fsts(names)?;
    let borrowed: Vec<&[u8]> = fsts.iter().map(|bytes| bytes.as_slice()).collect();
    Some(build(&borrowed).expect("the FSTs parse"))
}

/// The Chinese text normalizer.
pub fn chinese_tn() -> Option<Normalizer> {
    normalizer(WETEXT_ZH_NAMES, |fsts| {
        tn::chinese(fsts[0], fsts[1], fsts[2])
    })
}

/// The Japanese text normalizer.
pub fn japanese_tn() -> Option<Normalizer> {
    normalizer(WETEXT_JA_NAMES, |fsts| {
        tn::japanese(fsts[0], fsts[1], fsts[2])
    })
}

/// Options for the v1.0 Japanese frontend.
pub fn japanese_options() -> PhonemizeOptions {
    PhonemizeOptions {
        vocab: "kokoro-v1".to_string(),
        lang: "ja-JP".to_string(),
    }
}

/// Options for the v1.0 Chinese frontend.
pub fn chinese_options() -> PhonemizeOptions {
    PhonemizeOptions {
        vocab: "kokoro-v1".to_string(),
        lang: "zh-CN".to_string(),
    }
}

/// Options for the v1.0 English frontend.
pub fn english_options() -> PhonemizeOptions {
    PhonemizeOptions {
        vocab: "kokoro-v1".to_string(),
        lang: "en-US".to_string(),
    }
}
