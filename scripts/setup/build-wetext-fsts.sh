#!/usr/bin/env bash
#
# Produce the eight WeText TN grammars the extension ships, from the grammar we
# own (`tools/fst-build/`, upstream as a submodule), and place them where the
# app reads them: `public/dictionaries/wetext-*.bin.zst`.
#
# This is the only builder. The wheel-extraction script it replaced is gone:
# a grammar without `tools/fst-build/rules/` reads some pinned shapes differently,
# so there is no correct fallback that skips the source build.
#
# Byte identity is a CI property, not a local one
# -----------------------------------------------
# The committed baseline (`tools/fst-build/lock.json`) is produced on
# linux/amd64. A native ARM build is behaviourally identical but renumbers the
# English states (see docs/superpowers/REPORT.md), so this script does *not*
# check hashes: it only checks that the files were produced and that the
# compressed assets decompress. `tools/fst-build/verify.py` is the amd64 check.
#
# Builders, in order of preference
# --------------------------------
#   docker  the pinned linux/amd64 image (fast when the image is present)
#   native  a Python that can `import pynini`; on Apple Silicon that is a
#           conda-forge environment, because PyPI has no arm64 wheel. If none
#           is given and micromamba is available, one is created under
#           `node_modules/.cache/sayloud-fst/` (one time, ~1 minute).
#
# Overrides
# ---------
#   FST_SOURCE=docker|native|auto         (default: auto)
#   FST_PYTHON=/path/to/python            (native; must import pynini)
#   FST_DOCKER_IMAGE=fstbuild             (docker tag to use; rebuilt if absent)
#   FST_REBUILD=1                         force a rebuild
#
# Invoked by `pnpm build:fst`, which `prebuild`/`prezip` run,
# `scripts/setup/setup-dictionaries.sh`, and directly:
#   ./scripts/setup/build-wetext-fsts.sh

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

DICT_DIR="public/dictionaries"
FST_DIR="tools/fst-build"
UPSTREAM="$FST_DIR/upstream/WeTextProcessing"
CACHE_DIR="node_modules/.cache/sayloud-fst"
STAMP="$CACHE_DIR/stamp"

# The eight files, as `<path inside the build dir>:<asset name>`.
ASSETS=(
  "en/tn/tagger.fst:wetext-en-tn-tagger"
  "en/tn/verbalizer.fst:wetext-en-tn-verbalizer"
  "zh/tn/tagger.fst:wetext-zh-tn-tagger"
  "zh/tn/verbalizer.fst:wetext-zh-tn-verbalizer"
  "ja/tn/tagger.fst:wetext-ja-tn-tagger"
  "ja/tn/verbalizer.fst:wetext-ja-tn-verbalizer"
  "full_to_half.fst:wetext-tn-full-to-half"
  "traditional_to_simple.fst:wetext-zh-tn-traditional-to-simple"
)

# Progress goes to stderr: `bootstrap_native` is called in a command
# substitution and its stdout is the interpreter path, so a `say` on stdout
# would become part of the path (and did, on CI).
say() { printf '%s\n' "$*" >&2; }
warn() { printf '⚠️  %s\n' "$*" >&2; }
die() { printf '❌ %s\n' "$*" >&2; exit 1; }

digest() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 | cut -d' ' -f1
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum | cut -d' ' -f1
  else
    die "neither shasum nor sha256sum is available"
  fi
}

# Everything that can change the grammars. The Dockerfile and the lock are in
# the hash so a toolchain or baseline bump rebuilds; the builder is *not*, so
# switching docker→native does not silently keep the other one's assets — the
# mode is compared separately below.
inputs_digest() {
  {
    printf 'build.py\n'; cat "$FST_DIR/build.py"
    printf 'build_min.py\n'; cat "$FST_DIR/build_min.py"
    printf 'build_extras.py\n'; cat "$FST_DIR/build_extras.py"
    printf 'rules\n'; find "$FST_DIR/rules" -type f -not -path '*__pycache__*' | sort | xargs cat
    printf 'lock\n'; cat "$FST_DIR/lock.json"
    printf 'dockerfile\n'; cat "$FST_DIR/Dockerfile"
    if [ -d "$UPSTREAM/.git" ] || [ -f "$UPSTREAM/.git" ]; then
      printf 'upstream\n'; git -C "$UPSTREAM" rev-parse HEAD
    fi
  } | digest
}

