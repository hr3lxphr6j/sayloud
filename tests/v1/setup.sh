#!/usr/bin/env bash
#
# P6 V1 verification environment, rebuilt from scratch.
#
#   bash tests/v1/setup.sh
#
# Four idempotent steps:
#   1. install `piper-plus@0.7.0` into an isolated sandbox (NOT into the
#      project's package.json -- the tarball is 60 MB, and this is an
#      evaluation, not a dependency).
#   2. link `tests/v1/node_modules` at the sandbox so the *documented* entry
#      point `piper-plus/wasm/multilingual` resolves the way a real consumer
#      would import it.
#   3. fetch the Chinese pinyin dictionaries from upstream `dev`. The npm
#      tarball does not contain them (see install-report.md §4), so without
#      this step the Chinese path can only be measured in its as-shipped
#      passthrough state.
#   4. convert those dictionaries from accented pinyin to tone-number (TONE3)
#      pinyin, because the Rust phonemizer parses a trailing tone digit and
#      the upstream files carry diacritics instead (api-exploration.md §5).
#
# Everything lands in `tests/v1/.sandbox/`, which is gitignored: the
# deliverables are the JSON reports and the markdown, not the binaries.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX="$HERE/.sandbox"
ASSETS="$SANDBOX/upstream-assets"
DERIVED="$SANDBOX/derived"
REPO_RAW="https://raw.githubusercontent.com/ayutaz/piper-plus/dev"

echo "== 1. install piper-plus@0.7.0 (isolated sandbox) =="
mkdir -p "$SANDBOX"
if [ ! -f "$SANDBOX/package.json" ]; then
  printf '{\n  "name": "piper-v1-sandbox",\n  "private": true,\n  "type": "module"\n}\n' > "$SANDBOX/package.json"
fi
(cd "$SANDBOX" && npm install piper-plus@0.7.0 --no-audit --no-fund)

echo "== 2. link tests/v1/node_modules -> .sandbox/node_modules =="
ln -sfn .sandbox/node_modules "$HERE/node_modules"

echo "== 3. fetch upstream assets the npm tarball omits =="
mkdir -p "$ASSETS"
fetch() { # fetch <repo-relative-path> <local-name>
  curl -sfL -o "$ASSETS/$2" "$REPO_RAW/$1"
  echo "   $2 ($(wc -c < "$ASSETS/$2" | tr -d ' ') bytes)"
}
fetch src/wasm/openjtalk-web/assets/pinyin_single.json   pinyin_single.json
fetch src/wasm/openjtalk-web/assets/pinyin_phrases.json  pinyin_phrases.json
fetch src/wasm/g2p/src/pua-map.js                        pua-map.js
fetch docs/spec/pua-contract.toml                        pua-contract.toml
fetch src/python/g2p/piper_plus_g2p/encode/id_maps.py    id_maps.py

echo "== 4. convert pinyin dictionaries to TONE3 =="
node "$HERE/scripts/convert-pinyin-tone3.mjs" "$ASSETS" "$DERIVED"

echo
echo "done. sanity check:"
echo "  node tests/v1/performance-benchmark.mjs"
echo "  npx vitest run --config tests/v1/vitest.config.ts"
