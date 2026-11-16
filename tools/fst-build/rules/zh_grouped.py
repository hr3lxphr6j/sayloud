# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Grouped numbers, where the grouping is a thousands separator.
#
# `1,234` is not an entity to upstream's Chinese grammar: the comma belongs to
# no rule, so `Cardinal` reads `1` and `234` as two numbers and the comma is
# read out by `Char`, giving `一,两百三十四`. The reading the text asks for is
# one number: 一千二百三十四.
#
# The shape is the separator convention, not a quantity:
#
#   1-3 leading digits, then one or more groups of exactly 3 digits   (1,234)
#   or of exactly 4 digits                                            (1,0000)
#
# — and the group width has to be consistent within one number, or `1,234,5678`
# would be read as an eleven-digit number that nobody wrote. A comma with no
# group after it is not this shape either: `1,` stays as it is.
#
# The digits themselves are read by upstream's own graph
# (`tn.chinese.rules.cardinal.Cardinal().number`) once the separators are gone,
# so 万/亿 grouping, the 两 replacement and every reading upstream gets right for
# an unseparated number are the same here. That is the whole reason the rule
# strips the commas and composes, rather than carrying a second table.
#
# Both comma widths: `build_zh` runs with `full_to_half=False`, and the
# pipeline's fold deliberately leaves `，` alone (NFKC would have turned it into
# a half stop at the wrong point), so a full-width separator is what reaches the
# grammar in ordinary Chinese text.
#
# A currency symbol is part of the match when it is written: `¥1,234` would
# otherwise come out as `¥一千二百三十四`, with the currency word and 元 lost and
# the symbol reported as unread. The table is upstream's own `symbol.tsv`, so
# the word is the one the money rule would have said; the trailing currency word
# is deleted when it is already there (`¥1,234元`) so it is not said twice. A
# fractional part after the grouped digits goes through the cardinal's own
# decimal graph (`¥1,234.50` → 一千二百三十四点五零元).
#
# Weight 0.5: the competing readings of `1,234` are `Math` at 90 per group plus
# `Char` at 100 for the comma, so ours wins on a grouped number and nowhere
# else. `1.234` has no comma and is not this shape.

import pynini
from pynini.lib import pynutil

from pynini import string_file

from tn.chinese.rules.cardinal import Cardinal
from tn.processor import Processor
from tn.utils import get_abs_path, load_labels

SEPARATOR = pynini.union(",", "，")


class Grouped(Processor):
    """`1,234` → 一千二百三十四."""

    def __init__(self):
        super().__init__("grouped")
        self.cardinal = Cardinal()
        self.build_tagger()
        self.build_verbalizer()

    def build_tagger(self):
        digit = self.DIGIT
        leading = pynini.closure(digit, 1, 3)

        def groups(width):
            return pynutil.delete(SEPARATOR) + digit**width

        # One number: the separators are deleted, then the digit string is read
        # by upstream's cardinal graph, so the output is a finished phrase.
        three = leading + groups(3).plus
        four = leading + groups(4).plus
        shape = three | four
        # `¥1,234.50` is still a grouped number; the cardinal reads the point
        # and the fraction itself.
        # The comma form is what the text has; `plain` is the same number with
        # the separators gone, which is what upstream's cardinal and money
        # graphs expect. A decimal tail is kept (`¥1,234.50`).
        plain = shape + (pynini.accep(".") + digit.plus).ques

        # A bare grouped number is our own `grouped { value: ... }` token; the
        # value is the finished reading, and the verbalizer below only strips
        # the wrapper.
        bare = self.add_tokens(
            pynutil.insert('value: "')
            + (plain @ self.cardinal.number)
            + pynutil.insert('"')
        )

        # With a currency symbol, emit upstream's `money` token instead of our
        # own: it already has the `value`/`currency` order and a verbalizer
        # that reads a `value` field through `Cardinal.number` and a `currency`
        # field through `symbol.tsv`. The value field is the **plain** digits,
        # not the comma form (the cardinal does not accept separators) and not
        # the finished reading (the money verbalizer would read it again).
        #
        # Emitting the token by hand rather than through a `Processor` is
        # deliberate: `add_tokens` would write `grouped { ... }`, and the point
        # is to reach the money verbalizer that is already in the union.
        symbol = string_file(get_abs_path("chinese/data/money/symbol.tsv"))
        words = pynini.union(
            *[word for _, word in load_labels(get_abs_path("chinese/data/money/symbol.tsv"))]
        )
        # `¥1,234元` already carries the word; consume it so it is not said twice.
        trailing = pynutil.delete(words).ques
        money = (
            pynutil.insert("money { ")
            + self.tag_field("currency", symbol)
            + pynutil.insert(" ")
            + pynutil.insert('value: "')
            + plain
            + pynutil.insert('"')
            + trailing
            + pynutil.insert(" } ")
        )

        self.tagger = (bare | money).optimize()

    def build_verbalizer(self):
        # The `value` field is upstream's cardinal wire format, so the
        # verbalizer only strips the wrapper. A `money` token never reaches
        # this graph: upstream's money verbalizer owns it.
        raw = (
            pynutil.delete('value: "')
            + self.NOT_QUOTE.plus
            + pynutil.delete('"')
        )
        self.verbalizer = self.delete_tokens(raw.optimize()).optimize()
