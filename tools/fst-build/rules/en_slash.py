# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# `24/7`, which is an idiom and not a fraction.
#
# Upstream's `Fraction` reads `24/7` as "twenty four sevenths" — right for
# `3/4`, wrong for the one pair of numbers that is written as a slash in
# ordinary English. The whole rule is that one string: generalising it to
# `DIGIT/DIGIT` would take `3/4` away from the fraction rule, and generalising
# it to any numerator over seven would take `124/7` away too.
#
# Weight 0.5 against the fraction rule's 0.99, so this wins on `24/7` and loses
# wherever our match would be only part of a token: `124/7` is either a fraction
# (0.99) or a cardinal plus this rule (1.5), and `24/71` likewise. `24-7` is a
# hyphen, not this shape, and stays "twenty four to seven".

import pynini
from pynini.lib import pynutil

from tn.processor import Processor

ALL_DAY = pynini.cross("24/7", "twenty four seven")


class AllDay(Processor):
    """`24/7` → "twenty four seven"."""

    def __init__(self):
        super().__init__("slash", ordertype="en_tn")
        self.build_tagger()
        self.build_verbalizer()

    def build_tagger(self):
        self.tagger = self.add_tokens(
            pynutil.insert('value: "') + ALL_DAY + pynutil.insert('"')
        ).optimize()

    def build_verbalizer(self):
        raw = (
            pynutil.delete('value: "')
            + self.NOT_QUOTE.plus
            + pynutil.delete('"')
        )
        self.verbalizer = self.delete_tokens(raw.optimize()).optimize()
