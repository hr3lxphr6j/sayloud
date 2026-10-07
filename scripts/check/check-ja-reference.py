#!/usr/bin/env python3
"""Regenerate / check the Japanese reference corpus.

The Japanese pipeline has two halves, and this script is the reference for the
first one — **the reading**:

    input --(punctuation map, text normalizer)--> dictionary input
          --(OpenJTalk)--> katakana
          --(our M2P table)--> IPA

`pyopenjtalk` is the reference for the dictionary step because it is the
OpenJTalk chain: the same pronunciation field (`pron`) the first-generation
misaki used when Kokoro's Japanese voices were trained. IPADic, which this crate
loads through lindera, is a NAIST-lineage dictionary like OpenJTalk's own, so the
two agree on the reading — and this script is what would notice if they stopped.

The renderer half (`kana_to_ipa` plus the script-run split and the punctuation
filter) is the crate's own, reproduced here from `data/ja-ipa-table.json` so the
expected phonemes can be computed without building the wasm. That reproduction is
deliberately literal: it mirrors `pipeline.rs::phonemize_ja`, `ipa.rs::kana_to_ipa`
and `text.rs::segment_text`.

**OpenJTalk's text normalization is not ours.** It rewrites ASCII punctuation to
full-width — a `, ` we hand it comes back as `，　` (U+FF0C U+3000) — so its
reading is mapped back to the ASCII this crate's punctuation map produces before
it is recorded. The dictionary is the reference here, not the punctuation layer:
ours is the one that has to hand the tokenizer characters it keeps.

Requires : pip install pyopenjtalk

Usage:
    python3 scripts/check/check-ja-reference.py            # check the fixture
    python3 scripts/check/check-ja-reference.py --write     # regenerate it
"""

from __future__ import annotations

import argparse
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent
FIXTURE = ROOT / "crates" / "phonemize" / "tests" / "fixtures" / "ja-reference.json"
TABLE = ROOT / "crates" / "phonemize" / "data" / "ja-ipa-table.json"

# `text.rs`'s KOKORO_PUNCTUATION: what survives out of an `other` run.
KOKORO_PUNCTUATION = set(' $;:,.!?—…"()“”')

# `ipa.rs`'s NUMERAL_SOUND_CHANGES, in order.
NUMERAL_SOUND_CHANGES = [
    ("サンヒャク", "サンビャク"),
    ("ロクヒャク", "ロッピャク"),
    ("ハチヒャク", "ハッピャク"),
    ("サンセン", "サンゼン"),
    ("ハチセン", "ハッセン"),
]

# OpenJTalk's NFE output, back in the alphabet our punctuation map produces.
# `，`/`　` are what it makes of the `, ` we hand it, `．`/`”` of our `.`/`"`;
# `、`/`。` come back as themselves when the source already had them. The map
# lives here rather than in `reference_reading` so that the fixture's `kana`
# column is exactly what pyopenjtalk prints — the translation to our alphabet is
# this crate's renderer's business, not the reference's.
OPENJTALK_TEXT_NORMALIZATION = {
    "，": ",",
    "、": ",",
    "。": ".",
    "．": ".",
    "　": " ",
    "！": "!",
    "？": "?",
    "“": '"',
    "”": '"',
}

# `text.rs`'s is_js_whitespace, near enough for a reading: the two differ only on
# characters no reading contains.
WHITESPACE = set(
    "\t\n\x0b\x0c\r \u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008"
    "\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
)


def load_table() -> dict[tuple[str, str | None], str]:
    """The katakana table, keyed the way `kana_to_ipa` looks it up."""
    entries = json.loads(TABLE.read_text())["entries"]
    return {
        (kana[0], kana[1] if len(kana) > 1 else None): ipa for kana, ipa in entries
    }


def kana_to_ipa(kana: str, table: dict[tuple[str, str | None], str]) -> str:
    """`ipa.rs::kana_to_ipa`: longest match first, unknown characters passed on."""
    out: list[str] = []
    index = 0
    while index < len(kana):
        pair = table.get((kana[index], kana[index + 1] if index + 1 < len(kana) else None))
        if pair is not None:
            out.append(pair)
            index += 2
            continue
        out.append(table.get((kana[index], None), kana[index]))
        index += 1
    return "".join(out)


