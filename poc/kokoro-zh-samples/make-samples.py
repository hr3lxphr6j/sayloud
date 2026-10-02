#!/usr/bin/env python3
"""
Synthesize the listening samples for the P5 spec's V24 / V27 (spike, throwaway).

    /tmp/zhvenv/bin/python poc/kokoro-zh-samples/make-samples.py

Two groups, two models:

  Group 1 — 阶段 1（V24）: the *current production* model (Kokoro v1.0, IPA
  tokenizer, voice zf_xiaoyi), fed the same sentence in five phoneme-string
  formats. This is the only way to judge whether the spec's §1.2 format
  deviations actually matter — and whether the direction is right, since the
  format argument is an inference.

  Group 2 — 阶段 2（V27）: v1.1-zh (bopomofo tokenizer, voice zf_001) fed the
  official `ZHFrontend` output. The 2a-style comparison clip was dropped — see
  the note in `main`.

Each clip records how many characters the tokenizer's normalizer *discarded* and
a digest of the resulting ids. Two variants whose ids are identical cannot sound
different, which is how the U+032F change (deviation D) is shown to be
provably inaudible rather than merely assumed to be.

Wavs go to /tmp/kokoro-zh-samples-out (kept out of the repo) and the manifest to
samples.json next to this file.
"""
import hashlib
import json
import re
import sys
from pathlib import Path

import numpy as np
import onnxruntime as ort
from pypinyin import Style, lazy_pinyin

HERE = Path(__file__).parent

# Voices are constants so switching one is a one-line change. `zf_xiaobei` and
# `zf_xiaoyi` are both v1.0 Chinese voices (the repo has eight); v1.1-zh has a
# different, unrelated naming scheme (zf_001..zf_100), so there is no "the same
# voice" across the two models and the phase-2 clips cannot match the phase-1
# timbre.
V10_VOICE = 'zf_xiaoyi'
V11_VOICE = 'zf_001'
OUT = Path('/tmp/kokoro-zh-samples-out')
V10 = Path('/tmp/kokoro-v10')
V11 = Path('/tmp/kokoro-poc-models')

sys.path.insert(0, str(V11 / 'misakizh'))

# The only characters the tokenizers' normalizers are allowed to remove: the two
# combining marks the syllable table emits, neither of which is in any vocabulary.
KNOWN_STRIPPED = {'\u032F', '\u0329'}


# --- the tokenizers ---------------------------------------------------------

class Tokenizer:
    def __init__(self, path: Path, name: str):
        spec = json.loads(path.read_text())
        self.name = name
        self.vocab = spec['model']['vocab']
        self.keep = re.compile(spec['normalizer']['pattern']['Regex'])

    def encode(self, phonemes: str):
        kept = self.keep.sub('', phonemes)          # the normalizer deletes the rest
        unknown = sorted({c for c in kept if c not in self.vocab})
        if unknown:
            raise SystemExit(f'{self.name}: chars kept but not in vocab: {unknown}')
        # The normalizer is supposed to remove exactly the two combining marks the
        # syllable table emits, and nothing else. Anything else it removes means
        # the phoneme string was never put through the pipeline it should have
        # been — a full-width comma, a digit, a Han character — and the clip is
        # silently missing something audible.
        dropped = sorted(set(phonemes) - set(kept))
        unexpected = [c for c in dropped if c not in KNOWN_STRIPPED]
        if unexpected:
            raise SystemExit(
                f'{self.name}: normalizer dropped unexpected chars {unexpected!r} '
                f'from {phonemes!r}'
            )
        ids = [0] + [self.vocab[c] for c in kept] + [0]   # TemplateProcessing adds `$` both ends
        return ids, len(phonemes) - len(kept), kept


# --- the models -------------------------------------------------------------

