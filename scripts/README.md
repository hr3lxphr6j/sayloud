# Scripts Directory

This directory contains build, setup, data generation, and verification scripts for the TTS-NG project.

## Directory Structure

```
scripts/
├── build/              # Build automation
│   └── build-rust-wasm.sh
├── setup/              # Environment setup & dependency installation
│   ├── setup-dictionaries.sh
│   ├── setup-en-g2p.sh
│   ├── setup-ja-g2p.sh
│   ├── setup-wetext-tn.sh
│   └── setup-zh-g2p.sh
├── generate/           # Data generation from upstream sources
│   ├── gen-headtts-rules.mjs
│   ├── gen-ja-ipa-table.py
│   ├── gen-kokoro-vocab.mjs
│   ├── gen-pinyin-pro-data.mjs
│   ├── gen-pinyin-table.py
│   └── headtts-parity.mjs
├── check/              # Verification scripts
│   ├── compare-en-phonemize.mjs
│   └── compare-zh-pinyin.mjs
└── misaki/             # Vendored misaki utilities
    ├── transcription.py
    └── README.md
```

## Quick Reference

| Script | When to Run | Purpose |
|--------|-------------|---------|
| **Build** |
| `build/build-rust-wasm.sh` | `pnpm build` (auto) | Compile Rust phonemize crate to wasm |
| **Setup** |
| `setup/setup-dictionaries.sh` | `pnpm install` (auto) | Download all dictionaries (unified entry point) |
| `setup/setup-en-g2p.sh` | Called by above | English CMU dictionary (9.0 MB) |
| `setup/setup-ja-g2p.sh` | Called by above | Japanese dictionary (8.1 MB) |
| `setup/setup-wetext-tn.sh` | Called by above | Text normalization grammars (909 KB) |
| `setup/setup-zh-g2p.sh` | Called by above | Chinese segmentation dictionary (1.6 MB) |
| **Generate** |
| `generate/gen-pinyin-pro-data.mjs` | Manual | Extract pinyin-pro data → Rust files |
| `generate/gen-pinyin-table.py` | Manual | Generate pinyin→IPA table from misaki |
| `generate/gen-ja-ipa-table.py` | Manual | Generate Japanese katakana→IPA table |
| `generate/gen-kokoro-vocab.mjs` | Manual | Generate Kokoro vocabulary validation files |
| `generate/gen-headtts-rules.mjs` | Manual (frozen) | Transcribe HeadTTS rules → Rust |
| `generate/headtts-parity.mjs` | Manual (frozen) | Extract HeadTTS rules and test cases |
| **Check** |
| `check/compare-en-phonemize.mjs` | Manual | Compare English phonemization outputs |
| `check/compare-zh-pinyin.mjs` | Manual | Compare Chinese pinyin outputs |

---

## Detailed Documentation

### Build Scripts

#### `build/build-rust-wasm.sh`

Compiles the Rust phonemize crate to WebAssembly using wasm-pack.

**Usage:**
```bash
./scripts/build/build-rust-wasm.sh
```

**Output:**
- `lib/models/phonemize-wasm/phonemize_bg.wasm` (6+ MB)
- `lib/models/phonemize-wasm/phonemize.js` (JS glue)
- `lib/models/phonemize-wasm/phonemize.d.ts` (TypeScript types)

**When to run:**
- Automatically via `pnpm build` (prebuild hook)
- Manually after modifying Rust code in `crates/phonemize/`
- CI runs it before `pnpm typecheck`

**Requirements:**
- Rust toolchain with `wasm32-unknown-unknown` target
- `wasm-pack` installed
- `wasm-opt` (from binaryen) for optimization

---

### Setup Scripts

These scripts download external dictionaries and models. All setup scripts are idempotent (safe to run multiple times).

#### `setup/setup-dictionaries.sh`

**Main entry point** that calls all other setup scripts.

**Usage:**
```bash
./scripts/setup/setup-dictionaries.sh
```

**What it does:**
1. Calls `setup-en-g2p.sh` (English CMU dictionary)
2. Calls `setup-ja-g2p.sh` (Japanese dictionary)
3. Calls `setup-zh-g2p.sh` (Chinese dictionary)
4. Calls `setup-wetext-tn.sh` (text normalization grammars)

**When to run:**
- Automatically via `pnpm install` (postinstall hook)
- Manually when dictionaries are missing
- Force re-download: `rm -rf crates/phonemize/data/*.{bin,zst}` then run

---

#### `setup/setup-en-g2p.sh`

Downloads English CMU pronunciation dictionary.

**Source:** GitHub release from TTS-NG repo  
**Output:** `crates/phonemize/data/cmudict-ipa.bin.zst` (9.0 MB)  
**Format:** Custom binary format (word → IPA mappings)

