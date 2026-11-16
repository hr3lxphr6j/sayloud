# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# `§` with the number written against it.
#
# `§` is in upstream's symbol table, so `§ 3.2` already reads "section three
# point two". `§3.2` does not: the tagger's shape is
# `token (separator token)*` and the separator between two tokens is a space or
# punctuation, so a whitelist token for `§` cannot be followed directly by the
# token for `3.2` — the whole sentence has no path and the engine returns it
# unchanged, which is where `tn-no-path` comes from.
#
# So the rule reads the number itself. The alternative — emit "section" from a
# rule that consumes only `§` — cannot work for exactly that reason. The number
# is a chain of digit groups joined by dots (a section, a subsection, a
# subsubsection: `§3.2.1`), and each group is read as the number it is. A space
# after `§` is *not* accepted, so `§ 3.2` keeps whatever upstream does with it.

import pynini
from pynini.lib import pynutil

from tn.processor import Processor

from .en_cardinal import FixedCardinal


class Section(Processor):
    """`§3.2` → "section three point two"."""

    def __init__(self):
        super().__init__("section", ordertype="en_tn")
        self.cardinal = FixedCardinal()
        self.build_tagger()
        self.build_verbalizer()

    def build_tagger(self):
        digit = self.DIGIT
        nonzero = pynini.difference(digit, pynini.accep("0"))

        words = (nonzero + digit.star) @ self.cardinal.graph_with_and
        words |= (pynini.accep("0") + digit.plus) @ self.cardinal.single_digits_graph

        point = pynutil.delete(".") + pynutil.insert(" point ")
        number = words + (point + words).star

        graph = (
            pynutil.delete("§") + pynutil.insert("section ") + number
        ).optimize()

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
