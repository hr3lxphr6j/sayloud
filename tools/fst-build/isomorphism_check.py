#!/usr/bin/env python3
"""Are two FSTs the same graph with a different state numbering?

`pynini.equivalent` refuses non-epsilon-free non-deterministic acceptors, which
the raw TN taggers are, and determinising 157k states to satisfy it would renumber
both sides and prove nothing about the *saved* graphs. Color refinement
(Weisfeiler-Lehman) answers the question directly and cheaply:

    color(v) = hash( final_weight(v), sorted[ (ilabel, olabel, weight, color(next)) ] )

Iterate until the multiset of colors stops changing, then compare the multisets
and the start state's color. Handles arc multiplicities, parallel arcs and
weights; converges in a handful of rounds on these graphs.

A match is strong evidence of isomorphism (not a proof — refinement is
incomplete in general), and it is the claim docs/superpowers/REPORT.md makes about the
conda-forge English build.

Usage:
    python isomorphism_check.py shipped/en/tn/tagger.fst out/en/tn/tagger.fst
"""

from __future__ import annotations

import hashlib
import sys

import pynini

INF = float("inf")


def load(path: str):
    fst = pynini.Fst.read(path)
    outs = {}
    for state in fst.states():
        final = float(str(fst.final(state)))
        arcs = [
            (arc.ilabel, arc.olabel, float(str(arc.weight)), arc.nextstate)
            for arc in fst.arcs(state)
        ]
        outs[state] = (final if final != INF else None, arcs)
    return fst.start(), outs


def refine(start, graph, rounds: int = 12):
    """Return the sequence of colour multisets, one per refinement round."""
    colors = {state: 0 for state in graph}
    history = []
    for _ in range(rounds):
        signature = {}
        for state, (final, arcs) in graph.items():
            parts = [str(final)] + sorted(
                f"{ilabel}:{olabel}:{weight!r}:{colors[nextstate]}"
                for ilabel, olabel, weight, nextstate in arcs
            )
            signature[state] = hashlib.sha256("|".join(parts).encode()).hexdigest()
        # Rank the signatures so the next round hashes small integers (cheap, and
        # it makes the multiset comparable across the two graphs).
        ranking = {sig: index for index, sig in enumerate(sorted(set(signature.values())))}
        colors = {state: ranking[sig] for state, sig in signature.items()}
        counts = sorted(__import__("collections").Counter(colors.values()).items())
        history.append((counts, colors[start]))
    return history


def main(argv: list[str]) -> int:
    if len(argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    left = refine(*load(argv[1]))
    right = refine(*load(argv[2]))
    for round_index, ((counts_a, start_a), (counts_b, start_b)) in enumerate(
        zip(left, right), start=1
    ):
        same = counts_a == counts_b and start_a == start_b
        print(
            f"round {round_index}: classes {len(counts_a)} vs {len(counts_b)}, "
            f"start colour {start_a} vs {start_b} -> {'same' if same else 'DIFFERENT'}"
        )
        if not same:
            return 1
    print("isomorphic under state renumbering: colours agree at every refinement round")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