assets_present() {
  local entry name
  for entry in "${ASSETS[@]}"; do
    name="${entry#*:}"
    [ -s "$DICT_DIR/$name.bin.zst" ] || return 1
  done
  return 0
}

ensure_submodule() {
  if [ -f "$UPSTREAM/tn/processor.py" ]; then
    return 0
  fi
  say "📥 Initialising the WeTextProcessing submodule..."
  git submodule update --init --depth 1 "$UPSTREAM" \
    || git submodule update --init "$UPSTREAM" \
    || die "could not initialise $UPSTREAM"
  [ -f "$UPSTREAM/tn/processor.py" ] || die "$UPSTREAM does not look like WeTextProcessing"
}

# The build dir the chosen builder filled. Set by each build_* function.
BUILD_DIR=""
BUILDER=""

build_docker() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1

  local image="${FST_DOCKER_IMAGE:-fstbuild}"
  if ! docker image inspect "$image" >/dev/null 2>&1 || [ "${FST_REBUILD:-0}" = "1" ]; then
    say "🐳 Building the grammar image ($image)..."
    docker build --platform linux/amd64 -t "$image" "$FST_DIR" >/dev/null \
      || { warn "docker build failed (registry or network); trying the next builder"; return 1; }
  fi

  BUILD_DIR="$CACHE_DIR/out-docker"
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"
  say "🐳 Building the grammars in linux/amd64..."
  docker run --rm --platform linux/amd64 --memory=2g \
    -v "$ROOT/$FST_DIR:/work" -v "$ROOT/$BUILD_DIR:/out" -w /work \
    "$image" python /work/build.py --langs en,zh,ja --out /out \
    || { warn "the container build failed; trying the next builder"; return 1; }
  BUILDER="docker"
}

native_python() {
  if [ -n "${FST_PYTHON:-}" ]; then
    printf '%s\n' "$FST_PYTHON"
    return 0
  fi
  if python3 -c 'import pynini' >/dev/null 2>&1; then
    printf '%s\n' "$(command -v python3)"
    return 0
  fi
  if [ -x "$CACHE_DIR/py/bin/python" ] && "$CACHE_DIR/py/bin/python" -c 'import pynini' >/dev/null 2>&1; then
    printf '%s\n' "$CACHE_DIR/py/bin/python"
    return 0
  fi
  return 1
}

bootstrap_native() {
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) local platform=osx-arm64 ;;
    Darwin-x86_64) local platform=osx-64 ;;
    Linux-x86_64) local platform=linux-64 ;;
    Linux-aarch64 | Linux-arm64) local platform=linux-aarch64 ;;
    *) warn "no micromamba build for $(uname -s)-$(uname -m)"; return 1 ;;
  esac

  local mamba="$CACHE_DIR/bin/micromamba"
  if [ ! -x "$mamba" ]; then
    command -v curl >/dev/null 2>&1 || return 1
    mkdir -p "$CACHE_DIR/bin"
    say "📦 Downloading micromamba ($platform)..."
    if ! curl -fsSL "https://micro.mamba.pm/api/micromamba/$platform/latest" \
      | tar -xj -C "$CACHE_DIR" bin/micromamba; then
      warn "could not download micromamba for $platform"
      return 1
    fi
  fi

  if [ ! -x "$CACHE_DIR/py/bin/python" ]; then
    say "🐍 Creating a pynini environment (one time, conda-forge; PyPI has no arm64 wheel)..."
    if ! MAMBA_ROOT_PREFIX="$CACHE_DIR/mamba" "$mamba" create -y -q \
      -p "$CACHE_DIR/py" -c conda-forge python=3.11 pynini=2.1.7 \
      >"$CACHE_DIR/bootstrap.log" 2>&1; then
      warn "micromamba create failed; last lines of $CACHE_DIR/bootstrap.log:"
      tail -n 20 "$CACHE_DIR/bootstrap.log" >&2 || true
      return 1
    fi
    # A transaction that exits 0 can still leave an interpreter that cannot
    # load its libraries; check here so the reason travels with the failure.
    if ! "$CACHE_DIR/py/bin/python" -c 'import pynini' >/dev/null 2>&1; then
      warn "the environment was created but pynini does not import:"
      "$CACHE_DIR/py/bin/python" -c 'import pynini' 2>&1 | tail -n 8 >&2 || true
      MAMBA_ROOT_PREFIX="$CACHE_DIR/mamba" "$mamba" list -p "$CACHE_DIR/py" 2>&1 | tail -n 15 >&2 || true
      return 1
    fi
  fi
  printf '%s\n' "$CACHE_DIR/py/bin/python"
}