**Usage:**
```bash
./scripts/setup/setup-en-g2p.sh
```

---

#### `setup/setup-ja-g2p.sh`

Downloads Japanese morphological dictionary (lindera).

**Source:** GitHub release from TTS-NG repo  
**Output:** `crates/phonemize/data/lindera-ipadic.bin.zst` (8.1 MB)  
**Format:** MeCab/lindera binary format

**Usage:**
```bash
./scripts/setup/setup-ja-g2p.sh
```

---

#### `setup/setup-zh-g2p.sh`

Downloads Chinese segmentation dictionary (jieba).

**Source:** GitHub release from TTS-NG repo  
**Output:** `crates/phonemize/data/jieba-dict.txt.zst` (1.6 MB)  
**Format:** Plain text (word frequency list)

**Usage:**
```bash
./scripts/setup/setup-zh-g2p.sh
```

---

#### `setup/setup-wetext-tn.sh`

Downloads text normalization finite-state transducers (WeText).

**Source:** GitHub release from TTS-NG repo  
**Output:**
- `crates/phonemize/data/wetext-en-tn-tagger.bin.zst` (468 KB)
- `crates/phonemize/data/wetext-en-tn-verbalizer.bin.zst` (239 KB)
- `crates/phonemize/data/wetext-zh-tn-tagger.bin.zst` (160 KB)
- `crates/phonemize/data/wetext-zh-tn-verbalizer.bin.zst` (35 KB)
- `crates/phonemize/data/wetext-ja-tn-tagger.bin.zst` (63 KB)
- `crates/phonemize/data/wetext-ja-tn-verbalizer.bin.zst` (6 KB)

**Format:** rustfst binary format (FST → bytes)

**Usage:**
```bash
./scripts/setup/setup-wetext-tn.sh
```

---

### Generate Scripts

These scripts generate data files from upstream sources. They are **not run automatically** during build or install. Generated files are **committed to git**.

#### `generate/gen-kokoro-vocab.mjs`

Generates Kokoro vocabulary validation files from model tokenizers.

**Input:**
- Kokoro model tokenizer.json files (via environment variables or CLI arguments)
- Environment: `KOKORO_V1_DIR`, `KOKORO_V11_ZH_DIR`

**Output:**
- `crates/phonemize/data/vocab-v1.txt` (115 characters)
- `crates/phonemize/data/vocab-v11-zh.txt` (172 characters)

**Usage:**
```bash
# Check mode (CI)
node scripts/generate/gen-kokoro-vocab.mjs --check

# Generate mode (manual)
export KOKORO_V1_DIR=/path/to/kokoro-v1.0
export KOKORO_V11_ZH_DIR=/path/to/kokoro-v1.1-zh
node scripts/generate/gen-kokoro-vocab.mjs

# Or with CLI arguments
node scripts/generate/gen-kokoro-vocab.mjs \
  --v1 /path/to/kokoro-v1.0 \
  --v11-zh /path/to/kokoro-v1.1-zh
```

**When to run:**
- When Kokoro models update
- When adding support for new Kokoro versions

**Check mode:**
- Used in CI to verify committed files match upstream
- Exits with error if mismatch detected

---

#### `generate/gen-pinyin-pro-data.mjs`

Extracts data from pinyin-pro npm package into Rust-friendly formats.

**Input:** `node_modules/pinyin-pro/dist/esm/data/dict{1,2,3,4,5}.mjs`  
**Output:**
- `crates/phonemize/data/pinyin-chars.txt` (20,879 characters)
- `crates/phonemize/data/pinyin-phrases.txt` (113,407 phrases)
- `crates/phonemize/data/pinyin-singlepy.txt` (29 syllables)
- `crates/phonemize/data/pinyin-doublepy.txt` (397 combinations)

**Usage:**
```bash
# Check mode (CI)
pnpm run gen:pinyin-data --check

# Generate mode (manual)
pnpm run gen:pinyin-data
```

**When to run:**
- When upgrading pinyin-pro version
- Before committing if pinyin-pro was updated

**What it extracts:**
1. Single characters → pinyin mappings
2. Multi-character phrases → pinyin sequences
3. Valid pinyin syllables (with/without tones)

**Data format:**
```
# pinyin-chars.txt
一 yī
二 èr
三 sān

# pinyin-phrases.txt
一般 yībān
一起 yīqǐ
```

---

#### `generate/gen-pinyin-table.py`

Generates pinyin-to-IPA conversion table from misaki transcription rules.

**Input:** `scripts/misaki/transcription.py` (vendored from misaki project)  
**Output:** `crates/phonemize/data/pinyin-ipa-table.txt` (1,334 mappings)

**Usage:**
```bash
# Check mode
python3 scripts/generate/gen-pinyin-table.py --check

# Generate mode
python3 scripts/generate/gen-pinyin-table.py
```

