# Scripts Directory

Build, setup, data-generation and verification scripts for SayLoud. Three rules
shape everything here:

1. **Generated files and downloaded dictionaries are handled differently.**
   Generated data is committed to git and checked in CI; the dictionaries are
   built by `pnpm install` into `public/dictionaries/` and are *not* committed,
   because they are 11 MB of someone else's data.
2. **Every generator has a `--check` mode** that regenerates in memory and
   compares against the committed file. That is what CI runs — the tests pin the
   *committed* data, so without a check a stale file stays green forever.
3. **Setup scripts are idempotent.** An existing asset is left alone;
   `FORCE=1` rebuilds it.

## Directory Structure

```
scripts/
├── build/              # Build automation
│   └── build-phonemize-wasm.sh
├── setup/              # Dictionary assets (network; run by `pnpm install`)
│   ├── setup-dictionaries.sh     # entry point — calls the three below
│   ├── setup-jieba-dict.sh       # Chinese word list
│   ├── setup-lindera-dict.sh     # Japanese IPADic
│   └── setup-wetext-fsts.sh      # six text-normalization grammars
├── generate/           # Data generation (local inputs; committed output)
│   ├── gen-pinyin-pro-data.mjs
│   ├── gen-pinyin-table.py
│   ├── gen-ja-ipa-table.py
│   ├── gen-kokoro-vocab.mjs
│   ├── gen-headtts-rules.mjs
│   └── headtts-parity.mjs        # not a generator: dumps a fixture from upstream
├── check/              # Verification
│   ├── check-manifest.mjs
│   ├── check-ja-reference.py
│   └── mutation-check-ja.py
└── misaki/             # Vendored pinyin→IPA rules + their licence
    ├── transcription.py
    └── LICENSE
```

## Quick Reference

Every script below has a `package.json` alias, which is the shortest way to run
it. The direct invocation is given in each section.

| Alias | Script | When |
|-------|--------|------|
| `pnpm build:wasm` | `build/build-phonemize-wasm.sh` | `pnpm build` runs it through `prebuild` |
| `pnpm gen:headtts` | `generate/gen-headtts-rules.mjs` | when the HeadTTS fixture changes |
| `pnpm gen:vocab` | `generate/gen-kokoro-vocab.mjs` | when the Kokoro models change |
| `pnpm gen:pinyin` | `generate/gen-pinyin-pro-data.mjs` | when `pinyin-pro` is bumped |
| `pnpm gen:ja-ipa` | `generate/gen-ja-ipa-table.py` | when the kana table changes |
| `pnpm check:headtts` | `gen-headtts-rules.mjs --check` | CI |
| `pnpm check:vocab` | `gen-kokoro-vocab.mjs --check` | CI |
| `pnpm check:manifest` | `check/check-manifest.mjs` | CI, after a build |
| `pnpm check:ja-mutations` | `check/mutation-check-ja.py` | manually, before trusting the Japanese tests |

---

## Build

### `build/build-phonemize-wasm.sh`

Compiles `crates/phonemize` with `wasm-pack` into `lib/models/phonemize-wasm/`,
which is what `lib/models/phonemize-rust.ts` imports and what `tsc` reads its
types from. That directory is a git-ignored build artifact, so anything that
type-checks or tests the wrapper needs this to have run first.

```bash
pnpm build:wasm                    # or `pnpm build`, which runs it first
```

Needs `wasm-pack` (`cargo install wasm-pack`). CI installs the Rust toolchain
with the `wasm32-unknown-unknown` target and runs this explicitly before
`typecheck` and `test`.

---

## Setup

These scripts fetch third-party data and re-pack it into the zstd frames the
wasm decompresses with `ruzstd`. They run from the repository root (they `cd`
there themselves, since `public/dictionaries` is repository-relative) and write
to **`public/dictionaries/`**, which is git-ignored.

| Asset | Source | Size |
|---|---|---|
| `jieba-zh-dict.bin.zst` | `jieba-rs` 0.11.0's `dict.txt`, sha256-pinned | 1.6 MB |
| `lindera-ipadic-ja.bin.zst` | lindera 6.2.0's IPADic release zip, nine files in a tar | 8.5 MB |
| `wetext-{en,zh,ja}-tn-{tagger,verbalizer}.bin.zst` | `wetext` 0.1.8 wheel, sha256-pinned | 707 / 160 / 63 KB |

`NOTICE` files land beside them: these are other people's dictionaries and the
licence has to travel with the bytes.

### `setup/setup-dictionaries.sh`

The entry point. Calls `setup-jieba-dict.sh`, `setup-lindera-dict.sh` and
`setup-wetext-fsts.sh` in that order and says where everything landed.

