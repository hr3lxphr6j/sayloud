#!/usr/bin/env python3
"""
Build the POC's fixtures with the *real* Kokoro v1.1-zh front end (throwaway).

The point of generating fixtures here rather than in the page is that the input
must be exactly what the model was trained on. That means going through misaki's
`ZHG2P(version='1.1')` — the PaddleSpeech-derived front end that emits bopomofo
plus digit tones, and which is where tone sandhi (你好 -> ㄋㄧ2ㄏㄠ3) and erhua
happen. Hand-written bopomofo would test the ONNX runtime while quietly testing
the wrong input distribution.

For each text it writes, under /tmp/kokoro-poc-models:
  phonemes-<name>.txt   the front end's output
  ref-<name>.f32        raw float32 reference waveform (ONNX Runtime, CPU, fp32)
  fixtures.json         the manifest the page reads

Requires: misaki's zh front end (see README), onnxruntime, numpy, jieba, pypinyin.
"""
import json
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort

MODELS = Path('/tmp/kokoro-poc-models')
sys.path.insert(0, str(MODELS / 'misakizh'))

from misaki.zh import ZHG2P  # noqa: E402

TEXTS = {
    'short': '今天天气不错，我们去公园散步吧。',
    'medium': '他是一个工程师，在图书馆工作。这个项目的进度落后了，我们需要加快速度。',
    'long': (
        '人工智能技术正在快速发展，语音合成也变得越来越自然。'
        '我们希望用户打开一篇文章之后，可以立刻听到流畅的中文朗读，'
        '而不需要等待太长的时间。为此，我们正在评估把模型放到本地运行，'
        '并且尽可能使用显卡来加速推理。'
    ),
}


def main() -> None:
    g2p = ZHG2P(version='1.1', en_callable=lambda text: text)
    tokenizer = json.loads((MODELS / 'tokenizer.json').read_text())
    vocab = tokenizer['model']['vocab']
    voice = np.fromfile(MODELS / 'voices/zf_001.bin', dtype=np.float32).reshape(-1, 256)

    session = ort.InferenceSession(str(MODELS / 'model.onnx'), providers=['CPUExecutionProvider'])
    fixtures = []

    for name, text in TEXTS.items():
        phonemes, _ = g2p(text)
        unknown = sorted({c for c in phonemes if c not in vocab})
        if unknown:
            raise SystemExit(f'{name}: phoneme chars missing from the vocab: {unknown}')

        ids = [0] + [vocab[c] for c in phonemes] + [0]
        row = min(max(len(ids) - 2, 0), 509)
        style = voice[row].reshape(1, 256).astype(np.float32)
        waveform = np.asarray(
            session.run(
                None,
                {
                    'input_ids': np.array([ids], dtype=np.int64),
                    'style': style,
                    'speed': np.array([1.0], dtype=np.float32),
                },
            )[0]
        ).reshape(-1)

        (MODELS / f'phonemes-{name}.txt').write_text(phonemes)
        waveform.astype('<f4').tofile(MODELS / f'ref-{name}.f32')
        fixtures.append(
            {
                'name': name,
                'text': text,
                'phonemes': phonemes,
                'ids': ids,
                'styleRow': row,
                'refSamples': int(waveform.size),
                'refSeconds': round(waveform.size / 24000, 2),
            }
        )
        print(f'{name:7} {len(text):3} chars -> {len(phonemes):4} phonemes, {waveform.size / 24000:6.2f}s audio')

    (MODELS / 'fixtures.json').write_text(json.dumps(fixtures, ensure_ascii=False, indent=1))
    print('wrote fixtures.json')


if __name__ == '__main__':
    main()
