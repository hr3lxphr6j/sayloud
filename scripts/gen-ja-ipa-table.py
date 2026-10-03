#!/usr/bin/env python3
"""Generate the Rust half of the Japanese katakana→IPA table.

The table exists twice — once in `lib/models/phonemize/japanese.ts`, where the JS
pipeline still uses it, and once in `crates/phonemize/src/frontends/ja_ipa_table.rs`
for the Rust pipeline. Parity between the two is the whole point of P6, and a
193-entry table is exactly the kind of thing that drifts by one entry when it is
copied by hand.

So it is not copied by hand. This script reads the TypeScript table and writes
the Rust one, and a TypeScript test (`tests/unit/models/phonemize/ja-table-parity.test.ts`)
reads the generated Rust back and asserts the two agree — a one-sided edit fails
there rather than in a listening test.

It also carries over `KOKORO_VOCABULARY` from the JS test, because the constraint
that every entry only spells with characters the tokenizer keeps is a property of
*this* table: a symbol outside the vocabulary is deleted by the tokenizer's
`Replace` normalizer, which loses part of a mora and reports nothing.

Usage:
    python3 scripts/gen-ja-ipa-table.py

Writes `crates/phonemize/src/frontends/ja_ipa_table.rs`.
"""

from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TS_SOURCE = ROOT / "lib" / "models" / "phonemize" / "japanese.ts"
TS_TEST = ROOT / "tests" / "unit" / "models" / "phonemize" / "japanese.test.ts"
OUTPUT = ROOT / "crates" / "phonemize" / "src" / "frontends" / "ja_ipa_table.rs"


def extract_block(text: str, start_marker: str) -> str:
    """The body of the `{ ... }` literal that follows `start_marker`."""
    start = text.index(start_marker)
    open_brace = text.index("{", start)
    depth = 0
    for index in range(open_brace, len(text)):
        if text[index] == "{":
            depth += 1
        elif text[index] == "}":
            depth -= 1
            if depth == 0:
                return text[open_brace + 1 : index]
    raise ValueError(f"unbalanced braces after {start_marker!r}")


ENTRY = re.compile(
    r"""^\s*
    (?:"(?P<dq>[^"]+)"|'(?P<sq>[^']+)'|(?P<bare>[^\s:'"]+))
    \s*:\s*
    (?:"(?P<vdq>[^"]*)"|'(?P<vsq>[^']*)')
    \s*,?\s*$""",
    re.VERBOSE,
)


def parse_table(body: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for line in body.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("//"):
            continue
        match = ENTRY.match(line)
        if match is None:
            raise ValueError(f"could not parse table entry: {line!r}")
        key = match["dq"] or match["sq"] or match["bare"]
        value = match["vdq"] if match["vdq"] is not None else match["vsq"]
        entries.append((key, value))
    if not entries:
        raise ValueError("parsed no entries")

    # A duplicate key in a JavaScript object literal is not an error: the last
    # one wins, silently. Emitting both would put two entries in the Rust table,
    # and a first-match lookup would then disagree with the JavaScript for that
    # mora — a difference no reviewer would see in either file.
    keys = [key for key, _ in entries]
    duplicates = sorted({key for key in keys if keys.count(key) > 1})
    if duplicates:
        raise ValueError(f"duplicate keys in the TypeScript table: {duplicates}")

    # The Rust lookup reads at most two characters ahead, matching the
    # JavaScript loop. A longer key would never be found and would silently do
    # nothing at all.
    too_long = [key for key, _ in entries if len(key) > 2]
    if too_long:
        raise ValueError(f"table keys longer than two characters: {too_long}")

    return entries


def extract_vocabulary(test_source: str) -> str:
    start = test_source.index("const KOKORO_VOCABULARY = new Set([")
    rest = test_source[start:]
    quote = rest.index("...'")
    end = rest.index("'", quote + 4)
    return rest[quote + 4 : end]


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


HEADER = '''//! The Japanese katakana→IPA table, generated from the TypeScript original.
//!
//! **Do not edit by hand.** Regenerate with:
//!
//! ```text
//! python3 scripts/gen-ja-ipa-table.py
//! ```
//!
//! Source of truth: `KATAKANA_TO_IPA` in `lib/models/phonemize/japanese.ts`.
//! `tests/unit/models/phonemize/ja-table-parity.test.ts` reads this file back and
//! asserts the two tables still agree, so an edit on one side alone fails there.

/// One mora (or palatalized/foreign two-mora pair) and the phonemes it spells.
///
/// Lookup is longest-match-first, exactly as the JavaScript loop is: a two
/// character key wins over the first character's own entry, which is what makes
/// キャ `kja` rather than `ki` + `ja`.
pub const KATAKANA_TO_IPA: &[(&str, &str)] = &[
'''

VOCAB_HEADER = '''
/// Every character Kokoro v1.0's tokenizer accepts, copied from the model's own
/// `tokenizer.json`.
///
/// It is here, next to the table, because the constraint it exists for is a
/// property of the pair: the tokenizer's normalizer is a `Replace` with an empty
/// string, so a character outside this set is **deleted**, not approximated.
/// A table entry using one therefore loses part of a mora and reports nothing.
/// `every_table_entry_only_spells_with_characters_kokoro_has` is the check.
///
/// Phase 5's vocabulary gate will own this set for real; it is duplicated from
/// the JavaScript test for now so the table can be checked before that exists.
pub const KOKORO_V1_VOCABULARY: &str = '''


def main() -> int:
    table = parse_table(extract_block(TS_SOURCE.read_text(), "export const KATAKANA_TO_IPA"))
    vocabulary = extract_vocabulary(TS_TEST.read_text())

    lines = [HEADER]
    for key, value in table:
        lines.append(f"    ({rust_str(key)}, {rust_str(value)}),\n")
    lines.append("];\n")
    lines.append(VOCAB_HEADER)
    lines.append(rust_str(vocabulary))
    lines.append(";\n")

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_text("".join(lines))

    two_char = sum(1 for key, _ in table if len(key) == 2)
    print(
        f"wrote {OUTPUT.relative_to(ROOT)}: {len(table)} entries "
        f"({two_char} two-character), vocabulary {len(set(vocabulary))} distinct chars"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
