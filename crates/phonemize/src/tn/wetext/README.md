# Text normalization (`wetext`)

Weighted-FST text normalization, vendored from `wetext-rs` 0.1.2 and wired up for all three languages by `crate::tn::engine`. See `NOTICE` in this directory for the licenses and the list of modifications.

## Sources

| Component | Upstream | License |
|---|---|---|
| Grammar | `wenet-e2e/WeTextProcessing` (PaddleSpeech TN) | Apache-2.0 |
| Rust port | `SpenserCai/wetext-rs` 0.1.2 | Apache-2.0 |
| FST data | the Python `wetext` distribution's build of the same grammars | see `public/dictionaries/wetext-*-tn-NOTICE.txt` |
| Contraction tables (`data/*.json`) | Python `contractions` 0.1.73, unchanged | MIT, see `data/contractions-NOTICE.txt` |

This is a copy rather than a dependency. The published crate cannot run in `wasm32-unknown-unknown`: its only constructor reads a directory. It also has defects this copy fixes, listed in `NOTICE`.

## What it normalizes

Eight entity classes (English examples; see `tests/wetext_zh.rs` and `tests/wetext_ja.rs` for other languages):

| Input | Output |
|---|---|
| `3:30pm` | `three thirty PM` |
| `50%` | `fifty percent` |
| `1st` | `first` |
| `1/2` | `one half` |
| `2,000` | `two thousand` |
| `Dr. Smith` | `doctor Smith` |
| `$20.50` | `twenty point five dollars` |
| `10/4/2024` | `the fourth of october twenty twenty four` |

## Cost

Measured in release wasm on Node (`pnpm build:wasm`, `--target nodejs`):

| Metric | Impact |
|---|---|
| Wasm size | +1.01 MB (+19.9%): 5.08 MB → 6.10 MB (mostly `rustfst`, not this module) |
| FST assets | 707 KB compressed (tagger 161 KB + verbalizer 546 KB), fetched on `prepare` |
| Decompress | 24 ms (one-time, on `prepare`) |
| Parse | 70 ms for English (12.04 MB FST, on `prepare`) |
| Per-sentence | 0.54 ms (`hello world`), 0.97 ms (`I have 3 cats`), 2.25 ms (44 chars) |

All decompression and parsing happens during `prepare`, once per worker. Each sentence after that pays 0.5–2.3 ms against 500–750 ms synthesis time.

## Key Differences from Upstream

- **`normalize` trims** in both `preprocess` and `postprocess`, as upstream does. English and Japanese collapse whitespace afterwards anyway. Chinese's numeral step does not trim, so `phonemize_zh` relies on `collapse_whitespace` at the end.

- **`full_to_half` moved** (modification 3 in `NOTICE`) so full-width digits are normalized. Enabled for English and Japanese (folds `ＡＢＣ` before classification); disabled for Chinese (which has its own fold after punctuation mapping).

- **`should_normalize` tests `lang`** (modification 5 in `NOTICE`). English normalizes all text (not just sentences with digits), matching Python reference behavior.

- **`should_normalize` uses `char::is_numeric`**, not `is_ascii_digit` (modification 7 in `NOTICE`), matching Python's `\d` (Unicode `Nd`). Agreement with `pip install wetext==0.1.8` is 47/48 on Chinese probes and 29/29 on Japanese ones. With `full_to_half` on, full-width digits are folded before this test, so it now covers the `Nd` characters no fold touches; `tests/wetext_zh.rs` pins that.

- **`fix_contractions` runs for both apostrophes** (modification 8 in `NOTICE`). Upstream's guard is `"'" in text`, so a sentence with only `’` never reaches the tables and their `’` keys are unreachable. The guard here is `contractions::has_apostrophe`, which accepts `'` and `’`. The tables are also scanned in a fixed order, so overlapping keys always resolve the same way (`We'll go` → `we will go`).

- **Contraction matching uses one `AhoCorasick` automaton** (modification 9 in `NOTICE`), the same kind of engine as the Python reference's `TextSearch`. It builds in 0.73 ms / 89 KB, during `prepare`. See `contractions.rs` for the matching rule (leftmost, then longest, among accepted matches) and where it deliberately differs from upstream.

## Path Selection

The one-best path comes from this copy's own Bellman-Ford relaxation over the composed FST (modification 6 in `NOTICE`), not from `rustfst::shortest_path`. `shortest_path` picks its queue discipline from the FST's structure and ignores weight signs, so on these grammars, which rank readings with negative weights (`pynutil.add_weight(..., -0.0001)`), it can return a path that is not the cheapest. `push_weights` does not help: it changes the total weight, not which reading wins.

Every reading of the composed FST for `cardinal { integer: "123" }`:

| Cost | Reading |
|---|---|
| 0.000000 | `one hundred and twenty three` ← returned |
| 0.000100 | `one twenty three` |
| 0.000100 | `a hundred and twenty three` |
| 0.000110 | `one hundred twenty three` |
| 0.000200 | `one two three` |
| 0.000210 | `a hundred twenty three` |
| 1.000200 | `one two three` |

Readings through the whole engine:

| Input | Output |
|---|---|
| `I have 123 apples.` | `one hundred and twenty three apples` |
| `There are 100 people.` | `one hundred people` |
| `Total 1,234 items.` | `thousand two hundred and thirty four items` |
| `About 1000000 people.` | `one million people` |
| `It is 250 km away.` | `two hundred and fifty kilometers` |
| `Call 555-1234.` | `five hundred and fifty five to …` |
| `Between 100 and 200 people.` | `one hundred and two hundred people` |

`Call 555-1234.` reads as a range (`… to …`, cost −0.000100), which is cheaper than the telephone reading (`… minus …`, 0.000000). These readings are pinned in `crates/phonemize/tests/wetext_en.rs`.

### Known incorrect reading

`1000` → `ten hundred`. The tagger produces `date { year: "1000" }`, and the grammar offers `ten hundred` and `one thousand` at **equal cost** (0.000100). The Python reference also picks `ten hundred`. This is a tie in the grammar, and it is left alone.
