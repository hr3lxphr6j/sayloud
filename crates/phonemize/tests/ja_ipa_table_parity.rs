//! The katakana→IPA table, against the data file it is generated from.
//!
//! `KATAKANA_TO_IPA` is generated: `scripts/generate/gen-ja-ipa-table.py` writes it from
//! `crates/phonemize/data/ja-ipa-table.json`. This test is what says so, and it
//! is the only thing that would notice a hand edit of either side — the table has
//! no other reader, and `cargo test` does not run the generator. (The generator
//! has a `--check` mode for a reviewer; CI does not need it, because this runs on
//! every `cargo test`.)
//!
//! It replaces the TypeScript half of the check,
//! `tests/unit/models/phonemize/ja-table-parity.test.ts`, which compared this
//! same table against `lib/models/phonemize/japanese.ts` and was deleted with the
//! JavaScript chain in phase 8. The comparison is the same one in the same
//! direction, against the file that is now the source of truth instead of the
//! file that used to be.
//!
//! Order is compared position by position, not as a set: the table is a slice and
//! the lookup is longest-match-first, so a reordering is a behaviour change.

use std::path::PathBuf;

use phonemize::g2p::ja::KATAKANA_TO_IPA;
use serde::Deserialize;

#[derive(Debug, Deserialize)]
struct Table {
    entries: Vec<(String, String)>,
}

/// The data file, as written by hand or by `gen-ja-ipa-table.py`'s author.
fn data_file() -> Vec<(String, String)> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("data")
        .join("ja-ipa-table.json");
    let source = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{} should be readable: {error}", path.display()));
    let table: Table = serde_json::from_str(&source)
        .unwrap_or_else(|error| panic!("{} should parse: {error}", path.display()));
    table.entries
}

#[test]
fn the_compiled_table_is_the_data_file() {
    let from_file = data_file();

    // A file that parsed to nothing would make the comparison below trivially
    // pass on two empty lists, which is the failure this test exists to prevent.
    assert!(
        from_file.len() > 100,
        "the data file should hold the whole table, not {} entries",
        from_file.len()
    );
    assert_eq!(
        from_file.len(),
        KATAKANA_TO_IPA.len(),
        "the data file and the compiled table should have the same number of entries"
    );

    // Compared entry by entry so a failure names the mora that differs rather
    // than printing 193 pairs.
    let differences: Vec<String> = from_file
        .iter()
        .zip(KATAKANA_TO_IPA)
        .enumerate()
        .filter(|(_, (from_file, from_table))| {
            from_file.0.as_str() != from_table.0 || from_file.1.as_str() != from_table.1
        })
        .map(|(index, (from_file, from_table))| {
            format!(
                "entry {index}: the data file has {} → {}, the compiled table has {} → {}",
                from_file.0, from_file.1, from_table.0, from_table.1
            )
        })
        .collect();

    assert_eq!(differences, Vec::<String>::new());
}