build_native() {
  local python
  if ! python="$(native_python)"; then
    python="$(bootstrap_native)" || return 1
    # Defence in depth: the path is the last line even if something upstream
    # ever writes to stdout again.
    python="${python##*$'\n'}"
  fi
  if ! "$python" -c 'import pynini' >/dev/null 2>&1; then
    warn "$python cannot import pynini:"
    "$python" -c 'import pynini' 2>&1 | tail -n 5 >&2 || true
    "$python" -V >&2 || true
    return 1
  fi
  # Absolute: the build runs after `cd "$FST_DIR"`, where a relative cache path
  # to the interpreter no longer resolves.
  python="$(cd "$(dirname "$python")" && pwd)/$(basename "$python")"

  BUILD_DIR="$CACHE_DIR/out-native"
  rm -rf "$BUILD_DIR"
  mkdir -p "$BUILD_DIR"
  say "🐍 Building the grammars natively with $("$python" -c 'import sys; print(sys.version.split()[0])')..."
  ( cd "$FST_DIR" && PYTHONPATH="$UPSTREAM" "$python" build.py --langs en,zh,ja --out "$ROOT/$BUILD_DIR" ) \
    || { warn "the native build failed"; return 1; }
  BUILDER="native"
}

# 1. Nothing to do?
if [ "${FST_REBUILD:-0}" != "1" ] && assets_present; then
  current="$(inputs_digest)"
  if [ -f "$STAMP" ] && grep -qx "inputs=$current" "$STAMP"; then
    say "✓ text-normalization grammars are up to date ($DICT_DIR)"
    exit 0
  fi
fi

# 2. Pick a builder.
mode="${FST_SOURCE:-auto}"
ensure_submodule
case "$mode" in
  auto)
    build_docker || build_native \
      || die "no builder worked (docker, then native); set FST_SOURCE or FST_PYTHON"
    ;;
  docker)
    build_docker || die "FST_SOURCE=docker but Docker is not usable"
    ;;
  native)
    build_native || die "FST_SOURCE=native but no Python with pynini could be prepared (set FST_PYTHON)"
    ;;
  *)
    die "unknown FST_SOURCE=$mode (expected auto|docker|native)"
    ;;
esac

# 3. Compress the build into the names the app loads.
[ -n "$BUILD_DIR" ] || die "no build directory was produced"
command -v zstd >/dev/null 2>&1 \
  || die "zstd is required to compress the grammars (brew install zstd / apt install zstd)"

mkdir -p "$DICT_DIR"
for entry in "${ASSETS[@]}"; do
  path="${entry%%:*}"
  name="${entry#*:}"
  [ -s "$BUILD_DIR/$path" ] || die "the build did not produce $path"
  zstd -19 -q -c "$BUILD_DIR/$path" > "$DICT_DIR/$name.bin.zst"
  # A frame that does not decompress is a packaging bug, not a reading bug.
  zstd -q -t "$DICT_DIR/$name.bin.zst" || die "$name.bin.zst does not decompress"
done

assets_present || die "the grammars are still missing after the build"

# 4. Remember what produced these assets.
mkdir -p "$CACHE_DIR"
{
  printf 'inputs=%s\n' "$(inputs_digest)"
  printf 'builder=%s\n' "$BUILDER"
  printf 'source=%s\n' "$mode"
} > "$STAMP"

say ""
say "✅ Text-normalization grammars ready in $DICT_DIR (builder: $BUILDER)"
if [ "$BUILDER" != "docker" ]; then
  say "   Native build: behaviourally equivalent to the amd64 baseline, but not byte-identical"
  say "   (English states are renumbered). CI asserts the bytes; this machine does not."
fi