**When to run:**
- When misaki transcription rules update (rare)
- When adding new pinyin → IPA mappings

**What it does:**
1. Imports misaki's `Transcription.PINYIN_TO_IPA`
2. Expands tone markers (ā, á, ǎ, à, a) → numeric tones (1-5)
3. Generates all valid combinations (syllable × tone)
4. Writes to flat text file

**Data format:**
```
# pinyin-ipa-table.txt
a1 a˥
a2 a˧˥
a3 a˨˩˦
a4 a˥˩
a5 a
```

---

#### `generate/gen-ja-ipa-table.py`

Generates Japanese katakana-to-IPA mapping table.

**Input:** Hard-coded Japanese phonology rules (based on kokoro-js)  
**Output:** `crates/phonemize/src/frontends/ja_ipa_table.rs` (Rust code)

**Usage:**
```bash
# Check mode
python3 scripts/generate/gen-ja-ipa-table.py --check

# Generate mode
python3 scripts/generate/gen-ja-ipa-table.py
```

**When to run:**
- When Japanese phonology rules change
- When adding new katakana characters

**What it generates:**
- `KATAKANA_TO_IPA` HashMap (100+ entries)
- Handles special cases (ん position-dependent, long vowels)

---

#### `generate/gen-headtts-rules.mjs` (frozen)

Transcribes HeadTTS pronunciation rules into Rust code.

**Input:** `tests/fixtures/headtts-parity.json` (extracted by `headtts-parity.mjs`)  
**Output:** `crates/phonemize/src/backends/headtts_en/rules.rs` (7,948 rules)

**Status:** ⚠️ **Frozen** — rules already generated and committed. Only re-run if HeadTTS upstream updates.

**Usage:**
```bash
node scripts/generate/gen-headtts-rules.mjs
```

**When to run:**
- When HeadTTS upstream updates (rare)
- After running `headtts-parity.mjs` to extract new rules

---

#### `generate/headtts-parity.mjs` (frozen)

Extracts HeadTTS pronunciation rules and test cases from upstream repository.

**Input:** HeadTTS checkout (via `HEADTTS_DIR` environment variable)  
**Output:** `tests/fixtures/headtts-parity.json` (rules + test cases)

**Status:** ⚠️ **Frozen** — fixture already extracted. Only re-run if HeadTTS upstream updates.

**Usage:**
```bash
HEADTTS_DIR=/path/to/HeadTTS node scripts/generate/headtts-parity.mjs
```

**When to run:**
- When HeadTTS upstream updates (rare)
- Before running `gen-headtts-rules.mjs`

---

### Check Scripts

These scripts verify correctness by comparing outputs.

#### `check/compare-en-phonemize.mjs`

Compares English phonemization between different implementations.

**Usage:**
```bash
node scripts/check/compare-en-phonemize.mjs
```

**What it compares:**
- Rust wasm implementation vs. expected outputs
- Useful for debugging regressions

---

#### `check/compare-zh-pinyin.mjs`

Compares Chinese pinyin outputs between implementations.

**Usage:**
```bash
node scripts/check/compare-zh-pinyin.mjs
```

**What it compares:**
- Rust pinyin implementation vs. pinyin-pro
- Useful for verifying porting correctness

---

### Misaki Directory

