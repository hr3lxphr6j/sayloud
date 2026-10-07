#!/usr/bin/env bash
#
# Builds the text-normalization grammars the Rust phonemizer loads.
#
# These are the weighted-FST *TN* grammars for English, Chinese and Japanese,
# taken from the `wetext` Python distribution — which is the upstream
# WeTextProcessing project's own build of them, published as part of a wheel
# rather than as a separate data release. `crates/phonemize/src/tn/wetext/`
# is a copy of SpenserCai's Rust port that reads exactly this file format; its
# `NOTICE` says why the source is copied rather than depended on.
#
# **Why the FSTs are not inside the wasm.** A dictionary is fetched on
# `prepare` and decompressed inside the module. Raw, the six frames
# are 14.4 MB — five times the size of the rest of the phonemizer wasm if they
# were `include_bytes!`'d. They arrive through the same registry IPADic and
# jieba's word list do.
#
# Only `{en,zh,ja}/tn/{tagger,verbalizer}` are needed. The wheel also ships
# `prefix`, `prefix_matcher`, `itn`, `full_to_half`, `traditional_to_simple`,
# `remove_interjections`, `remove_puncts` and `tag_oov`; the normalizer
# configuration this crate builds asks for none of them — no prefix matcher, no
# ITN grammar, and every flag that would pull in a post-processor is left off,
# which is also what the Python reference defaults to — so shipping them would be
# files that nothing ever reads.
#
# **Both halves of a language or neither.** The tagger is the half that
# recognizes an entity and the verbalizer is the half that says it; one without
# the other can only fail, and `crates/phonemize/src/lib.rs` refuses to build a
# language's normalizer unless both of its grammars arrived.
#
# Idempotent: an existing asset is left alone. Set FORCE=1 to rebuild it.
#
# `pnpm install` runs this through `postinstall`, where a failure is tolerated —
# an offline checkout should still install. That tolerance is safe because the
# asset's absence is *not* tolerated anywhere else: the TN tests fail with the
# command to fix it rather than skipping (see
# `crates/phonemize/tests/common/mod.rs`).
set -euo pipefail

# Two levels, not one: this file lives in `scripts/setup/`, and `public/dictionaries`
# below is repository-relative. One `..` lands in `scripts/`, which is not an error —
# the grammars are built into `scripts/public/dictionaries/` and nothing reads them,
# so the failure only shows up later as a missing dictionary.
cd "$(dirname "$0")/../.."

# Pinned: the grammatical content is the data, and the Rust side validates
# nothing about it. A different wheel is a different normalizer — `1,234` came
# out as `一千两百三十四` in one version of the Chinese grammar and
# `一千二百三十四` in another, which is the kind of change that has to be a
# deliberate bump rather than a moving tag.
WETEXT_VERSION="0.1.8"
WHEEL_URL="https://files.pythonhosted.org/packages/43/fe/ca7ccae2673b64ba7d63612e68b31963e3842dd77fb6aa632270d123d685/wetext-${WETEXT_VERSION}-py3-none-any.whl"

# The sha256 of that wheel, so a moved file or a truncated download is loud here
# rather than audible later. It covers the FSTs inside it as well, which is
# better than pinning each one: the archive is what was published.
WHEEL_SHA256="b2083e7f38ac38fcbecdf7aec6ac6f0e3d1a11b763facfa4daabc12138215454"

# The languages, and the two grammars each one needs.
LANGUAGES="en zh ja"
KINDS="tagger verbalizer"

DICT_DIR="public/dictionaries"

# The registry name one grammar is keyed under. `wetext-en-tn-tagger` and so on
# — the same spelling `crates/phonemize/src/dictionary.rs` uses, which is what
# `dictionaryUrl` on the JavaScript side turns into a path.
asset_name() { echo "wetext-$1-tn-$2"; }

# Whether every asset is already there, so the common case is one `test`.
complete=1
for lang in $LANGUAGES; do
  for kind in $KINDS; do
    [ -s "${DICT_DIR}/$(asset_name "$lang" "$kind").bin.zst" ] || complete=0
  done
done
if [ "$complete" = 1 ] && [ "${FORCE:-0}" != "1" ]; then
  echo "✓ text-normalization grammars already built (${DICT_DIR}/wetext-*-tn-*.bin.zst)"
  exit 0
fi

