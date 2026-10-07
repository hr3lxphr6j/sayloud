#!/usr/bin/env bash
#
# Builds the phonemize wasm module.
#
# wasm-pack writes the JS glue and the .d.ts next to the .wasm, and that output
# directory is what `lib/models/phonemize-rust.ts` imports and what `tsc` reads
# types from. It is a build artifact, not source, and is git-ignored — so
# anything that type-checks or tests the wrapper needs this to have run first.
# `pnpm build` does it through the `prebuild` hook; CI does it explicitly,
# before `pnpm typecheck`.
set -euo pipefail

# Two levels, not one: this file lives in `scripts/build/`, and everything below
# is repository-relative. One `..` lands in `scripts/`, where `wasm-pack` finds no
# crate — and it does that *loudly*, which is the only reason a `..` that is one
# short can be told apart from a working build.
cd "$(dirname "$0")/../.."

if ! command -v wasm-pack >/dev/null 2>&1; then
  echo "wasm-pack not found. Install it with: cargo install wasm-pack" >&2
  exit 1
fi

# `--out-dir` is resolved relative to the crate directory, not the repo root.
wasm-pack build crates/phonemize \
  --target web \
  --out-dir ../../lib/models/phonemize-wasm \
  --release

echo "phonemize.wasm built to lib/models/phonemize-wasm/"