def script_run(character: str) -> str:
    """`text.rs::classify`, as one of `kana` / `latin` / `other`.

    `han` is folded into `kana` on purpose: both take the same route through
    `phonemize_ja`, and after the dictionary step a han character means an unknown
    word leaked through, which is exactly what this script should show.
    """
    code = ord(character)
    if 0x3040 <= code <= 0x309F or 0x30A0 <= code <= 0x30FF or 0x31F0 <= code <= 0x31FF:
        return "kana"
    if 0x4E00 <= code <= 0x9FFF or 0x3400 <= code <= 0x4DBF:
        return "kana"
    if 65 <= code <= 90 or 97 <= code <= 122:
        return "latin"
    return "other"


def runs(text: str) -> list[tuple[str, str]]:
    """`text.rs::segment_text`, as (kind, text) pairs."""
    grouped: list[tuple[str, str]] = []
    for character in text:
        kind = script_run(character)
        if grouped and grouped[-1][0] == kind:
            grouped[-1] = (kind, grouped[-1][1] + character)
        else:
            grouped.append((kind, character))
    return grouped


def collapse_whitespace(text: str) -> str:
    """`text.rs::collapse_whitespace`."""
    out: list[str] = []
    in_space = False
    for character in text:
        if character in WHITESPACE:
            in_space = True
            continue
        if in_space and out:
            out.append(" ")
        in_space = False
        out.append(character)
    return "".join(out)


def our_alphabet(kana: str) -> str:
    """OpenJTalk's reading, with its punctuation rewritten the way ours came in."""
    for full_width, ascii_ in OPENJTALK_TEXT_NORMALIZATION.items():
        kana = kana.replace(full_width, ascii_)
    return kana


def render(kana: str, table: dict[tuple[str, str | None], str]) -> str:
    """`pipeline.rs::phonemize_ja`'s rendering of a katakana reading."""
    parts: list[str] = []
    for kind, text in runs(our_alphabet(kana)):
        if kind == "kana":
            ipa = kana_to_ipa(text, table)
            for pattern, replacement in NUMERAL_SOUND_CHANGES:
                ipa = ipa.replace(pattern, replacement)
            parts.append(ipa)
        elif kind == "latin":
            # This crate's English backend, which the Japanese reference knows
            # nothing about — only the `check: skip` samples reach here.
            parts.append(text)
        else:
            parts.append("".join(c for c in text if c in KOKORO_PUNCTUATION))
    return collapse_whitespace("".join(parts))


def reference_reading(text: str) -> str:
    import pyopenjtalk

    return pyopenjtalk.g2p(text, kana=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="write the fixture back")
    arguments = parser.parse_args()

    document = json.loads(FIXTURE.read_text())
    table = load_table()
    failures: list[str] = []
    gaps: list[str] = []
    skipped = 0

    for sample in document["samples"]:
        if sample.get("check") == "skip":
            # A Latin run is read by this crate's own English backend, which the
            # Japanese reference knows nothing about; the value stays as written.
            skipped += 1
            continue

        source = sample.get("reading", sample["input"])
        reading = reference_reading(source)

        if sample["kana"] and sample["kana"] != reading:
            failures.append(
                f"{sample['input']!r}: reference gives {reading!r}, "
                f"fixture says {sample['kana']!r}"
            )

        if sample.get("gap"):
            # A sample whose reading the reference has and this dictionary does not:
            # `kana` is still checked above, `expected` is what this crate produces
            # today, and the note says what the two disagree about. A gap is meant to
            # be closed by a dictionary change, not by editing `expected` here.
            gaps.append(f"{sample['input']!r}: {sample['gap']}")
            continue

        expected = render(reading, table)

        if sample["expected"] and sample["expected"] != expected:
            failures.append(
                f"{sample['input']!r}: rendering gives {expected!r}, "
                f"fixture says {sample['expected']!r}"
            )
        if arguments.write:
            sample["kana"] = reading
            sample["expected"] = expected

    if arguments.write:
        FIXTURE.write_text(json.dumps(document, ensure_ascii=False, indent=2) + "\n")
        checked = len(document["samples"]) - skipped
        print(
            f"wrote {FIXTURE.relative_to(ROOT)}: "
            f"{checked} samples from the reference, {skipped} left alone"
        )
        return 0

    if failures:
        print(f"{len(failures)} samples differ from the reference:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1

    checked = len(document["samples"]) - skipped
    print(f"{checked} samples agree with the reference ({skipped} skipped)")
    for gap in gaps:
        print(f"  gap: {gap}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
