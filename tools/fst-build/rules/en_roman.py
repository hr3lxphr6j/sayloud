# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
#
# Roman numerals, but only where the surrounding words make them unambiguous.
#
# Upstream ships a `Roman` rule and deliberately leaves it out of the default
# English pipeline: a bare `IV` is as likely to be intravenous as four, and
# `MIX` is a word that happens to be a valid numeral. Upstream's rule therefore
# has three branches — a name (`Louis XIV`), a key word (`Chapter IV`) and a
# bare token (`LVIII`) — and the third is the one that reads `MIX` as 1009.
#
# This rule keeps only the key-word branch. `Chapter IV` and `Super Bowl LVIII`
# are the shapes a book or a news page actually uses; a bare Roman numeral is
# left to the `w` rule, which spells it as letters rather than inventing a
# number. The `names` branch is dropped too: its name list contains Will, Mark,
# Bill, Ray and Jack, so `Will I go` would become "Will the first", and it only
# covers I–XIX anyway (`Louis XIV` works, `Super Bowl LVIII` would not).
#
# The key words are upstream's six plus two proper names. We do *not* add common
# nouns: every one of them takes a relative clause with the pronoun `I`, so
# `the act I saw` became "the act one saw" and `at table C` "table one hundred".
# `super bowl` and `world war` stay because the numeral is the sports/history
# reading (`Super Bowl LVIII`, `World War II`), not a pronoun in a clause.

import pynini
from pynini.lib import pynutil

from tn.english.rules.roman import Roman
from tn.utils import get_abs_path, load_labels

# Contexts the reading corpus uses. Every entry is matched as-is, title-cased
# and upper-cased, the way upstream's own key words are.
KEY_WORDS = (
    "super bowl",
    "world war",
)


class RomanContext(Roman):
    """The key-word branch of upstream's `Roman`, with our context list."""

    def build_tagger(self):
        roman_dict = load_labels(get_abs_path("english/data/roman/roman_to_spoken.tsv"))
        default_graph = pynini.string_map(roman_dict).optimize()
        default_graph = pynutil.insert('integer: "') + default_graph + pynutil.insert('"')

        words = []
        for label in load_labels(get_abs_path("english/data/roman/key_word.tsv")):
            words.append(label)
            words.append([label[0][0].upper() + label[0][1:]])
            words.append([label[0].upper()])
        for word in KEY_WORDS:
            words.append([word])
            words.append([word.title()])
            words.append([word.upper()])
        key_words = pynini.string_map(words).optimize()

        graph = (
            pynutil.insert('key_cardinal: "')
            + key_words
            + pynutil.insert('"')
            + pynini.accep(" ")
            + default_graph
        ).optimize()

        self.structured_graph = graph.optimize()
        self.tagger = self.add_tokens(self.tag_field("value", self.structured_graph))