```bash
./scripts/setup/setup-dictionaries.sh
FORCE=1 ./scripts/setup/setup-dictionaries.sh   # rebuild everything
```

`pnpm install` runs it through the `postinstall` hook, where a failure is
**tolerated** — an offline checkout still installs. That tolerance is safe
because the absence is not tolerated anywhere else: the pipeline tests that need
a dictionary fail with the command to fix it rather than skipping (see
`crates/phonemize/tests/common/mod.rs`).

### `setup/setup-jieba-dict.sh`

jieba's word-frequency list, taken from the same tag of the same crate the wasm
links against (`jieba-rs` 0.11.0). That is a parity requirement, not a
convenience: the JavaScript side segments with `jieba-wasm`, which is that crate
compiled to wasm, so the two have to agree on where words end. The `sha256` is
checked on every build.

It is fetched rather than embedded because `jieba-rs`'s `default-dict` feature
pulls in the C `zstd` crate, which cannot link for `wasm32-unknown-unknown` on
macOS. Needs `curl` and `zstd`.

### `setup/setup-lindera-dict.sh`

lindera's IPADic release: a zip of the nine files `load_from_path` reads, packed
into one zstd frame. The tar is a transport wrapper only — the files inside are
lindera's own, byte for byte, because re-packing them would be a second format to
keep working. The file list is explicit and ordered, so the archive is identical
on every machine; a glob would make it depend on the filesystem. The dictionary
and the crate that reads it have to be the same generation, so the lindera
version is pinned here. Needs `curl`, `unzip`, `tar` and `zstd`.

### `setup/setup-wetext-fsts.sh`

The six weighted-FST text-normalization grammars, from the `wetext` wheel (the
upstream WeTextProcessing project's own build, published inside the wheel rather
than as a data release). Only `{en,zh,ja}/tn/{tagger,verbalizer}` are taken: the
crate's normalizer configuration asks for none of the wheel's other grammars, and
a tagger without its verbalizer can only fail — `crates/phonemize/src/lib.rs`
refuses to build a language's normalizer unless both halves arrived. The wheel is
sha256-pinned, which covers the FSTs inside it. Needs `curl`, `unzip` and `zstd`.

---

## Generate

These run from local inputs (`node_modules`, a committed source file, or the
model directories) and their output is committed. All support `--check`.

### `generate/gen-pinyin-pro-data.mjs`

Extracts `pinyin-pro` 3.29.4's tables into flat text, which is what the crate
consumes — it has no JSON parser on the wasm side.

**Input:** `node_modules/pinyin-pro` (the version is asserted, not assumed)
**Output:** `crates/phonemize/data/pinyin-{chars,phrases,special,syllables}.txt`

```bash
node scripts/generate/gen-pinyin-pro-data.mjs --check   # CI
node scripts/generate/gen-pinyin-pro-data.mjs           # or `pnpm gen:pinyin`
```

`syllables.txt` is transcribed from `pinyin-table.json` rather than regenerated,
so `gen-pinyin-table.py` has to run first when the table itself changes.

### `generate/gen-pinyin-table.py`

Regenerates `crates/phonemize/data/pinyin-table.json` — pinyin syllables with
their IPA, computed by pypinyin using the rules vendored in `scripts/misaki/`.
The table is a source file for `gen-pinyin-pro-data.mjs` above.

```bash
python3 scripts/generate/gen-pinyin-table.py --check
python3 scripts/generate/gen-pinyin-table.py
```

Needs pypinyin and ordered-set; the script's own recipe pins them:

```bash
uv run --with pypinyin==0.55.0 --with ordered-set==4.1.0 \
    python3 scripts/generate/gen-pinyin-table.py
```

### `generate/gen-ja-ipa-table.py`

Turns the hand-maintained `crates/phonemize/data/ja-ipa-table.json` into
`crates/phonemize/src/g2p/ja/table.rs`. The JSON is the source of truth and the
Rust file is a build product: `crates/phonemize/tests/ja_ipa_table_parity.rs`
reads the JSON back and fails if the two disagree, so the Rust file is never
edited by hand. The parity test that also checked these entries against the
model's own tokenizer vocabulary is `crates/phonemize/src/vocab.rs`.

```bash
python3 scripts/generate/gen-ja-ipa-table.py --check
python3 scripts/generate/gen-ja-ipa-table.py      # or `pnpm gen:ja-ipa`
```

### `generate/gen-kokoro-vocab.mjs`

Turns the two Kokoro models' tokenizer vocabularies into the character lists the
vocabulary gate reads.

