# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
#
# The symbols upstream's symbol table does not read.
#
# `×` and `=` are upstream's; these are not. Without this rule they are dropped
# by `keep_punctuation` and the listener hears the two operands run together,
# which is worse than hearing the operator. One character, one phrase, so this
# is a string map and not a rule with context.
#
# The words are the ones a reader would say, not a formal expansion: `≈` is
# "is about" and `±` is "plus or minus". `§` is deliberately absent — it needs
# the shape around it (`§3.2`) and is left to the canonical/invariant work.

import pynini
from pynini.lib import pynutil

from tn.processor import Processor

SYMBOLS = (
    ("÷", "divided by"),
    ("≈", "is about"),
    ("±", "plus or minus"),
    ("≠", "is not equal to"),
    ("≤", "less than or equal to"),
    ("≥", "greater than or equal to"),
    ("∞", "infinity"),
    ("√", "square root of"),
    ("∑", "sum of"),
    ("∏", "product of"),
    ("∫", "integral of"),
)


class Symbols(Processor):
    def __init__(self):
        super().__init__("symbols", ordertype="en_tn")
        self.build_tagger()
        self.build_verbalizer()

    def build_tagger(self):
        graph = pynini.string_map(SYMBOLS).optimize()
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
