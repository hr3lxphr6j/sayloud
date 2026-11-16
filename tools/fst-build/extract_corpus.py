#!/usr/bin/env python3
"""Harvest the `("input", "expected")` tuples the Rust tests already assert on.

The parity harness must speak about the corpus the repository already trusts, and
the only honest way to do that without a second copy of it is to read it out of
the test sources. This is a throwaway extractor for the PoC stage — it is not
wired into any build.

Output: one JSON object per line, `{"file", "line", "input", "expected"}`, with
`expected` set to null for the two-tuples whose second element is a reason
(`tn_gate.rs`) rather than a reading. Rust escapes are decoded, including
`\\u{...}`.

Usage:
    python3 extract_corpus.py > corpus.jsonl
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
# Which normalizer each source's literals belong to: the two `wetext_*.rs` files
# are per language, and `tn_gate.rs` is English's (it gates English prose).
SOURCES = [
    ("en", REPO / "crates/phonemize/tests/wetext_en.rs"),
    ("zh", REPO / "crates/phonemize/tests/wetext_zh.rs"),
    ("ja", REPO / "crates/phonemize/tests/wetext_ja.rs"),
    ("en", REPO / "crates/phonemize/tests/tn_gate.rs"),
]

# A tuple whose first element is a string literal. The second element is either a
# reading or a reason; both are string literals, and the harness only needs the
# first, so the second is captured but may be `None` for shapes that do not have
# one.
TUPLE = re.compile(
    r'\(\s*"((?:[^"\\]|\\.)*)"\s*,\s*(?:"((?:[^"\\]|\\.)*)")?',
    re.S,
)

UNICODE_BRACE = re.compile(r"\\u\{([0-9A-Fa-f]+)\}")
SIMPLE_ESCAPES = {
    "n": "\n",
    "t": "\t",
    "r": "\r",
    "0": "\0",
    "\\": "\\",
    '"': '"',
    "'": "'",
}


def decode(raw: str) -> str:
    """Decode a Rust string literal body (without its quotes)."""
    out = []
    i = 0
    while i < len(raw):
        char = raw[i]
        if char != "\\":
            out.append(char)
            i += 1
            continue
        nxt = raw[i + 1]
        if nxt == "u":
            match = UNICODE_BRACE.match(raw, i)
            if not match:
                raise ValueError(f"bad \\u escape in {raw!r}")
            out.append(chr(int(match.group(1), 16)))
            i = match.end()
        elif nxt == "x":
            out.append(chr(int(raw[i + 2 : i + 4], 16)))
            i += 4
        else:
            out.append(SIMPLE_ESCAPES[nxt])
            i += 2
    return "".join(out)


def main() -> int:
    seen: set[tuple[str, str]] = set()
    rows = []
    for lang, path in SOURCES:
        text = path.read_text(encoding="utf-8")
        for match in TUPLE.finditer(text):
            value = decode(match.group(1))
            if not value or (lang, value) in seen:
                continue
            seen.add((lang, value))
            line = text.count("\n", 0, match.start()) + 1
            expected = decode(match.group(2)) if match.group(2) is not None else None
            rows.append(
                {
                    "lang": lang,
                    "file": path.name,
                    "line": line,
                    "input": value,
                    "expected": expected,
                }
            )
    for row in rows:
        print(json.dumps(row, ensure_ascii=False))
    print(f"{len(rows)} inputs from {len(SOURCES)} files", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