**Input:** each model's `tokenizer.json` (`model.vocab`), via `KOKORO_V10_DIR` and
`KOKORO_V11_DIR` — **or** the committed snapshot
`tests/fixtures/kokoro-vocabs.json` when those are unset, which is how CI runs it
**Output:** `crates/phonemize/data/vocab-v1.txt` (115 characters),
`crates/phonemize/data/vocab-v11-zh.txt` (172)

```bash
node scripts/generate/gen-kokoro-vocab.mjs --check   # CI; uses the snapshot
KOKORO_V10_DIR=/path/to/kokoro-v1.0 \
KOKORO_V11_DIR=/path/to/kokoro-v1.1-zh \
node scripts/generate/gen-kokoro-vocab.mjs           # refresh the snapshot's source
```

The header it writes into both files names the snapshot, and that header is
inside the wasm: `vocab.rs` embeds `data/vocab-v1.txt` with `include_str!`.

### `generate/gen-headtts-rules.mjs`

Transcribes HeadTTS's NRL Report 7948 letter-to-sound rules into Rust.

**Input:** `crates/phonemize/tests/fixtures/headtts-en-parity.json`
**Output:** `crates/phonemize/src/g2p/en/headtts/rules.rs`

```bash
pnpm check:headtts    # or: node scripts/generate/gen-headtts-rules.mjs --check
pnpm gen:headtts
```

309 rules, `const` data — no fetched asset. Both this and
`headtts-parity.mjs` are frozen: they only run when HeadTTS upstream moves.

### `generate/headtts-parity.mjs`

Not a generator but the thing that produces a generator's input: it runs
**upstream JavaScript** from a HeadTTS checkout and dumps the rules and the words
they are exercised on.

**Input:** a HeadTTS checkout (`HEADTTS_DIR`, default `/tmp/HeadTTS`) and
`/usr/share/dict/words`
**Output:** `crates/phonemize/tests/fixtures/headtts-en-parity.json`

```bash
HEADTTS_DIR=/path/to/HeadTTS node scripts/generate/headtts-parity.mjs
```

The fixture records the upstream revision and module SHA-256, so a regeneration
that changes anything but the word list means upstream moved.

---

## Check

### `check/check-manifest.mjs`

Guards the extension's permission surface. WXT adds a runtime-registered content
script's `matches` to `host_permissions`, which would quietly ask for access to
every site; `wxt.config.ts` strips it, and this is what keeps that strip honest.
The failure mode is silent and only shows up as a permission prompt nobody reads.

```bash
pnpm check:manifest                        # .output/chrome-mv3/manifest.json
pnpm check:manifest path/to/manifest.json
```

Runs against a **built** manifest, which is why CI runs it after `pnpm build`.

### `check/check-ja-reference.py`

Recomputes the Japanese reference corpus and compares it against
`crates/phonemize/tests/fixtures/ja-reference.json`. The reference is
`pyopenjtalk` — the OpenJTalk chain Kokoro's Japanese voices were trained with —
so a reading that drifts shows up here rather than being frozen into a fixture.

```bash
python3 scripts/check/check-ja-reference.py           # check
python3 scripts/check/check-ja-reference.py --write   # regenerate the fixture
```

Needs `pip install pyopenjtalk`.

### `check/mutation-check-ja.py`

Mutates the Japanese pipeline's guards one at a time — the dictionary placeholder
read as a value, the numeral step skipped, the two-character mora losing to the
one-character one — runs the test target that should notice, and restores the
file. Each mutation has to make a real bug invisible to be worth having, so a
mutation that *survives* is a test gap and the script exits non-zero.

```bash
pnpm check:ja-mutations
```

Manual, not CI: every mutation needs its own compile, so a pass takes minutes. It
asserts that the pattern matched **and that the mutation compiles** before
running the target — a `str.replace` that finds nothing, or produces code that
does not build, would otherwise make "the tests did not catch it" look exactly
like "there was no bug".

---

## Misaki

