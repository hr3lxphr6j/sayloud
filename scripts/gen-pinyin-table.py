#!/usr/bin/env python3
"""Regenerate `lib/models/phonemize/pinyin-table.json`.

The Chinese half of the on-device phonemizer is a lookup table: one pinyin
syllable in, one IPA template out, with `0` where the tone goes. The runtime
never derives a syllable's IPA — it reads this file — so the table has to be
generated from the real algorithm rather than hand-written. Hand-writing the
initial/final split is exactly the mistake this avoids: pypinyin's
`to_finals(strict=True)` does a lot of normalisation (`iu` -> `iou`,
`ui` -> `uei`, `un` -> `uen`/`ün`, the y/w non-strict initials) that is easy to
get subtly wrong, and a wrong entry fails silently — the syllable simply
disappears from the IPA and the character is never spoken.

Where the mapping comes from: misaki (`hexgrad/misaki`), the G2P Kokoro was
trained against. `scripts/misaki/transcription.py` is that module vendored
verbatim (MIT — see the LICENSE beside it), and it is the same code path the
reference verification used.

Regenerate with:

    uv run --with pypinyin==0.55.0 --with ordered-set==4.1.0 \\
        python3 scripts/gen-pinyin-table.py

`--check` regenerates in memory and compares against the committed file
without writing anything, which is what CI or a reviewer wants.

Syllable spelling: the keys are pypinyin's toneless form, where `ü` is written
`v` (`nv`, `lve`). pinyin-pro — the runtime's syllable source — spells it `ü`
instead, so the runtime translates `ü` -> `v` before looking a syllable up.
That translation is load-bearing: without it every syllable that has an `ü`
after `n` or `l` misses the table and is dropped without an error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "misaki"))

from pypinyin.contrib.tone_convert import to_normal  # noqa: E402
from pypinyin.pinyin_dict import pinyin_dict  # noqa: E402
from transcription import TONE_MAPPING, pinyin_to_ipa  # noqa: E402

OUTPUT = os.path.join(HERE, "..", "lib", "models", "phonemize", "pinyin-table.json")

# The tone used to render a template before the tone is taken back out. Tone 1
# is a single character (`˥`), so substituting it for the placeholder is
# unambiguous.
PROBE_TONE = 1
PLACEHOLDER = "0"

# The size the table must come out at. Asserted rather than assumed: a change
# to pypinyin's dictionary that adds or drops a syllable should fail loudly
# here, not quietly reshape the runtime's coverage.
EXPECTED_ENTRIES = 426


def toneless_syllables() -> list[str]:
    """Every toneless syllable pypinyin can produce for a Han character.

    Enumerating pypinyin's own character dictionary rather than a curated list
    is what makes the table's coverage a property of the toolchain: any
    syllable pypinyin might hand the runtime is one this table has an entry
    for.
    """
    raw: set[str] = set()
    for value in pinyin_dict.values():
        raw.update(value.split(","))

    normalised: set[str] = set()
    for syllable in raw:
        try:
            normalised.add(to_normal(syllable))
        except (ValueError, KeyError) as error:
            raise SystemExit(f"cannot normalise {syllable!r}: {error}") from error

    return sorted(normalised)


def build() -> dict[str, str]:
    table: dict[str, str] = {}
    tone_ipa = TONE_MAPPING[PROBE_TONE]

    for syllable in toneless_syllables():
        # `pinyin_to_ipa` returns every accepted realisation; misaki itself
        # takes the first, and so does the runtime (it has no way to choose).
        variants = pinyin_to_ipa(f"{syllable}{PROBE_TONE}")
        if len(variants) == 0:
            raise SystemExit(f"{syllable!r} produced no IPA")

        ipa = "".join(variants[0])
        if ipa.count(tone_ipa) != 1:
            raise SystemExit(f"{syllable!r} produced {ipa!r}, expected one tone mark")
        table[syllable] = ipa.replace(tone_ipa, PLACEHOLDER)

    if len(table) != EXPECTED_ENTRIES:
        raise SystemExit(
            f"generated {len(table)} entries, expected {EXPECTED_ENTRIES} — "
            "pypinyin's dictionary or misaki's mapping changed"
        )
    return table


def serialise(table: dict[str, str]) -> str:
    """The exact bytes of the committed file: one key per line, no indent."""
    return json.dumps(table, ensure_ascii=False, indent=0, sort_keys=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="compare against the committed table instead of writing it",
    )
    args = parser.parse_args()

    generated = serialise(build())

    if args.check:
        try:
            with open(OUTPUT, encoding="utf-8") as handle:
                committed = handle.read()
        except FileNotFoundError:
            print(f"{OUTPUT} is missing; run without --check", file=sys.stderr)
            return 1

        if committed == generated:
            print(f"pinyin-table.json is up to date ({EXPECTED_ENTRIES} entries)")
            return 0

        print("pinyin-table.json is stale; run without --check", file=sys.stderr)
        # Same length or not, a diff of the parsed maps says more than a byte
        # offset when the change is a single syllable's IPA.
        committed_map = json.loads(committed)
        generated_map = json.loads(generated)
        for key in sorted(set(committed_map) | set(generated_map)):
            if committed_map.get(key) != generated_map.get(key):
                print(
                    f"  {key}: {committed_map.get(key)!r} -> {generated_map.get(key)!r}",
                    file=sys.stderr,
                )
        return 1

    with open(OUTPUT, "w", encoding="utf-8") as handle:
        handle.write(generated)
    print(f"wrote {OUTPUT} ({EXPECTED_ENTRIES} entries)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