missing=()
for tool in curl unzip zstd; do
  command -v "$tool" >/dev/null 2>&1 || missing+=("$tool")
done
if [ ${#missing[@]} -gt 0 ]; then
  echo "⚠️  Cannot build the text-normalization grammars: missing ${missing[*]}" >&2
  echo "   Install them (macOS: brew install zstd) and re-run:" >&2
  echo "   FORCE=1 ./scripts/setup/setup-wetext-fsts.sh" >&2
  exit 1
fi

# `shasum` on macOS, `sha256sum` on Linux. Checked before the download rather
# than after, because a checksum that silently cannot run is worse than none.
if command -v shasum >/dev/null 2>&1; then
  digest() { shasum -a 256 "$1" | cut -d' ' -f1; }
elif command -v sha256sum >/dev/null 2>&1; then
  digest() { sha256sum "$1" | cut -d' ' -f1; }
else
  echo "⚠️  Cannot build the text-normalization grammars: no shasum or sha256sum" >&2
  exit 1
fi

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "📚 Building the text-normalization grammars (wetext ${WETEXT_VERSION})..."
curl --fail --location --silent --show-error --max-time 600 "$WHEEL_URL" -o "$work/wetext.whl"

actual="$(digest "$work/wetext.whl")"
if [ "$actual" != "$WHEEL_SHA256" ]; then
  echo "⚠️  The wheel is not wetext ${WETEXT_VERSION}" >&2
  echo "   expected sha256 $WHEEL_SHA256" >&2
  echo "   got      sha256 $actual" >&2
  exit 1
fi

unzip -q "$work/wetext.whl" -d "$work/wheel"

mkdir -p "$DICT_DIR"

# Written to a temporary name and moved into place, so an interrupted run leaves
# no half a grammar for the loader to find — the FST parser would reject it, but
# only after the fetch that the cache guard in `lib/models/phonemize-dict.ts`
# would then have to notice.
for lang in $LANGUAGES; do
  for kind in $KINDS; do
    name="$(asset_name "$lang" "$kind")"
    src="$work/wheel/wetext/fsts/${lang}/tn/${kind}.fst"

    if [ ! -s "$src" ]; then
      echo "⚠️  The wheel has no ${src#$work/wheel/} — it is not the layout this script knows" >&2
      exit 1
    fi

    zstd -19 -q -f -o "${DICT_DIR}/${name}.bin.zst.tmp" "$src"
    mv "${DICT_DIR}/${name}.bin.zst.tmp" "${DICT_DIR}/${name}.bin.zst"
    printf '   %-32s %s\n' "${name}.bin.zst" "$(du -h "${DICT_DIR}/${name}.bin.zst" | cut -f1)"
  done
done

# The grammar is Apache-2.0, as is the Rust port that runs it. One notice per
# language, named after that language's assets, because the three are separate
# grammars built from separate Python files and a reader looking at one of them
# should not have to work out which. The notice sits *next to* the asset rather
# than inside the frame: it is not something the loader reads, and the loader
# should not have to know about it.
notice() {
  cat > "$1" <<NOTICE_TEXT
===========================================================================
WeText ${2} text-normalization grammars
===========================================================================

This software includes data files from

  WeTextProcessing  (https://github.com/wenet-e2e/WeTextProcessing)
  Copyright 2021 Wenet Community
  Apache License, Version 2.0

  wetext            (https://pypi.org/project/wetext/) ${WETEXT_VERSION}
  Apache License, Version 2.0

\`${3}/tn/tagger.fst\` and \`${3}/tn/verbalizer.fst\` are the ${2} text
normalization grammars as the \`wetext\` distribution builds them, extracted from
\`wetext-${WETEXT_VERSION}-py3-none-any.whl\` and redistributed unchanged as zstd
frames. The Rust code that runs them is in
\`crates/phonemize/src/tn/wetext/\`, which has its own NOTICE.

Both projects are distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR
CONDITIONS OF ANY KIND, either express or implied.
NOTICE_TEXT
}

notice "${DICT_DIR}/wetext-en-tn-NOTICE.txt" English en
notice "${DICT_DIR}/wetext-zh-tn-NOTICE.txt" Chinese zh
notice "${DICT_DIR}/wetext-ja-tn-NOTICE.txt" Japanese ja

echo "✓ text-normalization grammars ready in ${DICT_DIR}/"
