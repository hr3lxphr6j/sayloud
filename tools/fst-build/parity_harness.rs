// Parity harness — kept here as an artifact, NOT as a live test.
//
// To use it, copy to `crates/phonemize/tests/fst_parity_tmp.rs` (a name that
// will not be picked up by anything else), then:
//
//   cargo test -p phonemize --test fst_parity_tmp -- --nocapture
//   FST_BUILT_DIR=../../tools/fst-build/out-amd64 cargo test -p phonemize --test fst_parity_tmp -- --nocapture
//
// It is not a committed test because it depends on two directories of generated
// grammars plus a corpus file, none of which belong in git; and because its
// assert (`the two asset sets agree on every case`) is the wrong shape for CI
// until Stage 1 actually owns the grammar.
//
// ---------------------------------------------------------------------------

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use phonemize::tn;
use phonemize::tn::wetext::Normalizer;

fn read(path: &Path) -> Vec<u8> {
    fs::read(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

fn build(dir: &Path, lang: &str) -> Normalizer {
    let tagger = read(&dir.join(format!("{lang}/tn/tagger.fst")));
    let verbalizer = read(&dir.join(format!("{lang}/tn/verbalizer.fst")));
    let full_to_half = read(&dir.join("full_to_half.fst"));
    let traditional_to_simple = read(&dir.join("traditional_to_simple.fst"));
    match lang {
        "en" => tn::english(&tagger, &verbalizer, &full_to_half),
        "zh" => tn::chinese(&tagger, &verbalizer, &traditional_to_simple),
        "ja" => tn::japanese(&tagger, &verbalizer, &full_to_half),
        other => panic!("unknown language {other}"),
    }
    .unwrap_or_else(|error| panic!("{lang} normalizer builds: {error}"))
}

/// `lang \t file \t line \t input \t expected`, one per line.
fn corpus(path: &Path) -> Vec<(String, String, usize, String, Option<String>)> {
    let text = fs::read_to_string(path).expect("corpus.jsonl is readable");
    text.lines()
        .filter(|line| !line.trim().is_empty())
        .map(|line| {
            let value: serde_json::Value = serde_json::from_str(line).expect("a JSON row");
            (
                value["lang"].as_str().unwrap().to_string(),
                value["file"].as_str().unwrap().to_string(),
                value["line"].as_u64().unwrap() as usize,
                value["input"].as_str().unwrap().to_string(),
                value["expected"].as_str().map(ToString::to_string),
            )
        })
        .collect()
}

#[test]
fn shipped_and_rebuilt_agree() {
    let shipped_dir = PathBuf::from(
        std::env::var("FST_SHIPPED_DIR")
            .unwrap_or_else(|_| "../../tools/fst-build/shipped".to_string()),
    );
    let built_dir = PathBuf::from(
        std::env::var("FST_BUILT_DIR").unwrap_or_else(|_| "../../tools/fst-build/out".to_string()),
    );
    let corpus_paths: Vec<PathBuf> = std::env::var("FST_CORPUS")
        .unwrap_or_else(|_| {
            "../../tools/fst-build/corpus.jsonl,../../tools/fst-build/corpus_extra.jsonl".to_string()
        })
        .split(',')
        .map(PathBuf::from)
        .collect();

    let mut cases = Vec::new();
    for path in &corpus_paths {
        cases.extend(corpus(path));
    }

    // Built once per language and directory: rebuilding per case would measure
    // the parser, not the grammar.
    let mut engines = BTreeMap::new();
    for lang in ["en", "zh", "ja"] {
        engines.insert(
            (lang, "shipped"),
            build(&shipped_dir, lang),
        );
        engines.insert((lang, "built"), build(&built_dir, lang));
    }

    let mut counts: BTreeMap<&str, (usize, usize, usize, usize)> = BTreeMap::new();
    let mut differences: Vec<String> = Vec::new();
    let mut expected_drift: Vec<String> = Vec::new();
    let mut outputs: Vec<String> = Vec::new();

    for (lang, file, line, input, expected) in &cases {
        let shipped = engines
            .get(&(lang.as_str(), "shipped"))
            .unwrap()
            .normalize(input);
        let built = engines.get(&(lang.as_str(), "built")).unwrap().normalize(input);

        let entry = counts.entry(lang.as_str()).or_insert((0, 0, 0, 0));
        match (&shipped, &built) {
            (Ok(a), Ok(b)) if a == b => entry.0 += 1,
            (Ok(a), Ok(b)) => {
                entry.1 += 1;
                differences.push(format!(
                    "{lang}\t{file}:{line}\t{input:?}\tshipped={a:?}\tbuilt={b:?}"
                ));
            }
            _ => {
                entry.2 += 1;
                differences.push(format!(
                    "{lang}\t{file}:{line}\t{input:?}\tshipped={shipped:?}\tbuilt={built:?}"
                ));
            }
        }
        entry.3 += 1;
        if file == "corpus_extra" {
            outputs.push(format!(
                "{lang}\t{input:?}\tshipped={shipped:?}\tbuilt={built:?}"
            ));
        }

        if let Some(expected) = expected {
            if let Ok(a) = &shipped {
                if a != expected && expected != input {
                    expected_drift.push(format!(
                        "{lang}\t{file}:{line}\t{input:?}\twant={expected:?}\tshipped={a:?}"
                    ));
                }
            }
        }
    }

    println!("=== per-language: same / differ / error / total ===");
    for (lang, (same, differ, error, total)) in &counts {
        println!("{lang}\t{same}\t{differ}\t{error}\t{total}");
    }

    println!("=== differences ({}) ===", differences.len());
    for row in &differences {
        println!("{row}");
    }

    println!("=== out-of-corpus (Stage 1 shapes) outputs ===");
    for row in &outputs {
        println!("{row}");
    }

    println!(
        "=== shipped output != the test's own expected value ({}) ===",
        expected_drift.len().min(5)
    );
    for row in expected_drift.iter().take(5) {
        println!("{row}");
    }

    let differing: usize = counts.values().map(|entry| entry.1 + entry.2).sum();
    assert_eq!(differing, 0, "{differing} cases disagree between the two builds");
}
