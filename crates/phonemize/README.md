# `phonemize`

Text → phonemes (IPA) for SayLoud's on-device Kokoro voices, compiled to a single
wasm module and run in a dedicated worker.

This crate is the **whole** of text preprocessing: number reading, punctuation
normalisation, script segmentation, dictionary lookup, G2P, and the vocabulary
gate. It replaced a JavaScript chain (kuromoji + kuroshiro + jieba + espeak +
pinyin-pro) that phase 8 deleted; see
`docs/phonemization-architecture.md` for where it sits in the extension and
`docs/superpowers/plans/2026-10-03-p6-rust-phonemize-spec.md` for why it exists.

## What it does, and what it deliberately does not

| Language | How | Dictionary |
|---|---|---|
| Chinese (`zh-CN`) | **WeText numerals** (fallback: `numbers_to_han`) → jieba word boundaries → pinyin → **tone sandhi and erhua** → IPA (or zhuyin, for v1.1-zh) | `jieba-zh-dict.bin.zst`, 1.63 MB, plus `wetext-zh-tn-{tagger,verbalizer}.bin.zst`, 160 KB, both fetched on `prepare` |
| Japanese (`ja-JP`) | **WeText numerals** (fallback: `numbers_to_kanji`) → lindera IPADic → katakana → IPA table | `lindera-ipadic-ja.bin.zst`, 8.51 MB, plus `wetext-ja-tn-{tagger,verbalizer}.bin.zst`, 63 KB, both fetched on `prepare` |
| English (`en-US`) | **WeText numerals** (fallback: `numbers_to_english`) → CMU Dict → **NRL 7948 letter-to-sound rules** for a word it lacks → ARPAbet→IPA | `wetext-en-tn-{tagger,verbalizer}.bin.zst`, 707 KB, fetched on `prepare` — the pronunciation dictionary itself is 3.75 MB compiled in, and the rules 17 KB more |

**Since phase 10 English is what production speaks, like the other two.** The
Kokoro engine used to send English to `kokoro-js`'s own `generate(text)`, which
phonemized with its internal espeak — a *second* front end running over words this
crate had already phonemized, and one whose IPA never matched the token count the
sentence was cut with. All three languages now reach the model as IPA through
`generate_from_ids()`. The trade that came with it is real and documented
(en-GB voices have no variant of their own here, and espeak read a few classes
better): `docs/superpowers/plans/p6-phase10-english.md` §四 has the comparison and
§五 the gaps, and **the listening test has not been done**.

Phase 9A gave the words that CMU dictionary does not have a reading instead of a
spelling. Until it, `GitHub` was `dʒˈiː aɪ tˈiː ˈeɪtʃ jˈuː bˈiː` — six letters read
as six letters — and a mixed-case proper noun is exactly what a dictionary of
common English does not have. It now goes through the letter-to-sound rules of NRL
Report 7948 as HeadTTS adapted them
(`src/backends/headtts_en/`, MIT): `GitHub` → `ɡɪθəb`, `TypeScript` →
`tɪpɛskɹɪpt`, `Kokoro` → `kɑkɔɹoʊ`. Three layers, in this order — **the dictionary,
then the rules, then the letters** — because the dictionary is the only one of the
three that is a transcription rather than a reading, and because the last layer is
what used to happen and must keep happening for anything the other two refuse.

Two things the rules are **not** asked to do. An all-capitals run is an initialism
and is spelled (`HTTP` → `ˈeɪtʃ tˈiː tˈiː pˈiː`), which is the phase 4 capitals
rule and is not overridden by the engine that offers `ttp` for it. And a run with
no `A`/`E`/`I`/`O`/`U` in it never reaches the rules at all, because `xyz` → `sɪz`
and `sql` → `skl` are what a spelling oracle answers when it is handed a word that
is not one; the letters are more informative there. The rule table is 309 entries —
the "7948" is the report's number, not its size — and it is `const` data: no
fetched asset, 17,385 B of wasm, and no second dictionary. The measurements, the
quality comparison (including the readings that are wrong and were kept) and the
list of what was deliberately not ported are in
`docs/superpowers/plans/p6-9a-headtts-integration.md`.

