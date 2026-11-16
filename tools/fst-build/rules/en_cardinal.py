# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Cardinal, with upstream's 1,000-1,999 bug fixed.
#
# `1,234` reads "thousand two hundred and thirty four" on the pinned grammar:
# `Cardinal.build_tagger` builds an `one_to_a_replacement_graph` that rewrites
# "one hundred" to "a hundred", "one thousand" to "thousand" and "one million"
# to "a million", and composes it *into* `final_graph` — so the replacement is
# an extra path next to the original reading, not a string to be repaired
# afterwards. The "one thousand" branch carries weight -0.0001, which makes it
# cheaper than the unreplaced path, so it wins. (The other two carry +0.0001 and
# lose, which is why "a hundred" and "a million" do not appear by default.)
#
# There is no post-hoc way to undo one branch of a composed FST — the composed
# graph has no marker saying which path an input took — so the fix is a copy of
# the method with the sign flipped: +0.0001 makes "one thousand" the cheapest
# path and leaves the "one hundred"/"one million" branches at the weight they
# already had. Everything else in the method is upstream's, including the two
# graphs it builds on the way (`graph`, `graph_with_and`) and `final_graph`,
# which the inherited `build_verbalizer` reads.
#
# This is rebindable on purpose, and `build.py` does rebind it: upstream's
# normalizer creates one `Cardinal()` and hands it to `Decimal`, `Money`,
# `Measure`, `Date` and `Serial`, so `$1,234` and `1,234.5` are affected through
# `Decimal`/`Money` even though their own classes are untouched. Replacing the
# class at the module the normalizer builds from reaches all of them at once.
#
# The bug is upstream's and worth reporting; until it lands, this stays.

import pynini
from pynini.examples import plurals
from pynini.lib import pynutil

from tn.english.rules.cardinal import Cardinal
from tn.utils import get_abs_path


class FixedCardinal(Cardinal):
    """Upstream's `Cardinal.build_tagger`, with one weight sign changed."""

    def build_tagger(self):
        """
        Finite state transducer for classifying cardinals, e.g.
            -23 -> cardinal { negative: "-" integer: "23" }
        """
        # TODO replace to have "oh" as a default for "0"
        graph = pynini.Far(get_abs_path("english/data/number/cardinal_number_name.far")).get_fst()
        graph_au = pynini.Far(get_abs_path("english/data/number/cardinal_number_name_au.far")).get_fst()
        self.graph_hundred_component_at_least_one_none_zero_digit = (
            pynini.closure(self.DIGIT, 2, 3) | pynini.difference(self.DIGIT, pynini.accep("0"))
        ) @ graph

        graph_digit = pynini.string_file(get_abs_path("english/data/number/digit.tsv"))
        graph_zero = pynini.string_file(get_abs_path("english/data/number/zero.tsv"))

        single_digits_graph = pynini.invert(graph_digit | graph_zero)
        self.single_digits_graph = single_digits_graph + (self.INSERT_SPACE + single_digits_graph).star

        if not self.deterministic:
            # for a single token allow only the same normalization
            # "007" -> {"oh oh seven", "zero zero seven"} not {"oh zero seven"}
            single_digits_graph_zero = pynini.invert(graph_digit | graph_zero)
            single_digits_graph_oh = pynini.invert(graph_digit) | pynini.cross("0", "oh")

            self.single_digits_graph = pynutil.add_weight(
                single_digits_graph_zero + (self.INSERT_SPACE + single_digits_graph_zero).star, 1.0
            )
            self.single_digits_graph |= single_digits_graph_oh + (self.INSERT_SPACE + single_digits_graph_oh).star

            single_digits_graph_with_commas = (
                pynini.closure(self.single_digits_graph + self.INSERT_SPACE, 1, 3)
                + (
                    pynutil.delete(",")
                    + single_digits_graph
                    + self.INSERT_SPACE
                    + single_digits_graph
                    + self.INSERT_SPACE
                    + single_digits_graph
                    + (
                        self.INSERT_SPACE
                        + pynutil.delete(",")
                        + single_digits_graph
                        + self.INSERT_SPACE
                        + single_digits_graph
                        + self.INSERT_SPACE
                        + single_digits_graph
                    ).star
                )
            )

        graph = (
            pynini.closure(self.DIGIT, 1, 3)
            + ((pynutil.delete(",") + self.DIGIT**3).star | (self.DIGIT**3).star)
        ) @ graph

        self.graph = graph
        self.graph_with_and = self.add_optional_and(graph)

        if self.deterministic:
            long_numbers = pynini.compose(self.DIGIT ** (5, ...), self.single_digits_graph).optimize()
            self.long_numbers = plurals._priority_union(long_numbers, self.graph_with_and, self.VCHAR.star).optimize()
            cardinal_with_leading_zeros = pynini.compose(pynini.accep("0") + self.DIGIT.star, self.single_digits_graph)
            final_graph = self.long_numbers | cardinal_with_leading_zeros
            final_graph |= self.add_optional_and(graph_au)
        else:
            leading_zeros = pynini.compose(pynini.accep("0").plus, self.single_digits_graph)
            cardinal_with_leading_zeros = (
                leading_zeros + self.INSERT_SPACE + pynini.compose(self.DIGIT.star, self.graph_with_and)
            )
            self.long_numbers = self.graph_with_and | pynutil.add_weight(self.single_digits_graph, 0.0001)
            # add small weight to non-default graphs to make sure the deterministic option is listed first
            final_graph = (
                self.long_numbers
                | pynutil.add_weight(single_digits_graph_with_commas, 0.0001)
                | cardinal_with_leading_zeros
            ).optimize()

            # The fix: +0.0001 here, against upstream's -0.0001, so the
            # unreplaced "one thousand" reading is the cheaper of the two.
            one_to_a_replacement_graph = (
                pynutil.add_weight(pynini.cross("one hundred", "a hundred"), 0.0001)
                | pynutil.add_weight(pynini.cross("one thousand", "thousand"), 0.0001)
                | pynutil.add_weight(pynini.cross("one million", "a million"), 0.0001)
            )
            final_graph |= pynini.compose(
                final_graph,
                one_to_a_replacement_graph.optimize() + self.VCHAR.star,
            ).optimize()
            # remove commas for 4 digits numbers
            four_digit_comma_graph = (self.DIGIT - "0") + pynutil.delete(",") + self.DIGIT**3
            final_graph |= pynini.compose(four_digit_comma_graph.optimize(), final_graph).optimize()

        self.final_graph = final_graph.optimize()
        optional_minus_graph = (self.tag_field("negative", pynini.cross("-", "true")) + self.INSERT_SPACE).ques
        final_graph = optional_minus_graph + self.tag_field("integer", self.final_graph)
        final_graph = self.add_tokens(final_graph)
        self.tagger = final_graph.optimize()
