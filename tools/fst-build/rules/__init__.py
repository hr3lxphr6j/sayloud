# Copyright 2026 SayLoud contributors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# The single injection point into upstream WeTextProcessing.
#
# Upstream `Normalizer.build_tagger_and_verbalizer` hands one ordered list of
# `RuleSpec`s to `self.tagger_union(rules)` and `self.verbalizer_union(rules)`
# (see `tn/*/normalizer.py`); both are `Processor` staticmethods. Mixing this
# class in front of a normalizer lets us swap rule *classes* by name
# (`REPLACE`) and append ours (`LOCAL_RULES`) without copying upstream's rule
# inventory, so a submodule bump keeps flowing into the build.
#
# `REPLACE` is keyed by `type(spec.rule).__name__` — upstream's own class name,
# not ours. If upstream renames or drops a replaced rule the build fails loudly
# instead of silently building without the fix.
#
# Both lists started empty on purpose: the exit criterion for wiring
# the mixin is byte-identical output. `localize_calls()` exists so `build.py`
# can prove the hook actually ran — `cache_dir=False` is what keeps it from
# loading a cached bundle that would bypass this module entirely.

from tn.processor import RuleSpec

from .en_money_cents import MoneyCents
from .en_section import Section
from .en_slash import AllDay
from .en_symbols import Symbols
from .en_roman import RomanContext
from .en_version import Version
from .ja_numbers import Postal
from .ja_numbers import Telephone as JapaneseTelephone
from .zh_grouped import Grouped

_CALLS = 0


def localize_calls() -> int:
    return _CALLS


# English only. A rule belongs to the language whose grammar reads the text, and
# the mixin is shared by all three normalizers — adding these to the base class
# made the Chinese grammar read `$20.50` as "twenty dollars and fifty cents"
# instead of 二十点五零美元, because a 0.5-weight English rule outranks the
# Chinese money rule.
EN_RULES: tuple = (
    # Roman numerals in the contexts that disambiguate them.
    # Money with cents, beside upstream's money rule (0.5 beats 1.0
    # where both match; the shapes do not overlap anywhere else), and the
    # symbols upstream's table does not read.
    RuleSpec(RomanContext(), 1.0),
    RuleSpec(MoneyCents(), 0.5),
    RuleSpec(Symbols(), 0.5),
    # The shapes upstream reads as something else — a version chain, the
    # `24/7` idiom, and `§` with its section number written against it. Each one
    # overlaps the rule that currently claims the span (serial/decimal, fraction,
    # whitelist), so 0.5 is what makes ours win there and nowhere else.
    RuleSpec(Version(), 0.5),
    RuleSpec(AllDay(), 0.5),
    RuleSpec(Section(), 0.5),
)

# Japanese. The two identifier shapes, weighted against the `Cardinal` phone
# branch (1.06) and the `Math` rule (90) that read them as quantities today.
JA_RULES: tuple = (
    RuleSpec(JapaneseTelephone(), 0.5),
    RuleSpec(Postal(), 0.5),
)

# Chinese. Thousands separators, which no rule claims today (the digits and the
# comma are read as separate `Math`/`Char` tokens).
ZH_RULES: tuple = (RuleSpec(Grouped(), 0.5),)


class LocalRulesMixin:
    LOCAL_RULES: tuple = ()
    REPLACE: dict = {}

    def tagger_union(self, specs):
        global _CALLS
        _CALLS += 1
        return super().tagger_union(self._localize(specs))

    def verbalizer_union(self, specs):
        global _CALLS
        _CALLS += 1
        return super().verbalizer_union(self._localize(specs))

    def _localize(self, specs):
        seen, out = set(), []
        for spec in specs:
            name = type(spec.rule).__name__
            if name in self.REPLACE:
                seen.add(name)
                out.append(RuleSpec(self.REPLACE[name](), spec.tagger_weight, spec.verbalize))
            else:
                out.append(spec)
        assert seen == set(self.REPLACE), f"upstream changed its rule inventory: {set(self.REPLACE) - seen}"
        return out + list(self.LOCAL_RULES)
