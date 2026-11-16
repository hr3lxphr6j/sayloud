# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
#
# Money with cents, as a rule that runs beside upstream's `Money`.
#
# Upstream reads `$20.50` as "twenty point five dollars": its verbalizer treats
# every fractional part as a decimal, which is right for `$1.2320` and wrong for
# the one shape money is actually written in. Changing that verbalizer in place
# would change every amount, including `$1.2 million` and `$1.2320`; this rule
# instead matches only the unambiguous shape — a currency with a known minor
# unit, an integer part, a dot, and exactly two fractional digits that are not
# `00` — and emits the whole phrase its own way.
#
# It is safe to run beside `Money` because the shapes do not overlap:
#
#   $20.50     here (two digits)          $1.5      upstream (one digit)
#   $1.2320    upstream (four digits)     $1.2 million  upstream (quantity)
#   $1.00      upstream (zero fraction)   ¥1200.50  upstream (no minor unit)
#
# Both rules tag the same input; ours carries weight 0.5 against upstream's 1.0,
# so the more specific reading wins where both match, and the upstream rule is
# the fallback everywhere else.
#
# The currency words are read from upstream's own tables at build time — the
# first row for a symbol in `currency_major.tsv` (so `$` is "dollar", not "us
# dollar"), pluralized with the same `SINGULAR_TO_PLURAL` graph the money rule
# uses, and the minor word from `currency_minor_{singular,plural}.tsv` — so a
# submodule bump that adds a currency adds it here too.

import pynini
from pynini.lib import pynutil

from tn.english.rules.measure import SINGULAR_TO_PLURAL
from tn.processor import Processor
from tn.utils import get_abs_path, load_labels

from .en_cardinal import FixedCardinal


def _word(graph, text):
    """The one output of `text ∘ graph`, for build-time literals."""
    return pynini.shortestpath(pynini.compose(pynini.accep(text), graph)).string()


def _currencies():
    """(symbol, major singular, major plural, minor singular, minor plural)."""
    major = {}
    for row in load_labels(get_abs_path("english/data/money/currency_major.tsv")):
        major.setdefault(row[0], row[1])
    minor_singular = {
        row[0]: row[1]
        for row in load_labels(get_abs_path("english/data/money/currency_minor_singular.tsv"))
    }
    minor_plural = {
        row[0]: row[1]
        for row in load_labels(get_abs_path("english/data/money/currency_minor_plural.tsv"))
    }

    # `US$` has a plural minor entry but no singular one; the regular plural in
    # that table (`cents`) gives its singular by dropping the `s`, which is the
    # only currency shape where that is true.
    for symbol, plural in minor_plural.items():
        if symbol not in minor_singular and plural.endswith("s"):
            minor_singular[symbol] = plural[:-1]

    table = []
    for symbol, minor_singular_word in minor_singular.items():
        if symbol not in major or symbol not in minor_plural:
            continue
        major_singular = major[symbol]
        table.append(
            (
                symbol,
                major_singular,
                _word(SINGULAR_TO_PLURAL, major_singular),
                minor_singular_word,
                minor_plural[symbol],
            )
        )
    # `US$` before `$`, so the longer symbol is tried first.
    table.sort(key=lambda row: len(row[0]), reverse=True)
    return table


class MoneyCents(Processor):
    """`$20.50` → "twenty dollars and fifty cents"."""

    def __init__(self):
        super().__init__("money_cents", ordertype="en_tn")
        # The fixed class, not upstream's: this rule is ours, so it does not
        # inherit the 1,000-1,999 bug that `build.py` rebinds `Cardinal` to fix
        # for the rules upstream builds.
        self.cardinal = FixedCardinal()
        self.build_tagger()
        self.build_verbalizer()

    def build_tagger(self):
        cardinal = self.cardinal.graph_with_and

        # An integer, optionally comma-grouped. The commas are part of the input
        # pattern and are read by the cardinal graph itself.
        integer = (self.DIGIT | pynini.accep(",")).plus
        one_integer = pynini.accep("1")
        zero_integer = pynini.accep("0")
        many_integer = pynini.difference(integer, pynini.union("0", "1"))

        one_integer_words = one_integer @ cardinal
        many_integer_words = many_integer @ cardinal

        # Exactly two fractional digits, and not `00`: `$1.00` is a whole-dollar
        # amount, which upstream already reads correctly.
        two_digits = self.DIGIT + self.DIGIT
        one_cent = pynini.accep("01")
        many_cents = pynini.difference(two_digits, pynini.union("00", "01"))
        cent_words = (
            pynutil.delete("0") + (self.DIGIT - "0") | ((self.DIGIT - "0") + self.DIGIT)
        ) @ cardinal
        one_cent_words = one_cent @ cent_words
        many_cents_words = many_cents @ cent_words

        # Consume the decimal point: it is punctuation, not part of the words.
        dot = pynutil.delete(".")

        phrase = None
        for symbol, major_singular, major_plural, minor_singular, minor_plural in _currencies():
            # $0.05 → "five cents" (no "zero dollars").
            zero = (
                pynutil.delete(symbol)
                + pynutil.delete("0")
                + dot
                + one_cent_words
                + pynutil.insert(f" {minor_singular}")
            )
            zero |= (
                pynutil.delete(symbol)
                + pynutil.delete("0")
                + dot
                + many_cents_words
                + pynutil.insert(f" {minor_plural}")
            )
            # $1.50 → "one dollar and fifty cents".
            one = (
                pynutil.delete(symbol)
                + one_integer_words
                + pynutil.insert(f" {major_singular} and ")
                + dot
                + one_cent_words
                + pynutil.insert(f" {minor_singular}")
            )
            one |= (
                pynutil.delete(symbol)
                + one_integer_words
                + pynutil.insert(f" {major_singular} and ")
                + dot
                + many_cents_words
                + pynutil.insert(f" {minor_plural}")
            )
            # $20.50 → "twenty dollars and fifty cents".
            many = (
                pynutil.delete(symbol)
                + many_integer_words
                + pynutil.insert(f" {major_plural} and ")
                + dot
                + one_cent_words
                + pynutil.insert(f" {minor_singular}")
            )
            many |= (
                pynutil.delete(symbol)
                + many_integer_words
                + pynutil.insert(f" {major_plural} and ")
                + dot
                + many_cents_words
                + pynutil.insert(f" {minor_plural}")
            )

            phrase = zero if phrase is None else phrase | zero
            phrase |= one
            phrase |= many

        # The tagger emits the finished phrase as a quoted field, because the
        # output order (integer, major, cents, minor) cannot be expressed as the
        # reordered field sequence the token parser produces.
        self.tagger = self.add_tokens(
            pynutil.insert('value: "') + phrase.optimize() + pynutil.insert('"')
        ).optimize()

    def build_verbalizer(self):
        raw = (
            pynutil.delete('value: "')
            + self.NOT_QUOTE.plus
            + pynutil.delete('"')
        )
        self.verbalizer = self.delete_tokens(raw.optimize()).optimize()
