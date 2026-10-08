# Text normalization (`wetext`)

Weighted-FST text normalization, vendored from `wetext-rs` 0.1.2 and wired up for
all three languages by `crate::tn::engine`. See `NOTICE` in this directory for the
licence and the seven modifications; this file is about *using* it.

Everything below is written from the English side, because English is where it
was first wired up and where the interesting behaviour (abbreviations, and a
3,050-key whitelist with no shape) lives. The other two are the same three-stage
pipeline over different grammars; what they buy and what they cost is in
`tests/wetext_zh.rs` and `tests/wetext_ja.rs`.

## Where it comes from

| | |
|---|---|
| Grammar | `wenet-e2e/WeTextProcessing` (PaddleSpeech's TN), Apache-2.0 |
| Rust port | `SpenserCai/wetext-rs` 0.1.2, Apache-2.0 |
| FST data | the `wetext` Python distribution's own build of the same grammars |
| Here | a copy, not a dependency — the published crate cannot run in `wasm32-unknown-unknown` |

The reason for a copy rather than a `wetext-rs = "0.1"` line: upstream's only
constructor reads a directory, upstream has a defect that makes full-width
numerals normalize to nothing, and the crate is nine stars with one release.
Forking it means maintaining a fork; copying it means the code is ours to keep
building.

## What it normalizes

Eight classes were missing from the hand-written English numeral reader, and they
are what this module is here for (English; the other two have their own tables in
`tests/wetext_zh.rs` and `tests/wetext_ja.rs`):

| In | Out |
|---|---|
| `3:30pm` | `three thirty PM` |
| `50%` | `fifty percent` |
| `1st` | `first` |
| `1/2` | `one half` |
| `2,000` | `two thousand` |
| `Dr. Smith` | `doctor Smith` |
| `$20.50` | `twenty point five dollars` |
| `10/4/2024` | `the fourth of october twenty twenty four` |

## Cost, and what the early exit does *not* cover

Measured in the release wasm, in Node, on the shipped crate (`pnpm build:wasm`,
`--target nodejs`, `Phonemizer` through the whole `prepare` flow):

| | |
|---|---|
| wasm | 5,081,554 -> 6,095,459 B, **+1.01 MB (+19.9%)** — `rustfst`, not this module (~50 KB) |
| FST assets | 707 KB compressed (161,322 + 545,550), fetched on `prepare` like every other dictionary |
| decompress | 24 ms, on `prepare` |
| parse | 70 ms (English, 12.04 MB of FST), on `prepare` |
| hot path | 0.54 ms for `hello world`, 0.97 ms for `I have 3 cats`, 2.25 ms for a 44-character sentence |

The evaluation predicted +2.01 MB and a ~0.001 ms hot path for a sentence with no
digit. Both were wrong, and for the same reason in different directions: the
0.001 ms came from the `should_normalize` bug fixed by modification 5 in
`NOTICE` — the reference normalizes English text whether or not it has a digit in
it, so the tagger *does* run on `hello world` — while the size was measured on a
shell app that linked more of `rustfst` than this crate reaches.

`prepare` is where all of it lands: 94 ms of decompression and parsing, once per
worker, before the first sentence. Every sentence after that pays the table above,
against a synthesis that takes 500-750 ms.

## Known differences from upstream behaviour

- **`normalize` trims.** Upstream trims in both `preprocess` and `postprocess`,
  and this copy does too. Harmless for English and for Japanese, whose pipelines
  collapse whitespace at the end anyway — but it is why this could not be dropped
  into the Chinese pipeline's numeral step unchanged: that step deliberately does
  not trim, and the pipeline has to rely on `collapse_whitespace` at the end
  instead. Verified rather than assumed: see `phonemize_zh`.
- **`full_to_half` moved** (modification 3 in `NOTICE`), so a full-width digit is
  normalized where upstream would skip the TN entirely. It is **on** for English
  and Japanese — the fold a full-width `ＡＢＣ` needs before `text::classify`
  drops it — and off for Chinese, whose fold is the pipeline's
  (`text::to_half_width`, after its punctuation map). See
  `crate::tn::engine::chinese`.
- **`should_normalize` regained its `lang` parameter** (modification 5 in
  `NOTICE`), so English is normalized whether or not it contains a digit, as the
  Python reference does.
- **`should_normalize` tests digits with `char::is_numeric`**, not
  `is_ascii_digit` (modification 7 in `NOTICE`). The narrower test is a faithful
  reading of nothing: the reference's `\d` is Unicode category `Nd`, and the
  difference only ever reaches the two languages that were added later. Before
  the fix this copy agreed with `pip install wetext==0.1.8` on 45 of 48 Chinese
  probes and 23 of 29 Japanese ones; after it, 47 and 29. With `full_to_half` on,
  the full-width digits that motivated it are folded before the test sees them, so
  what it still covers is the `Nd` characters the fold does not touch — measured
  to be passed through unchanged by these grammars, and pinned in
  `tests/wetext_zh.rs` so the branch cannot be deleted as dead code.

## Path selection, and the bug that used to be here

The one-best path used to come out of `rustfst::shortest_path`. With its default
`nshortest = 1` that is `single_shortest_path`: a relaxation loop whose queue
comes from `AutoQueue`, which picks the discipline from the FST's *structure* —
LIFO when it is unweighted, the SCC condensation's order when it is acyclic,
per-SCC queues otherwise — and never from the sign of the weights. So it returned
*a* path, not the cheapest one, and these grammars are full of negative weights:
upstream ranks competing readings with `pynutil.add_weight(..., -0.0001)`, and a
composed FST reaches `-0.0001`. Modification 6 in `NOTICE` replaced it with the
copy's own Bellman-Ford relaxation over the composed FST; the full write-up,
including the two independent shortest-path computations that established the
defect and the enumeration below, is in `NOTICE`. `push_weights` was tried
and does not help: it normalises the total weight without changing which reading
is chosen.

Every reading of the composed FST for `cardinal { integer: "123" }`, with its
cost — this is the case the old write-up in this file got wrong:

| cost | reading |
|---|---|
| 0.000000 | `one hundred and twenty three` ← the minimum |
| 0.000100 | `one twenty three` |
| 0.000100 | `a hundred and twenty three` |
| 0.000110 | `one hundred twenty three` |
| 0.000200 | `one two three` ← what `shortest_path` returned |
| 0.000210 | `a hundred twenty three` |
| 1.000200 | `one two three` |

The rows the fix moved, measured through the whole engine:

| input | before | after |
|---|---|---|
| `I have 123 apples.` | `one two three apples` | `one hundred and twenty three apples` |
| `There are 100 people.` | `one oh oh people` | `one hundred people` |
| `Total 1,234 items.` | `one two three four items` | `thousand two hundred and thirty four items` |
| `About 1000000 people.` | `one oh oh oh oh oh oh people` | `one million people` |
| `It is 250 km away.` | `two hundred fifty kilometers` | `two hundred and fifty kilometers` |
| `Call 555-1234.` | `five hundred fifty five minus …` | `five hundred and fifty five to …` |
| `Between 100 and 200 people.` | `one oh oh and two hundred people` | `one hundred and two hundred people` |

7 of 18 probe sentences changed and 11 did not — `3:30pm`, `50%`, `1st`, `1/2`,
`2024`, `2,000`, `42` and `007` among them. `Call 555-1234.` moves further than
the `and`: the tagger reads `555-1234` as a `range`, and the cheapest
verbalization of a range is `… to …` at `-0.000100`, where the telephone reading
`… minus …` sits at `0.000000`. The plan's table wrote that row's expected
column with `minus`, which was the shipped reading's, not the minimum's.

### The one bare number that is still wrong, and is not this bug

`1000` reads `ten hundred`. The tagger tags it `date { year: "1000" }`, and the
grammar offers `ten hundred` and `one thousand` at the **same** cost, `0.000100`;
the Python reference picks `ten hundred` too. That one is a tie in the grammar,
and it is deliberately left alone.

### What this section used to say

It claimed the grammar had several *equal-cost* readings for a bare digit string
and that each FST library broke the tie its own way (`fst_utils.py` says
something similar about pynini and kaldifst). For `123` that is false: the
readings differ in cost and the cardinal is strictly the cheapest. The 41 inputs
it reported as "34 agree, the rest are ties" were probed against
`pip install wetext==0.1.8` **before modification 6**, so the differences it
counted were this bug; the probe was a one-off and is not committed, so no
agreement count is claimed here now. The probe is not committed; what is *pinned*
is every row of the tables above, in `crates/phonemize/tests/wetext_en.rs`.

What it means for this crate: the engine is markedly better than the hand-written
reader on *entities* — `3:30pm`, `50%`, `1st`, `1/2`, `2,000`, `10/4/2024`,
`$20.50` — and it reads a bare integer as its cardinal, `one hundred and twenty
three` where `num2words` says `one hundred twenty three`. The English pipeline
prefers the engine, and the tests pin the readings so
neither half can change quietly.