`scripts/misaki/` holds the pinyin→IPA rules vendored from the
[misaki](https://github.com/Alloyed/misaki) project, plus its MIT licence.

`transcription.py` is the `PINYIN_TO_IPA` mapping Kokoro's Chinese voices were
trained with. It is vendored rather than depended on because misaki is not
published as a Python package, and only that one table is needed. It is imported
by `generate/gen-pinyin-table.py`; do not edit it unless syncing from upstream.

---

## Common Workflows

### Normal development

```bash
pnpm install    # postinstall builds the dictionaries
pnpm build      # prebuild builds the wasm, then wxt bundles
pnpm test
```

### After changing Rust

```bash
pnpm build:wasm    # the wrapper imports this output
pnpm test
```

### After bumping a dependency

```bash
# pinyin-pro
node scripts/generate/gen-pinyin-pro-data.mjs --check   # in sync?
node scripts/generate/gen-pinyin-pro-data.mjs           # regenerate
git add crates/phonemize/data/pinyin-*.txt
```

The same shape for every generator: `--check` first, regenerate only if it is
stale, and commit the data with the version bump.

### Before a release

```bash
node scripts/generate/gen-pinyin-pro-data.mjs --check
node scripts/generate/gen-kokoro-vocab.mjs --check
pnpm check:headtts
python3 scripts/generate/gen-pinyin-table.py --check
python3 scripts/generate/gen-ja-ipa-table.py --check
```

### Force a dictionary rebuild

```bash
rm -rf public/dictionaries
./scripts/setup/setup-dictionaries.sh
```

---

## CI

`.github/workflows/ci.yml` runs, in order:

```yaml
- run: pnpm install --frozen-lockfile          # postinstall builds the dictionaries
- run: node scripts/generate/gen-pinyin-pro-data.mjs --check
- run: node scripts/generate/gen-kokoro-vocab.mjs --check
- run: pnpm check:headtts
- run: pnpm build:wasm                         # Rust toolchain + wasm-pack
- run: cargo test --workspace
- run: pnpm typecheck
- run: pnpm lint
- run: pnpm test
- run: pnpm test:e2e
- run: pnpm build
- run: pnpm check:manifest
- run: pnpm smoke:sidepanel
```

The three generators come before the tests because the tests pin the committed
data: a `pinyin-pro` bump that changed a reading would leave every test green and
the data stale.

---

## Design Principles

### 1. Generated files are committed; dictionaries are not

Committed (the build and the tests must work offline):

- `crates/phonemize/data/*.txt`, `data/pinyin-table.json`, `data/ja-ipa-table.json`
- `crates/phonemize/src/g2p/ja/table.rs`, `src/g2p/en/headtts/rules.rs`
- `crates/phonemize/tests/fixtures/*.json`, `tests/fixtures/*.json`

Not committed (regenerated by `pnpm install`, or by `pnpm build:wasm`):

- `public/dictionaries/*.bin.zst` — 11 MB of third-party data
- `lib/models/phonemize-wasm/` — wasm-pack's output

### 2. `--check` mode is what CI runs

Each generator regenerates in memory and compares against the committed file,
exiting non-zero on a mismatch. Without it, a stale file and a fresh one are
indistinguishable to the tests that read it.

### 3. Setup scripts are idempotent

An existing asset is skipped, nothing is deleted, and `FORCE=1` is the only way
to rebuild. Re-running after a partial download costs nothing.

### 4. Generated files record their provenance

The first line of every generated file names the script, the version it came
from, and "do not edit" — see the head of
`crates/phonemize/data/pinyin-chars.txt` for the shape.

### 5. Downstream versions are pinned where they matter

`pinyin-pro` 3.29.4, `jieba-rs` 0.11.0, lindera 6.2.0 and `wetext` 0.1.8 are
constants in these scripts, and the two network downloads that have no version in
a lockfile (jieba's word list, the wetext wheel) are additionally pinned by
sha256. IPADic's release zip is pinned by version only — its contents are checked
by the crate's own metadata validation at load time.

---

## Troubleshooting

### A dictionary is missing

The pipeline tests fail with the command to fix it rather than skipping, so the
message names the script:

```bash
./scripts/setup/setup-dictionaries.sh
```

`pnpm install` runs that for you, but tolerates a failure — an offline checkout
still installs, and this is what tells you the assets never arrived.

### A `--check` run fails in CI

The committed data no longer matches its source. Run the same script without
`--check`, review the diff, and commit it with whatever changed the input (a
dependency bump, or the model directories).

### TypeScript fails but the Rust tests pass

The wasm is stale: `pnpm build:wasm`.

### `headtts-parity.mjs` fails

It needs a HeadTTS checkout and the system word list:

```bash
git clone https://github.com/Alloyed/HeadTTS /tmp/HeadTTS
HEADTTS_DIR=/tmp/HeadTTS node scripts/generate/headtts-parity.mjs
```

`/usr/share/dict/words` (or an equivalent) has to exist, because the word list
that exercises the rules is chosen by a covering pass over it.

### `check:ja-mutations` reports `BROKEN` or `NO COMPILE`

A mutation's anchor no longer matches the code, or its replacement does not
build — most often because the source moved. Fix the entry's path or pattern;
see the module's own docstring for why that is not a warning to ignore.

---

## See Also

- [`crates/phonemize/README.md`](../crates/phonemize/README.md) — what the
  phonemizer does with these assets
- [`AGENT.md`](../AGENT.md) — how the extension is put together
