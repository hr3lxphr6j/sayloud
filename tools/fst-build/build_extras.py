# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# The two shared preprocessors, which `build_min.py` deliberately leaves out
# because they are not per-language. Same source and same call shape as
# `build_processors()` in wetext's `build_fsts.py` at c188fc7: the `PostProcessor`
# is constructed with only one switch enabled at a time, and the file written is
# `processor.star` (not the processor itself), then `optimize()`.
#
# `tag_oov`, `remove_interjections` and `remove_puncts` are not built: no
# configuration in `crates/phonemize/src/tn/engine.rs` asks for them, so nothing
# would read the result.
#
# Usage (from tools/fst-build):
#   PYTHONPATH=/path/to/WeTextProcessing python build_extras.py --out out

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from tn.chinese.rules.postprocessor import PostProcessor

# Filename -> the single switch that is on. The rest are explicitly off, because
# `PostProcessor`'s own defaults differ per switch.
SWITCHES = {
    "full_to_half.fst": "full_to_half",
    "traditional_to_simple.fst": "traditional_to_simple",
}

ALL_OFF = {
    "traditional_to_simple": False,
    "remove_interjections": False,
    "remove_puncts": False,
    "full_to_half": False,
    "tag_oov": False,
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", default="out", help="output root")
    args = parser.parse_args(argv)

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for filename, switch in SWITCHES.items():
        started = time.monotonic()
        options = ALL_OFF.copy()
        options[switch] = True
        graph = PostProcessor(**options).processor.star
        graph.optimize().write(str(out / filename))
        print(f"built {filename} in {time.monotonic() - started:.1f}s", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
