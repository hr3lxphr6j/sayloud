# `phonemize`

Text → phonemes (IPA) for SayLoud's on-device Kokoro voices, compiled to a single wasm module and run in a dedicated worker.

This crate handles all text preprocessing: number reading, punctuation normalization, script segmentation, dictionary lookup, G2P, and vocabulary validation. It exposes three languages (en-US, ja-JP, zh-CN) through a unified `phonemize(text, options)` interface.

## Architecture

Three pipeline stages, each in its own directory:

| Stage | Path | Purpose |
|---|---|---|
| **Text Normalization** | `src/tn/` | Numerals, dates, times, symbols → words. Uses WeText FSTs for all three languages. |
| **G2P** | `src/g2p/{en,ja,zh}/` | Words → phonemes. CMU Dict + NRL rules (en), lindera + kana table (ja), jieba + pinyin + tone sandhi (zh). |
| **Pipeline** | `src/pipeline.rs` | Per-language orchestration, error/warning types. |

Supporting modules at the top level:

- `lib.rs` — wasm boundary
- `dictionary.rs` — lazy-loading protocol for compressed dictionaries
- `vocab.rs` — vocabulary gate (rejects phonemes outside the model's vocabulary)
- `text.rs`, `kana.rs`, `types.rs` — shared primitives

## Language Pipelines

| Language | Steps | Dictionaries |
|---|---|---|
| **Chinese** (`zh-CN`) | traditional→simplified → WeText numerals → punctuation map → full-width fold → jieba → pinyin → tone sandhi & erhua → IPA | `jieba-zh-dict.bin.zst` (1.63 MB), `wetext-zh-tn-{tagger,verbalizer}.bin.zst` (160 KB), `wetext-zh-tn-traditional-to-simple.bin.zst` (25 KB) |
| **Japanese** (`ja-JP`) | punctuation map → full-width fold → WeText numerals → lindera → katakana → IPA table | `lindera-unidic-ja.bin.zst` (34.16 MB), `wetext-ja-tn-{tagger,verbalizer}.bin.zst` (63 KB), `wetext-tn-full-to-half.bin.zst` (956 B) |
| **English** (`en-US`) | contractions → punctuation map → full-width fold → WeText numerals → CMU Dict → NRL 7948 rules → ARPAbet→IPA | `wetext-en-tn-{tagger,verbalizer}.bin.zst` (707 KB), `wetext-tn-full-to-half.bin.zst` (956 B) — dictionary and rules compiled in (3.75 MB + 17 KB) |

All three languages reach the Kokoro model through `generate_from_ids()` with IPA tokens. en-GB voices have no variant of their own, and the English path has not had a listening test.

### Numerals require the engine

The WeText engine is the only numeral reader. A sentence containing something only the engine can read (a digit, a symbol the grammar maps to a word, a full-width form) is declined with `dictionary-not-loaded` if `prepare` has not been called, rather than read with the numeral missing. Contractions, capital runs and abbreviations are still read without the engine, just less well. The exact line is `src/tn/gate.rs::drops_without_engine`.

### English Word Reading

Three layers, in priority order:

1. **CMU Dictionary**
2. **NRL 7948 letter-to-sound rules** for words the dictionary lacks (`src/g2p/en/headtts/`, adapted from HeadTTS, MIT): `GitHub` → `ɡɪθəb`, `Kokoro` → `kɑkɔɹoʊ`
3. **Letter names** for anything the first two refuse

Two kinds of word skip the rules and are spelled:
- An all-capitals run is an initialism: `HTTP` → `ˈeɪtʃ tˈiː tˈiː pˈiː`.
- A run with no `A`/`E`/`I`/`O`/`U` never reaches the rules, because they would answer `xyz` → `sɪz`.

The rule table is 309 entries of `const` data (17,385 B of wasm, no fetched asset). Its known wrong readings and what was not ported are in `src/g2p/en/headtts/` and its `NOTICE`.

### English Text Normalization Gate

A hand-written byte scanner (`src/tn/gate.rs`) skips the WeText engine for sentences containing no digits, mapped symbols, capital runs, abbreviations, apostrophes, or full-width characters. Costs **2.8 µs/950 chars** where the engine costs 43 ms.

Invariant: if the gate says skip, the normalizer would have returned the text unchanged. `tests/tn_gate.rs` checks this over a 70-entry corpus. Removing the gate costs only speed.

Known gap: the grammar's whitelist is 3,050 strings with no common shape, so the gate skips 1,127 of its keys. 182 of those change the phonemes. Over 127 sentences of real prose there were 0 misses.

### Chinese Tone Sandhi

Mandarin tone sandhi and erhua rules (`src/g2p/zh/tone_sandhi/`) ported from PaddleSpeech. Uses jieba word boundaries and part-of-speech tags to determine:
- Tone changes (你好 → *ní hǎo*, 一个 → *yí ge*)
- Erhua coda merging (玩儿 → `wanr2`, `wa↗nɻ`)

Switchable via `pipeline::ToneRules::Off` to preserve byte-for-byte parity with v1.0 voices (trained without these rules). Current default is `On`.

## Core Rules

1. **Vocabulary gate is strict.** Phonemes outside the model's vocabulary are rejected, not replaced. This catches mismatches like ASCII `g` vs Unicode `ɡ` (U+0261) that would otherwise silently delete phonemes.

2. **No filesystem or network.** All dictionaries arrive through `load_dictionary()`. Everything else is `include_str!` at build time.

## Usage

### From Rust

```rust
use phonemize::{PhonemizeOptions, Phonemizer};

let mut phonemizer = Phonemizer::new();
phonemizer
    .load_dictionary("lindera-unidic-ja", &compressed)
    .unwrap();
phonemizer.finish_loading().unwrap();

let options = PhonemizeOptions {
    frontend: "kokoro-v1".to_string(),
    lang: "ja-JP".to_string(),
};
let result = phonemizer.phonemize_with("こんにちは", &options)?;
```

Use `phonemize_with()` from Rust (takes `PhonemizeOptions`, returns `PhonemizeResult`). The `phonemize()` method is the `#[wasm_bindgen]` boundary for JavaScript callers.

### From TypeScript

Use `lib/models/phonemize-rust.ts` (not the generated bindings directly). It handles dictionary URLs, Cache Storage, and per-language preparation state. Three methods: `ready()`, `prepare(frontend, lang)`, `phonemize(text, options)`.

## Building and Testing

```bash
./scripts/build/build-phonemize-wasm.sh   # wasm-pack → lib/models/phonemize-wasm/
cargo test --workspace                     # 299 tests, native, no browser
cargo clippy --all-targets                 # must stay at 0 warnings
python3 scripts/generate/gen-ja-ipa-table.py --check
```

`pnpm build` runs the wasm build via its `prebuild` hook. CI runs `cargo test`.

### Load-bearing Dependencies

Four dependencies require specific feature settings (see `Cargo.toml` for full rationale):

- `lindera`, `jieba-rs`: `default-features = false` (defaults pull in `mmap` + C `zstd` that won't link for wasm on macOS)
- `piper-plus-g2p`: `default-features = false` (defaults pull in six other frontends)
- `rustfst`: defaults **must stay on** (`state-label-u32` affects label type casting)

`getrandom` 0.3 arrives through `rustfst` and does not compile for `wasm32-unknown-unknown` unless a backend is named. The workspace `.cargo/config.toml` sets `getrandom_backend="wasm_js"` for that target, and `Cargo.toml` enables the matching `wasm_js` feature.

## Data (`data/`)

| File | Source | Regenerate |
|---|---|---|
| `pinyin-chars.txt`, `pinyin-phrases.txt`, `pinyin-special.txt`, `pinyin-syllables.txt` | `pinyin-pro` + `pinyin-table.json` | `node scripts/generate/gen-pinyin-pro-data.mjs` |
| `pinyin-table.json` | pypinyin via misaki's `transcription.py` | `python3 scripts/generate/gen-pinyin-table.py` |
| `vocab-v1.txt`, `vocab-v11-zh.txt` | Kokoro models' `tokenizer.json` | `node scripts/generate/gen-kokoro-vocab.mjs` |
| `ja-ipa-table.json` | Hand-maintained (source of truth for kana table) | — |
| `pinyin-NOTICE.txt` | MIT notices | — |

The English rule table (`src/g2p/en/headtts/rules.rs`) is generated from `tests/fixtures/headtts-en-parity.json` by `scripts/generate/gen-headtts-rules.mjs` (checked in CI via `pnpm check:headtts`).

The Japanese IPA table module (`src/g2p/ja/table.rs`) is generated from `ja-ipa-table.json` by `scripts/generate/gen-ja-ipa-table.py`. `tests/ja_ipa_table_parity.rs` verifies they match.

The English contraction tables (`src/tn/wetext/data/*.json`) are copied unchanged from the Python `contractions` package 0.1.73. They are MIT, unlike the Apache-2.0 rest of `src/tn/wetext/`, and carry their own `data/contractions-NOTICE.txt`.

Chinese tone sandhi word lists live in `src/g2p/zh/tone_sandhi/tables.rs` (verbatim upstream data, not generated).

## Test Corpora

- `tests/fixtures/{zh-parity,zh-frontend-parity}.json` — Frozen golden files (JavaScript pipeline output before deletion)
- `tests/fixtures/ja-reference.json` — Reference corpus first recorded from pyopenjtalk; `kana`/`expected` are what this crate's UniDic dictionary produces. `scripts/check/check-ja-reference.py` compares the two and reports where they differ.
- `tests/fixtures/headtts-en-parity.json` — HeadTTS reference output; regenerated via `scripts/generate/headtts-parity.mjs`

Each Japanese sample records both the reference reading (`kana`) and this crate's output (`expected`). Samples where they disagree carry a `gap` note.