class Model:
    def __init__(self, model_path: Path, voice_path: Path, name: str):
        self.name = name
        self.session = ort.InferenceSession(str(model_path), providers=['CPUExecutionProvider'])
        names = [i.name for i in self.session.get_inputs()]
        if names != ['input_ids', 'style', 'speed']:
            raise SystemExit(f'{name}: unexpected inputs {names}')
        self.voice = np.fromfile(voice_path, dtype=np.float32).reshape(-1, 256)

    def synth(self, ids, speed=1.0):
        row = min(max(len(ids) - 2, 0), 509)
        style = self.voice[row].reshape(1, 256).astype(np.float32)
        wav = self.session.run(None, {
            'input_ids': np.array([ids], dtype=np.int64),
            'style': style,
            'speed': np.array([speed], dtype=np.float32),
        })[0]
        return np.asarray(wav).reshape(-1)


def write_wav(path: Path, samples: np.ndarray, rate=24000) -> None:
    import wave as wavmod
    with wavmod.open(str(path), 'wb') as f:
        f.setnchannels(1)
        f.setsampwidth(2)
        f.setframerate(rate)
        f.writeframes((np.clip(samples, -1, 1) * 32767).astype('<i2').tobytes())


def legacy_reference(texts):
    """
    The training target, produced by a **fresh interpreter**.

    Not a stylistic choice. `ZHFrontend.__init__` calls `large_pinyin.load()`,
    which mutates pypinyin's **global** phrase dictionary, and `large_pinyin`
    stores *sandhi-applied* readings. So by the time this module has imported
    misaki, `lazy_pinyin` no longer answers the way the real legacy path would —
    the reference came out with 一个 as `i↗` instead of `i→` for exactly that
    reason.

    `legacy_phonemes.py` imports no misaki and cannot be polluted; running it as a
    subprocess is what keeps this process's global state out of its answers.
    """
    import subprocess

    here = Path(__file__).parent
    in_path, out_path = here / '.legacy-in.json', here / 'legacy.json'
    in_path.write_text(json.dumps(texts, ensure_ascii=False))
    subprocess.run(
        [sys.executable, str(here / 'legacy_phonemes.py'), str(in_path), str(out_path)],
        check=True,
    )
    in_path.unlink()
    return json.loads(out_path.read_text())


# --- the legacy reference (the training target) -----------------------------