`scripts/misaki/` contains vendored utilities from the [misaki](https://github.com/Alloyed/misaki) project.

#### `misaki/transcription.py`

Pinyin-to-IPA conversion rules used by Kokoro model training.

**Why vendored:**
- misaki is not published as a Python package
- We only need the `PINYIN_TO_IPA` dictionary
- Avoids git submodule complexity

**Usage:**
- Imported by `generate/gen-pinyin-table.py`
- Read-only; do not modify unless syncing from upstream

**License:** MIT (same as misaki)

See `scripts/misaki/README.md` for more details.

---

## Common Workflows

### Daily Development

```bash
# Normal development (no script interaction)
pnpm install    # Auto-runs setup-dictionaries.sh
pnpm build      # Auto-runs build-rust-wasm.sh
pnpm test
```

### After Modifying Rust Code

```bash
./scripts/build/build-rust-wasm.sh  # Rebuild wasm
pnpm test                            # Verify
```

### After Updating Dependencies

```bash
# If pinyin-pro updated
pnpm run gen:pinyin-data --check    # Verify still in sync
# If mismatch:
pnpm run gen:pinyin-data            # Regenerate
git add crates/phonemize/data/pinyin-*.txt
git commit -m "chore: update pinyin-pro data to vX.Y.Z"
```

### Before Release

```bash
# Check all generated files are up-to-date
pnpm run gen:pinyin-data --check
node scripts/generate/gen-kokoro-vocab.mjs --check
python3 scripts/generate/gen-pinyin-table.py --check
python3 scripts/generate/gen-ja-ipa-table.py --check

# Rebuild from clean state
rm -rf .output lib/models/phonemize-wasm
pnpm install
pnpm build
pnpm test
```

### Force Re-download Dictionaries

```bash
# Remove all dictionaries
rm -rf crates/phonemize/data/*.bin.zst

# Re-download
./scripts/setup/setup-dictionaries.sh
```

---

## CI Integration

GitHub Actions workflow uses these scripts:

```yaml
# .github/workflows/test.yml
- name: Setup dictionaries
  run: ./scripts/setup/setup-dictionaries.sh

- name: Build Rust wasm
  run: ./scripts/build/build-rust-wasm.sh

- name: Check generated data
  run: |
    pnpm run gen:pinyin-data --check
    node scripts/generate/gen-kokoro-vocab.mjs --check
```

**Key points:**
- Setup scripts run before build (dictionaries must exist)
- Check mode verifies committed files match upstream
- Build scripts run before tests

---

## Design Principles

### 1. Generated files are committed to git

**Why:** Build process must work offline (no network dependency).

**Which files:**
- `crates/phonemize/data/*.txt` (pinyin, vocab, IPA tables)
- `crates/phonemize/src/frontends/ja_ipa_table.rs` (generated code)
- `crates/phonemize/src/backends/headtts_en/rules.rs` (generated code)
- `tests/fixtures/headtts-parity.json` (frozen test data)

**Not committed:**
- `crates/phonemize/data/*.bin.zst` (downloaded dictionaries, too large)
- `lib/models/phonemize-wasm/*.wasm` (build output, reproducible)

### 2. Check mode for CI

All generation scripts support `--check` mode:
- Regenerate in memory
- Compare with committed files
- Exit with error if mismatch

**Why:** Prevents accidental commits of stale data.

### 3. Setup scripts are idempotent

Running setup scripts multiple times is safe:
- Check if file exists and has correct size
- Skip download if already present
- No side effects (no rm -rf, no overwrites)

### 4. Generated files record their provenance

Every generated file includes a header comment:

```
# Generated by scripts/generate/gen-pinyin-pro-data.mjs from pinyin-pro 3.29.4 — do not edit.
```

**Why:**
- Makes it clear the file is generated
- Records the upstream version
- Reminds contributors not to edit by hand

### 5. Build process does not fetch over network

**Why:** Reproducible builds, offline support, CI speed.

**How:**
- Dictionaries downloaded during `pnpm install` (postinstall)
- Build scripts only compile/transform local files
- CI caches `crates/phonemize/data/` between runs

---

## Troubleshooting

### "Dictionary not found" during build

**Symptom:** Rust tests fail with "No such file or directory"

**Solution:**
```bash
./scripts/setup/setup-dictionaries.sh
```

**Why:** Dictionaries are not committed to git (too large). Setup script must run first.

---

### "pinyin-pro version mismatch" in CI

**Symptom:** `gen:pinyin-data --check` fails

**Solution:**
```bash
pnpm run gen:pinyin-data              # Regenerate
git add crates/phonemize/data/*.txt
git commit -m "chore: update pinyin-pro data"
```

**Why:** pinyin-pro was updated but data files weren't regenerated.

---

### Wasm file is outdated

**Symptom:** TypeScript tests fail but Rust tests pass

**Solution:**
```bash
./scripts/build/build-rust-wasm.sh
```

**Why:** Rust code changed but wasm wasn't rebuilt.

---

### "HEADTTS_DIR not set"

**Symptom:** `headtts-parity.mjs` fails

**Solution:**
```bash
# Clone HeadTTS first
git clone https://github.com/YOUR_ORG/HeadTTS /tmp/HeadTTS
HEADTTS_DIR=/tmp/HeadTTS node scripts/generate/headtts-parity.mjs
```

**Why:** Script needs upstream HeadTTS to extract rules.

---

## Future Improvements

### Potential optimizations

1. **Parallel dictionary downloads** — `setup-dictionaries.sh` currently runs sequentially
2. **Dictionary checksums** — verify integrity after download
3. **Incremental wasm builds** — only rebuild if Rust sources changed
4. **Dictionary versioning** — track dictionary versions in lockfile

### Considered but rejected

1. **Embed dictionaries in wasm** — Would make wasm >20 MB (too large)
2. **Download dictionaries on first use** — Breaks offline builds
3. **Use git LFS for dictionaries** — Adds complexity, worse DX than GitHub Releases

---

## See Also

- [P6 Rust Phonemize Specification](../docs/superpowers/plans/P6-FINAL.md)
- [Build System Overview](../README.md#build)
- [Dictionary Protocol](../docs/superpowers/plans/p6-implementation-summary.md)
