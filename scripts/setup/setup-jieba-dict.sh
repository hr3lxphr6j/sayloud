#!/usr/bin/env bash
#
# Builds the Chinese word-segmentation dictionary the Rust phonemizer loads.
#
# The dictionary is jieba's own `dict.txt`, taken from the same tag of the same
# crate the wasm links against (`jieba-rs`), and shipped as one zstd frame. That
# is a parity requirement rather than a convenience: the JavaScript pipeline
# segments with `jieba-wasm`, which is this crate compiled to wasm, and the two
# have to agree on where words end before their output can be compared. The
# sha256 below is checked on every build, so the file cannot change under the
# crate that reads it; before this module existed, a one-off cross-check found
# `jieba-rs` 0.11.0 with this file and `jieba-wasm` 2.4.0 segmenting a
# 98-sentence corpus identically on all 98.
#
# **Why the dictionary is not inside the wasm.** `jieba-rs`'s `default-dict`
# feature does embed it, through `include-flate`, and that path cannot link for
# `wasm32-unknown-unknown` on macOS: `include-flate` decompresses with the C
# `zstd` crate at runtime, and `zstd-sys` archives its wasm objects with the host
# `ar`, which only understands Mach-O. It writes an archive holding no members
# and the link then fails on every `ZSTD_*` symbol —
# `undefined symbol: ZSTD_freeDCtx`, reproduced on 2026-10-03. That is the same
# failure `Cargo.toml` documents for `ruzstd`, and it is why `jieba-rs` is
# depended on with `default-features = false` and the dictionary is a separate
# asset instead. The wasm-side decoder is `ruzstd`, which is already there for
# IPADic.
#
# Idempotent: an existing asset is left alone. Set FORCE=1 to rebuild it.
#
# `pnpm install` runs this through `postinstall`, where a failure is tolerated —
# an offline checkout should still install. That tolerance is safe because the
# asset's absence is *not* tolerated anywhere else: the Chinese pipeline tests
# fail with the command to fix it rather than skipping (see
# `crates/phonemize/tests/common/mod.rs`).
set -euo pipefail

cd "$(dirname "$0")/.."

# Pinned: the dictionary and the crate that reads it have to be the same
# generation. `jieba-rs` validates nothing about the file it is handed — it is a
# plain `word freq tag` list — so a dictionary from a different release would
# load happily and segment differently.
JIEBA_VERSION="0.11.0"
DICT_URL="https://raw.githubusercontent.com/messense/jieba-rs/v${JIEBA_VERSION}/jieba/src/data/dict.txt"

# The sha256 of that file, so a moved tag or a truncated download is loud here
# rather than audible later. Verified against the copy inside the published
# `jieba-rs` 0.11.0 crate, which is byte-identical.
DICT_SHA256="139519822fe8ab9e10d9d07e68ea0451045380aedaf54ecc51e2a28c6b42a13f"

ASSET_NAME="jieba-zh-dict"
DICT_DIR="public/dictionaries"
TARGET="${DICT_DIR}/${ASSET_NAME}.bin.zst"
NOTICE="${DICT_DIR}/${ASSET_NAME}-NOTICE.txt"

if [ -s "$TARGET" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "✓ Chinese dictionary already built: $TARGET ($(du -h "$TARGET" | cut -f1))"
  exit 0
fi

missing=()
for tool in curl zstd; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "⚠️  Cannot build the Chinese dictionary: missing ${missing[*]}" >&2
  echo "   Install them (macOS: brew install zstd) and re-run:" >&2
  echo "   FORCE=1 ./scripts/setup/setup-jieba-dict.sh" >&2
  exit 1
fi

# `shasum` on macOS, `sha256sum` on Linux. Checked before the download rather
# than after, because a checksum that silently cannot run is worse than none.
if command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d' ' -f1; }
else
  echo "⚠️  Cannot build the Chinese dictionary: no shasum or sha256sum" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "📚 Building the Chinese dictionary (jieba-rs ${JIEBA_VERSION})..."
curl --fail --location --silent --show-error --max-time 600 "$DICT_URL" -o "$work/dict.txt"

actual="$(digest "$work/dict.txt")"
if [ "$actual" != "$DICT_SHA256" ]; then
  echo "⚠️  The dictionary is not the one jieba-rs ${JIEBA_VERSION} ships" >&2
  echo "   expected sha256 $DICT_SHA256" >&2
  echo "   got      sha256 $actual" >&2
  exit 1
fi

mkdir -p "$DICT_DIR"

# Written to a temporary name and moved into place, so an interrupted run leaves
# no half a dictionary for the loader to find — the cache guard in
# `lib/models/phonemize-dict.ts` would catch it, but only after it had been
# fetched and rejected once.
zstd -19 -q -f -o "${TARGET}.tmp" "$work/dict.txt"
mv "${TARGET}.tmp" "$TARGET"

# jieba's dictionary is MIT-licensed, as is the crate that ships it. The notice
# is kept next to the asset rather than inside the frame because it is not
# something the loader reads, and the loader should not have to know about it.
cat > "$NOTICE" <<'NOTICE_TEXT'
===========================================================================
Jieba Chinese word segmentation dictionary
===========================================================================

This software includes a data file from

  jieba-rs  (https://github.com/messense/jieba-rs)
  MIT License, Copyright (c) 2019 messense

  jieba     (https://github.com/fxsjy/jieba)
  MIT License, Copyright (c) 2013 Sun Junyi

`dict.txt` is jieba-rs's copy of the Python jieba project's word frequency
list. It is redistributed here unchanged, as a zstd frame, under the MIT
License. Both projects are distributed on an "AS IS" BASIS, WITHOUT
WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
NOTICE_TEXT

echo "✓ Chinese dictionary ready: $TARGET ($(du -h "$TARGET" | cut -f1))"
