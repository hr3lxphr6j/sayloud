# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Telephone numbers and postal codes, read digit by digit.
#
# Upstream's Japanese `Cardinal` has a telephone branch, but it only covers the
# shape it grew up on: `090-1234-5678` comes out `ゼロ九ゼロの一二三四の五六七八`,
# with the hyphens read as の and the digits left as kanji numerals. Anything
# that is not exactly that shape falls through to the arithmetic rules —
# `0120-123-456` is read as numbers subtracted from each other
# (`〇百二十マイナス百二十三マイナス四百五十六`) and `〒100-0001` as a cardinal
# minus a cardinal.
#
# This rule owns the two shapes that are unambiguously identifiers rather than
# quantities:
#
#   telephone  0 + 1..3 digits - 1..4 digits - 3..4 digits
#   postal     〒 3 digits - 4 digits
#
# The bare `3-4` shape is deliberately *not* matched. Without the 〒 there is no
# way to tell a postal code from a range inside a longer number, and the tagger
# can start a match at any offset: `2020-0101` matched `020-0101` and came out
# `二ゼロにゼロ、ゼロいちゼロいち`. Japanese postcodes are written with 〒, so
# requiring it costs the real shape and removes the accidental one.
#
# The reading is katakana, one character at a time, with `、` between the
# groups, because that is how a Japanese speaker says a number they are looking
# at rather than counting: 7 is なな and 9 is きゅう (`しち`/`く` are the
# counting readings, and they are what makes a telephone number hard to follow).
# The digits go out as finished text rather than as a numeral graph for the
# verbalizer to read, because the per-digit mapping is not the cardinal's: no
# group here is a quantity, and `1234` must not become 千二百三十四.
#
# Weights: 0.5, against `Cardinal`'s 1.06 (the phone branch that reads
# `090-1234-5678` today) and `Math`'s 90 (the マイナス reading of the shapes it
# does not cover). All of them are in the same union, so ours wins on the shapes
# above and loses everywhere else.

import pynini
from pynini.lib import pynutil

from tn.processor import Processor

# Zero is ゼロ and not れい: it is the reading a telephone number is said with.
# 4 is よん and 7 is なな for the same reason — し and しち are ambiguous with
# 死 and 七/位置 when the hearer cannot see the digits.
WORDS = ("ゼロ", "いち", "に", "さん", "よん", "ご", "ろく", "なな", "はち", "きゅう")

# Both widths: `build_ja` runs with `full_to_half=False`, and the pipeline's
# fold does not touch U+FF10-FF19 (that range is the per-language preprocessor's
# business), so a full-width telephone number reaches the grammar as written.
DIGITS = tuple((str(digit), word) for digit, word in enumerate(WORDS))
DIGITS += tuple((chr(ord("０") + digit), word) for digit, word in enumerate(WORDS))

ZEROES = pynini.union("0", "０")


class Identifier(Processor):
    """The graph pieces both shapes are made of."""

    def digit_run(self, lo, hi=None):
        digits = pynini.string_map(DIGITS).optimize()
        return pynini.closure(digits, lo, lo if hi is None else hi)

    def zero_leading_run(self, lo, hi=None):
        """A run whose first digit is a zero, said ゼロ."""
        digits = pynini.string_map(DIGITS).optimize()
        return (
            pynutil.delete(ZEROES)
            + pynutil.insert(WORDS[0])
            + pynini.closure(digits, lo, lo if hi is None else hi)
        )

    def tag(self, graph):
        self.tagger = self.add_tokens(
            pynutil.insert('value: "') + graph.optimize() + pynutil.insert('"')
        ).optimize()

    def build_verbalizer(self):
        # The tagger emits the finished katakana phrase, so the verbalizer has
        # nothing left to read: it only removes the field wrapper.
        raw = (
            pynutil.delete('value: "')
            + self.NOT_QUOTE.plus
            + pynutil.delete('"')
        )
        self.verbalizer = self.delete_tokens(raw.optimize()).optimize()


class Telephone(Identifier):
    """`090-1234-5678` → `ゼロきゅうゼロ、いちにさんよん、ごろくななはち`."""

    def __init__(self):
        super().__init__("telephone")
        self.build_tagger()
        self.build_verbalizer()

    def build_tagger(self):
        group_break = pynutil.delete("-") + pynutil.insert("、")

        # The word in front of a telephone number is part of the match, or
        # upstream's `ordinal` branch (`番号は` + digits) claims the first group
        # and the rest falls back to the range reading: `電話番号は090-…` came
        # out きゅうマイナス… even with the bare shape fixed. Consuming the word
        # and writing it back unchanged keeps the sentence and makes the whole
        # number one token.
        prefix = (
            pynini.accep("電話番号") | pynini.accep("番号")
        ) + pynini.accep("は").ques

        # 0 + 1..3 digits, then 1..4, then 3..4.
        self.tag(
            prefix.ques
            + self.zero_leading_run(1, 3)
            + group_break
            + self.digit_run(1, 4)
            + group_break
            + self.digit_run(3, 4)
        )


class Postal(Identifier):
    """`〒100-0001` → `いちゼロゼロ、ゼロゼロゼロいち`."""

    def __init__(self):
        super().__init__("postal")
        self.build_tagger()
        self.build_verbalizer()

    def build_tagger(self):
        group_break = pynutil.delete("-") + pynutil.insert("、")

        # The mark is the context, so the second group may start with anything.
        self.tag(
            pynutil.delete("〒")
            + self.digit_run(3)
            + group_break
            + self.digit_run(4)
        )
