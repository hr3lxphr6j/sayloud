# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# The one build entry point: all 8 shipped grammars in a single process.
#
# `build_min.py` and `build_extras.py` stay as they are — they are the PoC that
# established the pins and they remain runnable on their own. This script
# reuses `build_min.write_graph` (optimize-then-write, in that order) and calls
# `build_extras.main` for the two shared preprocessors, so the file layout,
# names and write order cannot drift between the two paths.
#
# Usage (from tools/fst-build, in the linux/amd64 container):
#   python build.py --langs en,zh,ja --out out
#
# The mixin canary printed at the end is load-bearing: if `localize_calls()` is
# 0 the grammars were served from a cache bundle and our rules never ran — see
# `rules/__init__.py` and docs/superpowers/TN-PLAN.md §5.3.

from __future__ import annotations

import argparse
import inspect
import sys
import time
from pathlib import Path

# The grammar source is the git submodule, not a checkout made by the image.
# This must happen before anything imports `tn.*` or `rules` (which imports
# `tn.processor`).
HERE = Path(__file__).resolve().parent
UPSTREAM = HERE / "upstream" / "WeTextProcessing"
if not (UPSTREAM / "tn").is_dir():
    raise SystemExit(
        f"{UPSTREAM} is empty: run `git submodule update --init --depth 1` first."
    )
sys.path.insert(0, str(UPSTREAM))

from tn.chinese.normalizer import Normalizer as ZhNormalizer  # noqa: E402
from tn.english.normalizer import Normalizer as EnNormalizer  # noqa: E402
from tn.japanese.normalizer import Normalizer as JaNormalizer  # noqa: E402

import build_extras  # noqa: E402
from build_min import write_graph  # noqa: E402
from rules import EN_RULES, JA_RULES, ZH_RULES, LocalRulesMixin, localize_calls  # noqa: E402

# Upstream's 1,000-1,999 bug, fixed at the one place it is read from.
#
# `tn.english.normalizer.build_tagger_and_verbalizer` does `cardinal = Cardinal()`
# and hands that single instance to `Decimal`, `Money`, `Measure`, `Date` and
# `Serial`, so replacing the *class* in the module it is imported from fixes
# every consumer at once. Replacing the `Cardinal` `RuleSpec` in our mixin could
# not: `Decimal`/`Money` hold their own reference, built before any union runs.
#
# This must run before the first normalizer is constructed (`build_en` below),
# hence module scope. See `rules/en_cardinal.py` for why the fix is a copy of
# `build_tagger` and not a post-hoc repair.
import tn.english.normalizer as en_normalizer  # noqa: E402
from rules.en_cardinal import FixedCardinal  # noqa: E402
from tn.english.rules.cardinal import Cardinal  # noqa: E402

# Before the assignment, or it could not tell "was there" from "we just made it".
assert hasattr(
    en_normalizer, "Cardinal"
), "tn.english.normalizer no longer imports Cardinal; the rebinding below would be dead"
en_normalizer.Cardinal = FixedCardinal
assert en_normalizer.Cardinal is FixedCardinal, (
    "the Cardinal rebinding did not take: tn.english.normalizer.Cardinal is "
    f"{en_normalizer.Cardinal!r}"
)

# The two things the copy of `build_tagger` depends on, read off the parent
# rather than off our copy (a copy can always agree with itself): the graph the
# inherited `build_verbalizer` reads, and the branch whose weight is the fix.
_upstream_build_tagger = inspect.getsource(Cardinal.build_tagger)
assert "final_graph" in _upstream_build_tagger and "one thousand" in _upstream_build_tagger, (
    "upstream's Cardinal.build_tagger no longer builds the graph this fix edits; "
    "re-read rules/en_cardinal.py before removing these asserts"
)


class En(LocalRulesMixin, EnNormalizer):
    LOCAL_RULES = EN_RULES


class Zh(LocalRulesMixin, ZhNormalizer):
    LOCAL_RULES = ZH_RULES


class Ja(LocalRulesMixin, JaNormalizer):
    LOCAL_RULES = JA_RULES


def build_en(out: Path) -> None:
    normalizer = En(cache_dir=False)
    write_graph(normalizer.tagger, out / "en/tn/tagger.fst")
    write_graph(normalizer.verbalizer, out / "en/tn/verbalizer.fst")


def build_zh(out: Path) -> None:
    # Same arguments as build_min.build_zh: every optional stage off, except
    # the erhua switch, which is a separate constructor parameter.
    options = {
        "cache_dir": False,
        "traditional_to_simple": False,
        "remove_interjections": False,
        "remove_puncts": False,
        "full_to_half": False,
        "tag_oov": False,
    }
    normalizer = Zh(remove_erhua=False, **options)
    write_graph(normalizer.tagger, out / "zh/tn/tagger.fst")
    write_graph(normalizer.verbalizer, out / "zh/tn/verbalizer.fst")


def build_ja(out: Path) -> None:
    normalizer = Ja(
        cache_dir=False,
        transliterate=False,
        remove_interjections=False,
        remove_puncts=False,
        full_to_half=False,
        tag_oov=False,
    )
    write_graph(normalizer.tagger, out / "ja/tn/tagger.fst")
    write_graph(normalizer.verbalizer, out / "ja/tn/verbalizer.fst")


BUILDERS = {"en": build_en, "zh": build_zh, "ja": build_ja}

# One tagger union and one verbalizer union per language.
UNIONS_PER_LANGUAGE = 2


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--langs",
        default="en,zh,ja",
        help="comma-separated subset of en,zh,ja (default: all three)",
    )
    parser.add_argument(
        "--out",
        default="out",
        help="output root; grammars land at <out>/<lang>/tn/{tagger,verbalizer}.fst "
        "and the preprocessors at <out>/{full_to_half,traditional_to_simple}.fst",
    )
    args = parser.parse_args(argv)

    langs = [lang.strip() for lang in args.langs.split(",") if lang.strip()]
    unknown = [lang for lang in langs if lang not in BUILDERS]
    if unknown:
        parser.error(f"unknown language(s): {', '.join(unknown)}")

    out = Path(args.out)
    for lang in langs:
        started = time.monotonic()
        BUILDERS[lang](out)
        elapsed = time.monotonic() - started
        print(f"built {lang} in {elapsed:.1f}s", file=sys.stderr)

    # The two shared preprocessors (full_to_half, traditional_to_simple).
    status = build_extras.main(["--out", str(out)])
    if status != 0:
        print(f"build_extras failed with exit code {status}", file=sys.stderr)
        return status

    calls = localize_calls()
    expected = len(langs) * UNIONS_PER_LANGUAGE
    print(f"mixin localize calls: {calls}")
    if calls != expected:
        print(
            f"mixin did not run as expected: {calls} union call(s) for "
            f"{', '.join(langs)}; expected {expected}. A count of 0 means the "
            "grammars came from a cache bundle (`cache_dir` must stay False) "
            "and the local rules were never injected.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
