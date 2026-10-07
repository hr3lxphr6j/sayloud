#!/usr/bin/env python3
"""Mutation-check the Japanese pipeline's guards.

Run manually, not from CI: each mutation needs its own compile, so a full pass
takes minutes rather than seconds.

    python3 scripts/check/mutation-check-ja.py

Every mutation here is one that would make a real bug invisible — the dictionary
placeholder read as a value, the numeral rules skipped, the two-character mora
lookup losing to the one-character one, and so on. For each, the script applies
it, runs the test target that should notice, and restores the file.

It asserts the replacement actually matched before running the tests. That is the
lesson from `[[mutation-harness-must-assert-the-pattern-matched]]`: a
`str.replace` that finds nothing leaves the tests green, and "the tests did not
catch it" then looks exactly like "there was no bug". Two of the entries below
started out as mutations that survived for that reason — one was genuinely
equivalent code (an empty group already writes nothing), one was dead code — and
both were fixed rather than accepted.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys

# The repository root, from this script rather than the working directory.
ROOT = pathlib.Path(__file__).resolve().parent.parent.parent

# (file, description, old, new, which test target must fail)
MUTATIONS: list[tuple[str, str, str, str, str]] = [
    (
        "crates/phonemize/src/g2p/ja/segmenter.rs",
        "stop treating the dictionary's `*` placeholder as an absent reading",
        ".filter(|reading| *reading != self.absent_field)",
        "",
        "ja_pipeline",
    ),
    (
        "crates/phonemize/src/pipeline.rs",
        "skip numeral normalization, so digits reach the segmenter and vanish",
        "let with_numerals = tn::normalize(&punctuated, tn::Lang::Ja, engine);",
        "let with_numerals = punctuated;",
        "ja_pipeline",
    ),
    (
        "crates/phonemize/src/pipeline.rs",
        "apply punctuation normalization after segmentation instead of before",
        "let normalized = normalize_punctuation(text);",
        "let normalized = text.to_string();",
        "ja_pipeline",
    ),
    (
        "crates/phonemize/src/pipeline.rs",
        "stop applying the numeral sound changes",
        "parts.push(kana_to_ipa(&fix_numeral_sound_changes(&katakana)));",
        "parts.push(kana_to_ipa(&katakana));",
        "ja_pipeline",
    ),
    (
        "crates/phonemize/src/g2p/ja/ipa.rs",
        "take the single-character entry before trying the two-character pair",
        "if let Some(ipa) = lookup(katakana[index], Some(katakana[index + 1])) {",
        "if let Some(ipa) = lookup(katakana[index], None).filter(|_| false) {",
        "ja_g2p",
    ),
    (
        "crates/phonemize/src/kana.rs",
        "widen the hiragana-to-katakana shift past kuroshiro's upper bound",
        "if ch > '\\u{3040}' && ch < '\\u{3097}' {",
        "if ch > '\\u{3040}' && ch < '\\u{30a0}' {",
        "ja_g2p",
    ),
    (
        "crates/phonemize/src/tn/readers/ja.rs",
        "keep a leading 一 before a place unit, so 1000 reads 一千",
        "if digit == 1 && is_place_unit {",
        "if false {",
        "ja_g2p",
    ),
    (
        "crates/phonemize/src/tn/readers/ja.rs",
        "write a placeholder for an empty four-digit group",
        "if group == 0 {\n            continue;\n        }",
        "if false {\n            continue;\n        }",
        "ja_g2p",
    ),
    (
        "crates/phonemize/src/text.rs",
        "classify Latin letters as `other`, where the punctuation filter drops them",
        "} else if (65..=90).contains(&code) || (97..=122).contains(&code) {\n        LATIN",
        "} else if false {\n        LATIN",
        "ja_g2p",
    ),
    (
        "crates/phonemize/src/text.rs",
        "add the Extension B kanji branch the JavaScript cannot reach",
        "} else if is_hiragana(ch) || is_katakana(ch) || (0x31f0..=0x31ff).contains(&code) {",
        "} else if (0x20000..=0x2ebef).contains(&code) {\n        HAN\n    } else if is_hiragana(ch) || is_katakana(ch) || (0x31f0..=0x31ff).contains(&code) {",
        "ja_g2p",
    ),
]


def run(target: str) -> bool:
    """True when the test target passes."""
    result = subprocess.run(
        ["cargo", "test", "-p", "phonemize", "--test", target],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def compiles(target: str) -> bool:
    """True when the mutated source still builds that test target.

    A mutation that does not compile also makes `cargo test` exit non-zero, so
    without this the run would report "caught" for a `str.replace` that produced
    a syntax error — the same false green as a pattern that never matched, one
    step further down.
    """
    result = subprocess.run(
        ["cargo", "test", "-p", "phonemize", "--test", target, "--no-run"],
        cwd=ROOT,
        capture_output=True,
        text=True,
    )
    return result.returncode == 0


def main() -> int:
    survivors: list[str] = []

    for path, description, old, new, target in MUTATIONS:
        file = ROOT / path
        original = file.read_text()

        if old not in original:
            print(f"BROKEN  {description}\n        the pattern does not match {path}")
            survivors.append(f"{description} (pattern never matched)")
            continue

        file.write_text(original.replace(old, new, 1))
        try:
            built = compiles(target)
            passed = built and run(target)
        finally:
            file.write_text(original)

        if not built:
            print(
                f"NO COMPILE {description}\n"
                f"         the mutation does not build, so {target} cannot have caught it"
            )
            survivors.append(f"{description} (did not compile)")
        elif passed:
            print(f"SURVIVED {description}\n         {target} still passed")
            survivors.append(description)
        else:
            print(f"caught   {description}")

    print()
    if survivors:
        print(f"{len(survivors)} of {len(MUTATIONS)} mutations were not caught:")
        for survivor in survivors:
            print(f"  - {survivor}")
        return 1

    print(f"all {len(MUTATIONS)} mutations caught")
    return 0


if __name__ == "__main__":
    sys.exit(main())