Phase 9B replaced the English *numeral* step with weighted FSTs vendored from
WeTextProcessing (`src/backends/wetext/`), which reads dates, times, money,
percentages, ordinals and abbreviations where the hand-written reader read a
number and left the rest. It costs 1 MB of wasm and 707 KB of fetched grammars.
Until phase 9B.4 it was also measurably **worse at a bare integer** — `123` came
out `one two three` where `num2words` says `one hundred twenty three` — and that
was written up as the grammar having several equal-cost readings for one. It was
not: the grammar's cheapest reading of `123` is `one hundred and twenty three`,
and the copy's path extraction, `rustfst::shortest_path`, was returning a path
**more expensive** than the minimum because these grammars carry negative arc
weights that it does not handle. The copy now computes the minimum itself (see
`src/backends/wetext/text_normalizer.rs`); the case is written up in
`docs/superpowers/plans/p6-9b4-shortest-path-bug.md`. `1000` still reads
`ten hundred`, which is the grammar's own tie and not the extraction's. Both
halves are pinned by tests and written up in that module's `README.md`; the
hand-written reader is still there as the fallback for a caller that never called
`prepare`.

Phase 9B.6 put a **gate** in front of that engine
(`src/backends/tn_gate.rs`), because 92% of its cost is the tagger FST and the
tagger runs on every English sentence whether or not there is anything in it to
tag — upstream's English TN is deliberately not gated on digits
(`should_normalize` has `lang != "en"` on that branch). The gate is a
hand-written byte scan for the shapes TN can rewrite: an ASCII digit, a symbol
from upstream's `whitelist/symbol.tsv`, a capital run, a terminated abbreviation,
and a short list of dot-less abbreviations whose reading changes (`Mon` →
`Monday`, `Mr` → `Mister`). It costs **2.8 µs for 950 characters** where the
composition it replaces costs 43 ms, and **+977 B** of wasm, which is why it is a
scan and not a `regex`.

Saying "skip" is a promise that TN would have returned the text unchanged, so
the promise is asserted rather than assumed: `tests/tn_gate.rs` holds a 70-entry
corpus against the shipped grammars and checks that a skip implies (a) the tagger
found nothing but its two pass-through classes, (b) the normalizer left the text
alone, and (c) the phonemes through `phonemize_en` do not depend on whether the
engine was asked. It is a filter, not a second opinion about what needs
normalizing, and that test is what keeps it from becoming one. **Deleting the
gate costs speed and nothing else** — the invariant tests have no subject without
it, and every one of them passes vacuously — so the failure mode of removing it
is the 33 ms/710 characters, not wrong audio. What the gate *can* get wrong is
the other direction, and it does: the grammar's whitelist is 3,050 strings with
no shape at all, so a proper noun in it that the pipeline would have respelled is
skipped. That is measured, quantified and written up in
`docs/superpowers/plans/p6-9b6-tn-gate.md` §四; the short version is 1,127 missed
keys, 182 of them audible, and 0 misses over 127 sentences of real prose.

Phase 9D added the last step of the Chinese pipeline: **Mandarin tone sandhi and
the erhua coda** (`src/backends/tone_sandhi/`, ported from PaddleSpeech's
`ToneSandhi` and `_merge_erhua`). `pinyin-pro` gives one tone per character and
Mandarin does not pronounce them as written — 你好 is *ní hǎo*, 一个 is *yí ge*,
and the 儿 of 玩儿 is not a syllable but a coda on the one before it (`wanr2`,
`wa↗nɻ`). The rules read jieba's words *and its part-of-speech tags*, so they also
decide the word boundaries the tokenizer sees, and `Plan::word_lengths` is how
that reaches the spacing.

