# Kokoro v1.1-zh on browser WebGPU — POC

**Status: throwaway spike.** Its output is an answer, not code to keep. Delete it
once the decision it informs is made.

## The question

Phase 2 of the Chinese G2P plan is "upgrade to Kokoro v1.1-zh". Before committing
to that, two things had to be true:

1. **Does the v1.1-zh ONNX model run on the WebGPU execution provider in a
   browser at all?** (v1.0's graph fell back to CPU for enough nodes that WebGPU
   was no faster than WASM — P4 V20.)
2. **Is the output correct?** P4 found v1.0's fp16 weights produce *silently
   wrong* audio on WebGPU while being the fastest configuration, so "it ran and
   made sound" is not evidence.

## The answer

**Yes, and it is roughly 8–10x faster than WASM.** Full matrix, Apple M-series,
Chromium with WebGPU (`metal-3`), 24 kHz output. Two full runs were taken; the
numbers below are from the quieter one, and RTF moved between 0.10 and 0.14
across runs, so treat the speedup as a range, not a constant:

| combo | session init | fixture | warm | **RTF** | corr vs ref | energy envelope | verdict |
| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| **webgpu/fp32** | 748 ms | short (4.25 s) | 425 ms | **0.100** | 0.9925 | 0.9998 | same speech |
| **webgpu/fp32** | | medium (7.33 s) | 765 ms | **0.104** | 0.9952 | 0.9998 | same speech |
| **webgpu/fp32** | | long (19.57 s) | 2025 ms | **0.103** | 0.9949 | 0.9998 | same speech |
| wasm/fp32 | 433 ms | short | 4584 ms | 1.079 | 0.9920 | 0.9998 | same speech |
| wasm/fp32 | | medium | 8093 ms | 1.105 | 0.9950 | 0.9998 | same speech |
| wasm/fp32 | | long | 21219 ms | 1.084 | 0.9952 | 0.9997 | same speech |
| webgpu/fp16 | 438 ms | all three | | 0.057–0.062 | NaN | NaN | **BROKEN** |
| wasm/fp16 | 738 ms | all three | | 1.035–1.043 | NaN | NaN | **BROKEN** |

Reading it:

- **RTF is flat across lengths** (0.100 / 0.104 / 0.103), so the speedup is not
  a fixed-overhead artifact of short inputs — it holds on a 20-second utterance.
- **10.5x** faster than WASM on average (0.102 vs 1.089 RTF) on this run, and
  **7.8x** on a second run taken under more background load (0.135 vs 1.052).
  The ratio is stable even though the absolute RTF is not. The ORT warning
  "some nodes were not assigned to the preferred execution providers" is about
  shape ops that ORT pins to CPU on purpose; if WebGPU had fallen back to WASM
  wholesale, the timing would be ~4.5 s, not 425 ms.
- **fp16 is unusable**, on both EPs — and not just in the browser: Python CPU
  fp16 correlates only **0.087** with fp32 (rms 0.027 vs 0.062), i.e. the fp16
  weights are themselves bad. It also returns a different sample count for the
  same input (176 400 vs 175 800 for `medium`). This matches P4's v1.0 finding.
- **Session init dropped from ~12 s (v1.0, P4 V20) to ~750 ms.** Combined with
  RTF 0.10, the "must prefetch, must show honest progress" conclusion from P4
  weakens considerably for v1.1-zh: a 20-second utterance synthesizes in 2 s.

## How to reproduce

```bash
# 1. models (about 500 MB, into /tmp — not into the repo)
mkdir -p /tmp/kokoro-poc-models/voices
B=https://huggingface.co/onnx-community/Kokoro-82M-v1.1-zh-ONNX/resolve/main
cd /tmp/kokoro-poc-models
curl -sSL -o tokenizer.json       "$B/tokenizer.json"
curl -sSL -o voices/zf_001.bin    "$B/voices/zf_001.bin"
curl -sSL -o model.onnx           "$B/onnx/model.onnx"        # 324 MB fp32
curl -sSL -o model_fp16.onnx      "$B/onnx/model_fp16.onnx"   # 156 MB fp16

# 2. onnxruntime-web (scratch install, kept out of the repo)
mkdir -p /tmp/kokoro-poc-ort && cd /tmp/kokoro-poc-ort
npm init -y && npm i onnxruntime-web

# 3. the real misaki v1.1 front end — needed to build honest fixtures
python3 -m venv /tmp/zhvenv
/tmp/zhvenv/bin/pip install pypinyin pypinyin-dict jieba cn2an addict ordered-set numpy onnxruntime
mkdir -p /tmp/kokoro-poc-models/misakizh/misaki
cd /tmp/kokoro-poc-models/misakizh
for f in token.py zh_frontend.py tone_sandhi.py zh.py transcription.py; do
  curl -sSL -o misaki/$f "https://raw.githubusercontent.com/hexgrad/misaki/main/misaki/$f"
done
touch misaki/__init__.py

# 4. fixtures (phonemes from ZHG2P(version='1.1') + fp32 CPU reference waveforms)
/tmp/zhvenv/bin/python poc/kokoro-v11zh-webgpu/make-fixtures.py

# 5. run
node poc/kokoro-v11zh-webgpu/server.mjs &     # http://127.0.0.1:8913
node poc/kokoro-v11zh-webgpu/run.mjs          # prints the matrix, saves audio to /tmp/kokoro-poc-out
```

Audio lands in `/tmp/kokoro-poc-out/*.wav` — **listen to them**, because no
numeric metric settles whether the speech is *good*.

## Three things that will bite anyone repeating this

**WebGPU needs a secure context.** On `about:blank` or `data:`, `navigator.gpu`
is `undefined` and it looks exactly like "WebGPU is unavailable". Serve over
`http://127.0.0.1` (or `https`). Playwright's bundled Chromium needs
`--enable-unsafe-webgpu`; it works headless, no headed mode or special GPU flags.

**Bit-exact waveform comparison is invalid.** The graph has
`RandomNormalLike` / `RandomUniformLike` nodes, and ONNX Runtime is not
run-to-run reproducible:

```
same session, run 1 vs run 2 : maxAbs 0.124  (peak is 0.49)
new session, run 1 vs run 1  : maxAbs 0.000
```

The *first* run of any session is bit-identical to the first run of the previous
one; later runs drift. So the POC scores Pearson correlation plus short-time
energy-envelope and brightness-envelope correlation, which are robust to the
noise and still catch genuinely wrong audio (fp16 scores 0.087 / 0.362, an
order of magnitude below the working combinations).

**fp16 is a trap.** It is the fastest configuration in the table (RTF 0.057) and
produces nothing but NaN. Any harness that reports speed without scoring
correctness would have recommended it.

## What this does not answer

- Whether the audio is *intelligible and pleasant* — only listening settles that.
- Whether the 324 MB fp32 model is acceptable to download and hold in the
  extension's offscreen document (the POC held it in a normal page).
- Whether the WebGPU path behaves the same inside an MV3 offscreen document.
  P4 V15 established that offscreen has full WebGPU, but not with this model.
- Anything about the G2P. The fixtures come from the real `ZHFrontend`, so this
  POC validates the *runtime*, not the front end. The front end is the other half
  of the Phase 2 plan and needs jieba-with-POS plus the 410k-entry
  `large_pinyin` dictionary ported to JS.
