# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# PoC: rebuild only the grammars the SayLoud phonemizer actually ships.
#
# Derived from `build_fsts.py` in https://github.com/pengzhendong/wetext at
# commit c188fc7 (the tree that became `wetext==0.1.8`). Everything that is not
# `<lang>/tn/{tagger,verbalizer}.fst` is dropped on purpose: ITN, the streaming
# `prefix`/`prefix_matcher` graphs, the shared post-processors and the
# `remove_erhua` variant are not loaded by `crates/phonemize/src/tn/engine.rs`.
#
# The two details that must not drift from upstream, because they are what the
# shipped bytes encode:
#
#   * the constructor arguments (they select which rules enter the union), and
#   * `graph.optimize().write(path)` — optimize, then write, in that order.
#
# The `_StreamingPrefixMixin` of `build_fsts.py` is deliberately absent. It only
# redirects `tagger_union()` to capture the semantic prefix graph for streaming;
# its last statement calls `super().tagger_union(rule_specs)` with the untouched
# rule list, so the tagger and verbalizer it produces are the same graphs the
# plain upstream classes produce.
#
# Usage:
#   PYTHONPATH=/path/to/WeTextProcessing python build_min.py [--langs en,zh,ja]
#                                                            [--out out]

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import pynini

from tn.chinese.normalizer import Normalizer as ZhNormalizer
from tn.english.normalizer import Normalizer as EnNormalizer
from tn.japanese.normalizer import Normalizer as JaNormalizer


def write_graph(graph: "pynini.FstLike", path: Path) -> None:
    """Write one graph the way upstream does: optimize, then write."""
    path.parent.mkdir(parents=True, exist_ok=True)
    graph.optimize().write(str(path))


def build_en(out: Path) -> None:
    normalizer = EnNormalizer(cache_dir=False)
    write_graph(normalizer.tagger, out / "en/tn/tagger.fst")
    write_graph(normalizer.verbalizer, out / "en/tn/verbalizer.fst")


def build_zh(out: Path) -> None:
    options = {
        "cache_dir": False,
        "traditional_to_simple": False,
        "remove_interjections": False,
        "remove_puncts": False,
        "full_to_half": False,
        "tag_oov": False,
    }
    normalizer = ZhNormalizer(remove_erhua=False, **options)
    write_graph(normalizer.tagger, out / "zh/tn/tagger.fst")
    write_graph(normalizer.verbalizer, out / "zh/tn/verbalizer.fst")


def build_ja(out: Path) -> None:
    normalizer = JaNormalizer(
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
        help="output root; grammars land at <out>/<lang>/tn/{tagger,verbalizer}.fst",
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