Two things about it are worth knowing before touching it. **It is switchable**:
`pipeline::ToneRules` has an `Off` that is the phase 6 pipeline byte for byte,
and the corpus in `tests/fixtures/zh-frontend-parity.json` is pinned through it —
because P5 §1.5 argues the v1.0 voices were trained *without* these rules and the
only way to keep that decision reversible is to keep the old path runnable and
tested. `lib.rs` passes `On`; see
`docs/superpowers/plans/p6-9d-tone-sandhi-erhua.md` §八 for both sides of it.
**And it was verified against the reference rather than against a reading of
it**: PaddleSpeech's `ToneSandhi` was imported and driven with `pypinyin` and
jieba's `posseg` on 466 sentences, which found **0 rule differences** and 13
sentences that differ because the two engines' dictionaries do (listed in that
document). The three places this port deliberately answers differently are in its
§五, each pinned by a test.

Phase 9E wired the same WeText engine up for **Chinese and Japanese numerals**
(`src/backends/wetext_tn.rs`), so all three languages read a year as a year, a
clock time as a clock time and a phone number digit by digit rather than through
three hand-written readers that each only ever matched a digit. It is the
smallest of the phases — **+1,459 B** of wasm, because the FST engine arrived in
9B and is shared, against 223 KB of fetched grammars for both languages combined
— and the only one that had to change the vendored copy: `should_normalize`
tested digits with `is_ascii_digit` where the reference's `\d` is Unicode-wide, and
`０` is U+FF10, so **every full-width numeral in a Chinese or Japanese sentence
skipped the normalizer entirely** and came out as the digits it was written with.
That could not reach English (the branch it guards is `lang != En`), which is why
it survived from 9B to 9E. Modifying it brought this copy from 45/48 to **47/48**
agreement with `pip install wetext==0.1.8` on Chinese probes and from 23/29 to
**29/29** on Japanese ones.

The three hand-written readers stayed, as `Option<&Normalizer>`'s `None`: the
same argument as `ToneRules`, and the same reason the JavaScript parity corpus is
still a test of anything. `docs/superpowers/plans/p6-9e-cjk-text-normalization.md`
has the delta tables — including the two readings this made *worse* (`０１２３` and
a lone `０`) — and the three places the task's description did not match the tree.

## Two rules the rest of the crate is shaped by

1. **The vocabulary gate is a gate, not a warning.** The tokenizer's normaliser
   is a `Replace` with an empty string: a phoneme outside the model's vocabulary
   is *deleted*, silently. ガ行 once came out as ア行 because the kana table wrote
   an ASCII `g` where the vocabulary has `ɡ` (U+0261), and nothing reported it.
   `vocab.rs` refuses instead.
2. **There is no filesystem and no network in here.** `wasm32-unknown-unknown` has
   neither, so every byte the pipeline needs arrives through `load_dictionary`,
   and everything else is `include_str!`'d at build time.

## Using it

From Rust — the shape `cargo test` uses, and the reason the pipeline is callable
without a browser at all:

```rust
use phonemize::{PhonemizeOptions, Phonemizer};

let mut phonemizer = Phonemizer::new();
phonemizer
    .load_dictionary("lindera-ipadic-ja", &compressed)
    .unwrap_or_else(|_| panic!("the asset loads"));
phonemizer
    .finish_loading()
    .unwrap_or_else(|_| panic!("the asset is complete"));

let options = PhonemizeOptions {
    frontend: "kokoro-v1".to_string(),
    lang: "ja-JP".to_string(),
};
let result = phonemizer.phonemize_with("こんにちは", &options)?;
```

`phonemize_with`, not `phonemize`: the `#[wasm_bindgen]` methods are the boundary
and speak in `JsValue` — `phonemize(text, options)` is what the extension calls,
through the wrapper — while `phonemize_with` takes a `PhonemizeOptions` and
returns a `PhonemizeResult`. Keeping the pipeline callable from a native test is
the whole reason the parity corpora can run under `cargo test`.