def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    from misaki.zh import ZHG2P

    g2p = ZHG2P(version='1.1', en_callable=lambda t: t)

    tok10 = Tokenizer(V10 / 'tokenizer.json', 'v1.0')
    tok11 = Tokenizer(V11 / 'tokenizer.json', 'v1.1-zh')
    m10 = Model(V10 / 'model.onnx', V10 / f'voices/{V10_VOICE}.bin', f'v1.0/{V10_VOICE}')
    m11 = Model(V11 / 'model.onnx', V11 / f'voices/{V11_VOICE}.bin', f'v1.1-zh/{V11_VOICE}')

    variants = json.loads((HERE / 'variants.json').read_text())
    clips = []
    legacy = legacy_reference(sorted({e['text'] for e in variants}))

    def add(group, sentence_id, text, why, label, note, phonemes, model, tokenizer, model_label):
        ids, stripped, kept = tokenizer.encode(phonemes)
        digest = hashlib.sha1(','.join(map(str, ids)).encode()).hexdigest()[:8]
        name = f'{group}-{sentence_id}-{len(clips):02d}.wav'
        wav = model.synth(ids)
        write_wav(OUT / name, wav)
        clips.append({
            'group': group,
            'sentenceId': sentence_id,
            'text': text,
            'why': why,
            'label': label,
            'note': note,
            'phonemes': phonemes,
            'keptByNormalizer': kept,
            'stripped': stripped,
            'idsDigest': digest,
            'idsLength': len(ids),
            'seconds': round(len(wav) / 24000, 2),
            'model': model_label,
            'wav': name,
        })
        print(f'  {group} {sentence_id} {label:22} {len(wav)/24000:5.2f}s  stripped={stripped:2}  ids={digest}')

    sentences = {}
    for entry in variants:
        sentences.setdefault(entry['sentenceId'], entry)

    # Group 1: the format variants, on the model we ship today.
    print(f'group 1 — 格式对齐 (v1.0 + {V10_VOICE})')
    for entry in variants:
        add('fmt', entry['sentenceId'], entry['text'], entry['why'], entry['label'], entry['note'],
            entry['phonemes'], m10, tok10, f'v1.0 / {V10_VOICE}')

    # The training target itself, for comparison. Produced by a subprocess — see
    # `legacy_reference` for why that is not optional.
    print('group 1 — legacy 参考')
    for sid, entry in sentences.items():
        add('fmt', sid, entry['text'], entry['why'], 'legacy 参考（训练目标）',
            'jieba 词边界 · 无变调 · 已删 U+032F · 标点紧邻',
            legacy[entry['text']], m10, tok10, f'v1.0 / {V10_VOICE}')

    # Group 2: v1.1-zh, official front end only.
    #
    # There used to be a second clip per sentence feeding a "2a-style" input —
    # our own readings re-encoded as bopomofo — to preview how far phase 2a would
    # land from the official front end. It is gone, deliberately.
    #
    # Building it needs a syllable→bopomofo table covering *every* reading, and
    # enumerating pypinyin's single-character dictionary only yields each
    # character's default reading, so 得's děi was simply absent and the run died
    # on `no bopomofo for syllable 'dei'`. pypinyin's heteronym API does expose the
    # rest, but its three styles disagree on list length for the same character
    # (NORMAL gives ['de','dei'] where FINALS_TONE3 gives ['e2','e5','ei3']), so
    # index-aligning them is not safe either.
    #
    # A correct table is T5's job, generated with the same care as
    # pinyin-table.json, not something to improvise for a preview page.
    print(f'group 2 — v1.1-zh ({V11_VOICE})')
    for sid, entry in sentences.items():
        text = entry['text']
        phonemes, _ = g2p(text)
        add('v11', sid, text, entry['why'], 'v1.1-zh 官方 ZHFrontend',
            'sandhi + 儿化 + jieba 词性 + large_pinyin（目标）',
            phonemes, m11, tok11, f'v1.1-zh / {V11_VOICE}')

    # Group 3: punctuation treatments, on one sentence.
    #
    # The question was whether replacing punctuation with spaces would make the
    # model pause. Measured with a low-energy-gap metric, no treatment beats the
    # `", "` we already emit — spaces give *less* silence (240ms total against
    # 290ms), three spaces give less still (200ms), and repeating the mark does
    # not scale either. But that metric has already failed once to match what the
    # user hears (the pause inside 人设), so it goes on the page rather than being
    # trusted.
    #
    # The Han part is generated once and reused, so the only variable is the
    # punctuation between the two halves.
    print('group 3 — 标点处理')
    halves = ['今天天气不错', '我们去公园散步吧']
    han = legacy_reference(halves)
    TREATMENTS = [
        ('现状：逗号 + 空格', ', ', '. '),
        ('只用一个空格', ' ', ' '),
        ('三个空格', '   ', '   '),
        ('完全去掉', '', ''),
        ('句号代替逗号', '. ', '. '),
        ('分号', '; ', '. '),
        ('破折号', '— ', '— '),
    ]
    for label, comma, period in TREATMENTS:
        phonemes = han[halves[0]] + comma + han[halves[1]] + period
        add(
            'punct',
            'p1',
            '今天天气不错，我们去公园散步吧。',
            '听逗号处（「不错」与「我们」之间）的停顿',
            label,
            '汉字段完全相同，只有标点写法不同',
            phonemes,
            m10,
            tok10,
            f'v1.0 / {V10_VOICE}',
        )

    (HERE / 'samples.json').write_text(json.dumps(clips, ensure_ascii=False, indent=1))
    print(f'\nwrote samples.json ({len(clips)} clips) and {len(clips)} wavs to {OUT}')


if __name__ == '__main__':
    main()
