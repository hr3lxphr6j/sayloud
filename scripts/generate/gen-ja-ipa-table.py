#!/usr/bin/env python3
"""Generate the Rust half of the Japanese katakana→IPA table.

The table is data, and the Rust side needs it as a `&[(&str, &str)]` with no
parser at runtime, so it is generated rather than written by hand. It was
duplicated by hand before phase 8 — once in the JavaScript phonemize chain, once
in `crates/phonemize/src/g2p/ja/table.rs` — and a 193-entry table is
exactly the kind of thing that drifts by one entry when it is copied.

The JavaScript copy is gone (phase 8 deleted that chain), so the source of truth
is now `crates/phonemize/data/ja-ipa-table.json`, which sits with the rest of the
crate's data. This script reads it and writes the Rust one;
`crates/phonemize/tests/ja_ipa_table_parity.rs` reads the JSON back and asserts
the two agree, so a one-sided edit fails there rather than in a listening test.

It used to carry `KOKORO_V1_VOCABULARY` over from a JavaScript test as well,
because the constraint that every entry only spells with characters the tokenizer
keeps is a property of *this* table: a symbol outside the vocabulary is deleted
by the tokenizer's `Replace` normalizer, which loses part of a mora and reports
nothing. Phase 5 built the real vocabulary gate (`src/vocab.rs`) from the model's
own `tokenizer.json`, so that constant was dropped: the check now uses the
authoritative set, which is a proof rather than the floor the copy was.

Usage:
    python3 scripts/generate/gen-ja-ipa-table.py [--check]

`--check` regenerates in memory and compares against the committed file without
writing anything, which is what a reviewer wants. CI does not need it — the Rust
parity test makes the same comparison on every `cargo test` — but it names the
offending file rather than a table entry.

Writes `crates/phonemize/src/g2p/ja/table.rs`.
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
SOURCE = ROOT / "crates" / "phonemize" / "data" / "ja-ipa-table.json"
OUTPUT = ROOT / "crates" / "phonemize" / "src" / "g2p" / "ja" / "table.rs"


def parse_table(source: str) -> list[tuple[str, str]]:
    """The table's entries, in file order, checked for the ways it can be wrong."""
    document = json.loads(source)
    raw = document["entries"]

    entries: list[tuple[str, str]] = []
    for index, entry in enumerate(raw):
        if not isinstance(entry, list) or len(entry) != 2:
            raise ValueError(f"entry {index} is not a two-element list: {entry!r}")
        kana, ipa = entry
        if not isinstance(kana, str) or not isinstance(ipa, str):
            raise ValueError(f"entry {index} is not a pair of strings: {entry!r}")
        entries.append((kana, ipa))

    if not entries:
        raise ValueError("parsed no entries")

    # A duplicate key in a JavaScript object literal used to be silent, with the
    # last one winning. JSON has the same hazard for a reader that builds a map:
    # emitting both would put two entries in the Rust table, and a first-match
    # lookup would then disagree with the table for that mora — a difference no
    # reviewer would see in either file.
    keys = [key for key, _ in entries]
    duplicates = sorted({key for key in keys if keys.count(key) > 1})
    if duplicates:
        raise ValueError(f"duplicate keys in the table: {duplicates}")

    # The Rust lookup reads at most two characters ahead. A longer key would
    # never be found and would silently do nothing at all.
    too_long = [key for key, _ in entries if len(key) > 2]
    if too_long:
        raise ValueError(f"table keys longer than two characters: {too_long}")

    empty = [key for key, _ in entries if key == ""]
    if empty:
        raise ValueError("the table has an empty key")

    return entries


def rust_str(value: str) -> str:
    out = ['"']
    for char in value:
        if char == "\\":
            out.append("\\\\")
        elif char == '"':
            out.append('\\"')
        elif char == "\n":
            out.append("\\n")
        elif char == "\r":
            out.append("\\r")
        elif char == "\t":
            out.append("\\t")
        elif 0x20 <= ord(char) < 0x7F:
            out.append(char)
        else:
            out.append(f"\\u{{{ord(char):04x}}}")
    out.append('"')
    return "".join(out)


HEADER = '''//! The Japanese katakana→IPA table, generated from the crate's data file.
//!
//! **Do not edit by hand.** Regenerate with:
//!
//! ```text
//! python3 scripts/generate/gen-ja-ipa-table.py
//! ```
//!
//! Source of truth: `crates/phonemize/data/ja-ipa-table.json`.
//! `crates/phonemize/tests/ja_ipa_table_parity.rs` reads that file back and
//! asserts the two tables still agree, so an edit on one side alone fails there.

/// One mora (or palatalized/foreign two-mora pair) and the phonemes it spells.
///
/// Lookup is longest-match-first, exactly as the JavaScript loop was: a two
/// character key wins over the first character's own entry, which is what makes
/// キャ `kja` rather than `ki` + `ja`.
pub const KATAKANA_TO_IPA: &[(&str, &str)] = &[
'''


def render(table: list[tuple[str, str]]) -> str:
    lines = [HEADER]
    for key, value in table:
        lines.append(f"    ({rust_str(key)}, {rust_str(value)}),\n")
    lines.append("];\n")
    return "".join(lines)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare instead of writing; exits non-zero when the file is stale",
    )
    args = parser.parse_args()

    table = parse_table(SOURCE.read_text())
    rendered = render(table)
    relative = OUTPUT.relative_to(ROOT)

    if args.check:
        committed = OUTPUT.read_text() if OUTPUT.exists() else None
        if committed == rendered:
            print(f"{relative} is up to date ({len(table)} entries)")
            return 0
        print(f"{relative} is stale; run without --check", file=sys.stderr)
        return 1

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text(rendered)

    two_char = sum(1 for key, _ in table if len(key) == 2)
    print(f"wrote {relative}: {len(table)} entries ({two_char} two-character)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
