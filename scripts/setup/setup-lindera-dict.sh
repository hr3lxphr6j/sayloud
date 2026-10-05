#!/usr/bin/env bash
#
# Builds the Japanese dictionary asset the Rust phonemizer loads.
#
# IPADic ships from lindera's GitHub releases as a zip of nine files, and the
# extension ships it as one zstd frame holding a tar of those nine. The tar is a
# transport wrapper and nothing more: the files inside are lindera's own, byte for
# byte, because lindera's dictionary format is a decision the P6 spec already made
# (decision #18) and re-packing it would be a second format to keep working.
#
# The frame is zstd rather than the release's deflate for a reason worth writing
# down: the wasm decompresses it with `ruzstd` (spec §2.5), and zstd over the raw
# files is ~4.5x. Over the release's *zip* it would be nothing at all, because
# deflate output is already incompressible — which is why the zip is unpacked here
# rather than shipped.
#
# Idempotent: an existing asset is left alone. Set FORCE=1 to rebuild it.
#
# `pnpm install` runs this through `postinstall`, where a failure is tolerated —
# an offline checkout should still install. That tolerance is safe because the
# asset's absence is *not* tolerated anywhere else: the Japanese pipeline tests
# fail with the command to fix it rather than skipping (see
# `crates/phonemize/tests/common/mod.rs`). So this script can exit non-zero on a
# download that did not happen, and something still says so.
set -euo pipefail

# Two levels, not one: this file lives in `scripts/setup/`, and `public/dictionaries`
# below is repository-relative. One `..` lands in `scripts/`, which is not an error —
# the asset is built into `scripts/public/dictionaries/` and nothing reads it, so the
# failure only shows up later as a missing dictionary.
cd "$(dirname "$0")/../.."

# Pinned: the dictionary and the crate that reads it have to be the same
# generation. lindera's format version is checked by `Metadata::validate` at load
# time, but only against itself — a mismatch here shows up as a dictionary that
# will not load at all.
LINDERA_VERSION="6.2.0"
ASSET_NAME="lindera-ipadic-ja"
RELEASE_URL="https://github.com/lindera/lindera/releases/download/v${LINDERA_VERSION}/lindera-ipadic-${LINDERA_VERSION}.zip"

DICT_DIR="public/dictionaries"
TARGET="${DICT_DIR}/${ASSET_NAME}.bin.zst"
NOTICE="${DICT_DIR}/${ASSET_NAME}-NOTICE.txt"

# The nine files lindera's `load_from_path` reads. Listed explicitly, and in a
# fixed order, so the archive is the same on every machine; a glob would make the
# contents depend on the filesystem.
DICTIONARY_FILES=(
  dict.trie
  dict.valsidx
  dict.vals
  dict.wordsidx
  dict.words
  char_def.bin
  unk.bin
  matrix.mtx
  metadata.json
)

if [ -s "$TARGET" ] && [ "${FORCE:-0}" != "1" ]; then
  echo "✓ Japanese dictionary already built: $TARGET ($(du -h "$TARGET" | cut -f1))"
  exit 0
fi

missing=()
for tool in curl unzip tar zstd; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "⚠️  Cannot build the Japanese dictionary: missing ${missing[*]}" >&2
  echo "   Install them (macOS: brew install zstd) and re-run:" >&2
  echo "   FORCE=1 ./scripts/setup/setup-lindera-dict.sh" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "📚 Building the Japanese dictionary (IPADic ${LINDERA_VERSION})..."
curl --fail --location --silent --show-error --max-time 600 \
  "$RELEASE_URL" -o "$work/ipadic.zip"

unzip -q "$work/ipadic.zip" -d "$work"

# The release unpacks into a single top-level directory; find it rather than
# hard-coding the name, so a change of prefix is not a broken build.
root="$(find "$work" -mindepth 1 -maxdepth 1 -type d -name 'lindera-ipadic*' | head -1)"
if [ -z "$root" ]; then
  echo "⚠️  The archive does not contain a lindera-ipadic directory" >&2
  exit 1
fi

for file in "${DICTIONARY_FILES[@]}"; do
  if [ ! -f "${root}/${file}" ]; then
    echo "⚠️  The archive has no ${file}" >&2
    exit 1
  fi
done

mkdir -p "$DICT_DIR"

# Written to a temporary name and moved into place, so an interrupted run leaves
# no half a dictionary for the loader to find — the cache guard in
# `lib/models/phonemize-dict.ts` would catch it, but only after it had been
# fetched and rejected once.
tar -cf - -C "$root" "${DICTIONARY_FILES[@]}" | zstd -19 -q -o "${TARGET}.tmp"
mv "${TARGET}.tmp" "$TARGET"

# IPADic is BSD-licensed and the notice is a condition of redistributing it. It
# is kept next to the asset rather than inside the archive because it is not a
# file lindera reads, and the loader should not have to know about it.
if [ -f "${root}/NOTICE.txt" ]; then
  cp "${root}/NOTICE.txt" "$NOTICE"
fi

echo "✓ Japanese dictionary ready: $TARGET ($(du -h "$TARGET" | cut -f1))"
