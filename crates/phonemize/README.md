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
| Chinese (`zh-CN`) | jieba word boundaries → pinyin → IPA (or zhuyin, for v1.1-zh) | `jieba-zh-dict.bin.zst`, 1.63 MB, fetched on `prepare` |
| Japanese (`ja-JP`) | lindera IPADic → katakana → IPA table | `lindera-ipadic-ja.bin.zst`, 8.51 MB, fetched on `prepare` |
| English (`en-US`) | CMU Dict + ARPAbet→IPA, numerals through `num2words` | **none** — 3.75 MB embedded in the wasm |

**English is implemented but not what production speaks.** The extension's Kokoro
engine sends English to `kokoro-js`'s own `generate(text)`, which phonemizes with
its internal espeak — the alignment target the model was trained on, and better
at abbreviations than a dictionary lookup. `phonemize_en` exists because the
Latin runs *inside* Chinese and Japanese sentences need it. Whether English moves
onto it is P6.1 and is not decided.

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
cargo test --workspace              # 170 tests, native, no browser
cargo clippy --all-targets          # must stay at 0 warnings
python3 scripts/gen-ja-ipa-table.py --check
```

`pnpm build` runs the wasm build first through its `prebuild` hook, and CI runs
`cargo test` — the Rust half has tests that nothing else would run.

Three dependencies have **load-bearing `default-features = false`**, each for a
different reason that `Cargo.toml` explains at length: `lindera` (the default
feature is `mmap`, and there is nothing to memory-map), `jieba-rs` (the default
embeds its dictionary through a C `zstd`, which cannot link for
`wasm32-unknown-unknown` on macOS), and `piper-plus-g2p` (the default set pulls
in six other frontends, including a second Japanese pipeline). Turning any of
them back on breaks the build or doubles the module.

## Data (`data/`)

| File | Source | Regenerate with |
|---|---|---|
| `pinyin-chars.txt`, `pinyin-phrases.txt`, `pinyin-special.txt`, `pinyin-syllables.txt` | `pinyin-pro` in `node_modules`, and `pinyin-table.json` | `node scripts/gen-pinyin-pro-data.mjs` (`--check` in CI) |
| `pinyin-table.json` | pypinyin via misaki's `transcription.py` | `python3 scripts/gen-pinyin-table.py` |
| `vocab-v1.txt`, `vocab-v11-zh.txt` | the two models' `tokenizer.json`, recorded in `tests/v0/kokoro-vocabs.json` | `node scripts/gen-kokoro-vocab.mjs` (`--check` in CI) |
| `ja-ipa-table.json` | hand-maintained; the source of truth for the kana table | — |
| `pinyin-NOTICE.txt` | — | MIT notices for `pinyin-pro` and misaki |

`src/frontends/ja_ipa_table.rs` is **generated** from `ja-ipa-table.json` by
`scripts/gen-ja-ipa-table.py`. Do not edit it by hand:
`tests/ja_ipa_table_parity.rs` reads the JSON back and fails if the two differ.

## Test corpora

`tests/fixtures/{zh-parity,zh-frontend-parity,ja-parity}.json` are **frozen
golden files**: the JavaScript pipeline's own output, recorded before phase 8
deleted it. The generators are gone, so the corpora can no longer be regenerated
— they pin the Rust pipeline to what the JavaScript one produced, and that is all
they can do now.
