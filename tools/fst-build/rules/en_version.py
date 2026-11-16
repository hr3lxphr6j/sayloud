# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Version numbers, read as versions.
#
# Upstream reads `v1.2.3` as `v one.two point three` — the `v` and the first
# component are one serial token, and `2.3` is a decimal — and a bare `1.2.3`
# as `one.two point three`. Neither is what the text says: a dotted chain of
# three components is a version, and every component is the number it is
# written as, joined by "point".
#
# Two shapes, deliberately narrow:
#
#   v1.2.3 / V1.2.3      a `v` prefix and two or more components
#   1.2.3                no prefix, exactly three components, first 1-2 digits
#
# The bare shape stops at three components because four is an address
# (`1.2.3.4`, `192.168.1.1`) and upstream's `Telephone` already reads those
# digit by digit with "dot" between the groups. It keeps winning: a whole-chain
# telephone token costs 1.0, while matching our three components and leaving
# `.4` costs us 0.5 plus 2.0 for the punctuation token plus 1.0 for the last
# digit, so the longer reading is cheaper by 2.5 and the four-component chain is
# untouched. `1.2` stays a decimal because the rule needs the third dot.
#
# `version` is said, not spelled: `v1.2.3` is "version one point two point
# three", not "vee one point two point three".
#
# Identifiers are *not* this rule's business: `MP3`, `UTF-8` and `COVID-19`
# already read correctly at the phoneme level and their text form is left alone.

import pynini
from pynini.lib import pynutil

from tn.processor import Processor

from .en_cardinal import FixedCardinal


class Version(Processor):
    """`v1.2.3` → "version one point two point three"."""

    def __init__(self):
        super().__init__("version", ordertype="en_tn")
        # Upstream's `Cardinal` has the 1,000-1,999 bug; this rule is ours, so it
        # reads with the fixed class the rest of `build.py` rebinds.
        self.cardinal = FixedCardinal()
        self.build_tagger()
        self.build_verbalizer()

    def build_tagger(self):
        digit = self.DIGIT
        nonzero = pynini.difference(digit, pynini.accep("0"))

        # One component, read as the number it is. A component with a leading
        # zero is a digit sequence, not a number (`v1.007.2` is "one point zero
        # zero seven point two"), which is exactly what the cardinal's own
        # single-digits graph says.
        words = (nonzero + digit.star) @ self.cardinal.graph_with_and
        leading_zero = pynini.accep("0") + digit.plus
        words |= leading_zero @ self.cardinal.single_digits_graph
        # `0` on its own is a component too, and it is the common one
        # (`v1.0.0`): the leading-zero branch above needs a digit after the
        # zero, so without this the whole three-component token missed and
        # upstream split it as `v one.zero point oh`.
        words |= pynini.cross("0", "zero")

        point = pynutil.delete(".") + pynutil.insert(" point ")

        # Every component after the first is unbounded: `v1.2.3` and
        # `v1.2024.3` are the same shape.
        prefixed = (
            pynutil.delete(pynini.union("v", "V"))
            + pynutil.insert("version ")
            + words
            + (point + words).plus
        )

        # A bare chain: three components, first one at most two digits, so
        # `192.168.1` (a subnet prefix) does not match.
        short = pynini.closure(digit, 1, 2) @ words
        bare = short + point + words + point + words

        # Four components stay with upstream's telephone reading (`one dot two
        # ...`). Five or more are not handled: looping `words` to cover them
        # pushed the English build past the container's 2 GiB cap, and the shape
        # is rare enough that the memory is not worth it. The review recorded it
        # as `1.2.3.4.5` -> `one point two point three.four point five`; the
        # rule below still matches the first three, which is why that reading is
        # not a crash but a wrong join.
        graph = (prefixed | bare).optimize()
        self.tagger = self.add_tokens(
            pynutil.insert('value: "') + graph + pynutil.insert('"')
        ).optimize()

    def build_verbalizer(self):
        raw = (
            pynutil.delete('value: "')
            + self.NOT_QUOTE.plus
            + pynutil.delete('"')
        )
        self.verbalizer = self.delete_tokens(raw.optimize()).optimize()