From TypeScript, use the wrapper rather than the generated bindings:
`lib/models/phonemize-rust.ts` owns the dictionary URLs, the Cache Storage
entries and the per-`(frontend, lang)` preparation state, and exposes the three
methods callers actually want (`ready`, `prepare`, `phonemize`). The generated
`Phonemizer` is the layer below it and knows nothing about where bytes come from
— by design (spec §3.2), so that a change of dictionary format is not a change of
JavaScript.

## Building and testing

```bash
./scripts/build-phonemize-wasm.sh   # wasm-pack → lib/models/phonemize-wasm/
cargo test --workspace              # 280 tests, native, no browser
cargo clippy --all-targets          # must stay at 0 warnings
python3 scripts/gen-ja-ipa-table.py --check
```

`pnpm build` runs the wasm build first through its `prebuild` hook, and CI runs
`cargo test` — the Rust half has tests that nothing else would run.

Four dependencies have a **load-bearing feature setting**, each for a different
reason that `Cargo.toml` explains at length: `lindera` and `jieba-rs` need
`default-features = false` (the default features are `mmap` and a C `zstd` that
cannot link for `wasm32-unknown-unknown` on macOS), `piper-plus-g2p` needs it
too (the default set pulls in six other frontends, including a second Japanese
pipeline), and `rustfst` needs its default features left **on** — the default is
`state-label-u32`, and turning it off changes the label type the vendored WeText
engine casts to UTF-8 bytes. Changing any of the four breaks the build or reads
the text wrong.

A fifth dependency, `getrandom`, is not called by anything here: it arrives with
`rustfst`'s FST writer and refuses to compile for `wasm32-unknown-unknown` unless
`.cargo/config.toml` names a backend and a direct dependency turns the matching
feature on. That is the fourth time a dependency has not crossed the wasm
boundary as published, and the first with a `cfg` for a fix rather than a swap.

## Data (`data/`)

| File | Source | Regenerate with |
|---|---|---|
| `pinyin-chars.txt`, `pinyin-phrases.txt`, `pinyin-special.txt`, `pinyin-syllables.txt` | `pinyin-pro` in `node_modules`, and `pinyin-table.json` | `node scripts/gen-pinyin-pro-data.mjs` (`--check` in CI) |
| `pinyin-table.json` | pypinyin via misaki's `transcription.py` | `python3 scripts/gen-pinyin-table.py` |
| `vocab-v1.txt`, `vocab-v11-zh.txt` | the two models' `tokenizer.json`, recorded in `tests/v0/kokoro-vocabs.json` | `node scripts/gen-kokoro-vocab.mjs` (`--check` in CI) |
| `ja-ipa-table.json` | hand-maintained; the source of truth for the kana table | — |
| `pinyin-NOTICE.txt` | — | MIT notices for `pinyin-pro` and misaki |

The English rule table is **not** here either: it lives in
`src/backends/headtts_en/rules.rs`, generated by
`node scripts/gen-headtts-rules.mjs` (`--check` in CI as `pnpm check:headtts`)
from `tests/fixtures/headtts-en-parity.json`. That fixture is not a golden file
of this repository's making — `scripts/headtts-parity.mjs` dumps it by running
upstream HeadTTS, and `tests/headtts_en.rs` checks both the 309 rules and the 296
words against it. It also holds the upstream revision and module SHA-256, which
`rules.rs` quotes in its own header.

The four word lists of phase 9D are **not** here: they are verbatim upstream data
rather than something generated, so they live in
`src/backends/tone_sandhi/tables.rs` with that directory's `NOTICE`.

`src/frontends/ja_ipa_table.rs` is **generated** from `ja-ipa-table.json` by
`scripts/gen-ja-ipa-table.py`. Do not edit it by hand:
`tests/ja_ipa_table_parity.rs` reads the JSON back and fails if the two differ.

## Test corpora

`tests/fixtures/{zh-parity,zh-frontend-parity,ja-parity}.json` are **frozen
golden files**: the JavaScript pipeline's own output, recorded before phase 8
deleted it. The generators are gone, so the corpora can no longer be regenerated
— they pin the Rust pipeline to what the JavaScript one produced, and that is all
they can do now.
