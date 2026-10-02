#!/usr/bin/env bash
# Rebuild everything the listening harness needs (spike, throwaway).
#
#   bash poc/kokoro-zh-samples/setup.sh
#
# Idempotent: skips whatever is already there. Written because /tmp does not
# survive a reboot — it was cleared once already, which cost a re-download of
# 650 MB of models and a re-created virtualenv before the harness would run
# again. Everything lands under /tmp by design (nothing large in the repo), so
# this script *is* the durability story: run it after a restart.
set -euo pipefail

VENV=/tmp/zhvenv
V10=/tmp/kokoro-v10
V11=/tmp/kokoro-poc-models
JIEBA=/tmp/jieba-check
PY="$VENV/bin/python"

say() { printf '\n=== %s\n' "$*"; }

say "python venv ($VENV)"
if [ ! -x "$PY" ]; then
  python3 -m venv "$VENV"
  "$VENV/bin/pip" install --quiet --upgrade pip
fi
"$VENV/bin/pip" install --quiet \
  pypinyin pypinyin-dict jieba cn2an addict ordered-set numpy onnxruntime

say "misaki zh 前端 ($V11/misakizh)"
# The front end is five files from GitHub. It is NOT installed as a package on
# purpose: `pip install misaki` drags in spacy and torch for the English half,
# which this harness never touches.
mkdir -p "$V11/misakizh/misaki"
for f in token.py zh_frontend.py tone_sandhi.py zh.py transcription.py; do
  [ -s "$V11/misakizh/misaki/$f" ] || curl -sSL -o "$V11/misakizh/misaki/$f" \
    "https://raw.githubusercontent.com/hexgrad/misaki/main/misaki/$f"
done
touch "$V11/misakizh/misaki/__init__.py"

say "Kokoro v1.0 模型 + 中文音色 ($V10)"
mkdir -p "$V10/voices"
B10=https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main
[ -s "$V10/tokenizer.json" ] || curl -sSL -o "$V10/tokenizer.json" "$B10/tokenizer.json"
[ -s "$V10/model.onnx" ]     || curl -sSL -o "$V10/model.onnx" "$B10/onnx/model.onnx"
# All eight Chinese voices are 522 KB each; fetch them so V10_VOICE can be
# switched in make-samples.py without another download.
for v in zf_xiaobei zf_xiaoni zf_xiaoxiao zf_xiaoyi zm_yunjian zm_yunxi zm_yunxia zm_yunyang; do
  [ -s "$V10/voices/$v.bin" ] || curl -sSL -o "$V10/voices/$v.bin" "$B10/voices/$v.bin"
done

say "Kokoro v1.1-zh 模型 + zf_001 ($V11)"
B11=https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX/resolve/main
mkdir -p "$V11/voices"
[ -s "$V11/tokenizer.json" ]  || curl -sSL -o "$V11/tokenizer.json" "$B11/tokenizer.json"
[ -s "$V11/model.onnx" ]      || curl -sSL -o "$V11/model.onnx" "$B11/onnx/model.onnx"
[ -s "$V11/voices/zf_001.bin" ] || curl -sSL -o "$V11/voices/zf_001.bin" "$B11/voices/zf_001.bin"

say "jieba-wasm ($JIEBA)"
# gen-variants.mjs imports this from an absolute path rather than from
# package.json, because the dependency is not part of the product until the spec
# is approved and the harness is a spike.
if [ ! -d "$JIEBA/node_modules/jieba-wasm" ]; then
  mkdir -p "$JIEBA"
  (cd "$JIEBA" && npm init -y >/dev/null 2>&1 && npm i --silent jieba-wasm)
fi

say "就绪"
du -sh "$VENV" "$V10" "$V11" "$JIEBA" 2>/dev/null || true
cat <<'EOF'

接下来：
  npx jiti poc/kokoro-zh-samples/gen-variants.mjs
  /tmp/zhvenv/bin/python poc/kokoro-zh-samples/make-samples.py
  node poc/kokoro-zh-samples/server.mjs        # http://127.0.0.1:8914/
EOF
