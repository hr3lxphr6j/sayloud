#!/usr/bin/env bash
#
# Downloads and builds all dictionary assets the Rust phonemizer needs.
#
# This is the single entry point for setting up dictionaries. It calls the
# individual setup scripts in order, each of which is idempotent (won't
# re-download if the asset already exists).
#
# Run this manually with:
#   ./scripts/setup/setup-dictionaries.sh
#
# Or force a rebuild with:
#   FORCE=1 ./scripts/setup/setup-dictionaries.sh
#
# This script is called by `pnpm install` through the `postinstall` hook in
# package.json. A failure is tolerated there (offline checkout should still
# install), but tests will fail with clear instructions if dictionaries are
# missing.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

echo "📚 Setting up all dictionaries..."
echo ""

# Each script is idempotent and reports its own status
"$SCRIPT_DIR/setup-jieba-dict.sh"
echo ""

"$SCRIPT_DIR/setup-lindera-dict.sh"
echo ""

"$SCRIPT_DIR/setup-wetext-fsts.sh"
echo ""

echo "✅ All dictionaries ready in public/dictionaries/"
