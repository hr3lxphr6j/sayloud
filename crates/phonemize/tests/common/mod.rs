//! Shared setup for the tests that need the real dictionaries.
//!
//! The assets are built by `scripts/setup-lindera-dict.sh`,
//! `scripts/setup-jieba-dict.sh` and `scripts/setup-wetext-fsts.sh`, which `pnpm
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
    WETEXT_JA_TN_VERBALIZER, WETEXT_ZH_TN_TAGGER, WETEXT_ZH_TN_VERBALIZER,
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
/// list — and `tn_names` are the two text-normalization grammars it shares a
/// shape with the other two languages. All of them, because
/// `required_dictionaries` lists all of them and `finish` refuses a partial load.
fn prepared<const N: usize>(
    lang: &str,
    language_assets: [(&str, Vec<u8>); N],
    tn_names: [&'static str; 2],
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

/// The two English text-normalization grammars, by the registry's names.
pub const WETEXT_EN_NAMES: [&str; 2] = [WETEXT_EN_TN_TAGGER, WETEXT_EN_TN_VERBALIZER];

/// The two Chinese ones.
pub const WETEXT_ZH_NAMES: [&str; 2] = [WETEXT_ZH_TN_TAGGER, WETEXT_ZH_TN_VERBALIZER];

/// The two Japanese ones.
pub const WETEXT_JA_NAMES: [&str; 2] = [WETEXT_JA_TN_TAGGER, WETEXT_JA_TN_VERBALIZER];

/// Where one grammar lives.
pub fn wetext_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join(format!("../../public/dictionaries/{name}.bin.zst"))
}

/// The compressed bytes of one language's two grammars, tagger first.
///
/// Both or neither: a tagger with no verbalizer can only fail, so a missing half
/// is the same failure as a missing whole.
pub fn wetext_compressed(names: [&str; 2]) -> Option<Vec<(String, Vec<u8>)>> {
    let mut out = Vec::new();
    for name in names {
        out.push((
            name.to_string(),
            asset(&wetext_path(name), "./scripts/setup-wetext-fsts.sh")?,
        ));
    }
    Some(out)
}

/// One language's two grammars, **decompressed**: tagger, then verbalizer.
///
/// The registry unpacks inside the wasm, and the wrapper that hands it the bytes
/// only ever passes them along. These tests want the FSTs themselves — to feed
/// the normalizer directly and assert on the words it produces rather than on
/// the phonemes those words become.
///
/// `ruzstd` rather than a call into the crate: the decompressor is private, and
/// a test that reached it would be testing the transport it is trying to get
/// past.
pub fn wetext_fsts(names: [&str; 2]) -> Option<(Vec<u8>, Vec<u8>)> {
    let decompress = |compressed: &[u8]| -> Vec<u8> {
        let mut decoder =
            ruzstd::decoding::StreamingDecoder::new(compressed).expect("the asset is a zstd frame");
        let mut raw = Vec::new();
        decoder
            .read_to_end(&mut raw)
            .expect("the frame decompresses");
        raw
    };

    let mut fsts = wetext_compressed(names)?
        .into_iter()
        .map(|(_, bytes)| decompress(&bytes));
    let tagger = fsts.next().expect("both grammars are in the list");
    let verbalizer = fsts.next().expect("both grammars are in the list");
    Some((tagger, verbalizer))
}

/// The text normalizer one language's shipped grammars build.
///
/// What the pipelines get from `finish_loading`, for the tests that want to drive
/// a pipeline directly rather than through [`Phonemizer`] — `zh_pipeline.rs` and
/// `ja_pipeline.rs` both do, to compare against the JavaScript corpora.
fn normalizer(
    names: [&str; 2],
    build: fn(&[u8], &[u8]) -> Result<Normalizer, WeTextError>,
) -> Option<Normalizer> {
    let (tagger, verbalizer) = wetext_fsts(names)?;
    Some(build(&tagger, &verbalizer).expect("the grammars parse"))
}

/// The Chinese text normalizer.
pub fn chinese_tn() -> Option<Normalizer> {
    normalizer(WETEXT_ZH_NAMES, tn::chinese)
}

/// The Japanese text normalizer.
pub fn japanese_tn() -> Option<Normalizer> {
    normalizer(WETEXT_JA_NAMES, tn::japanese)
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
