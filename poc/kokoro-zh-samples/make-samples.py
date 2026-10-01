#!/usr/bin/env python3
"""
Synthesize the listening samples for the P5 spec's V24 / V27 (spike, throwaway).

    /tmp/zhvenv/bin/python poc/kokoro-zh-samples/make-samples.py

Two groups, two models:

  Group 1 — 阶段 1（V24）: the *current production* model (Kokoro v1.0, IPA
  tokenizer, voice zf_xiaobei), fed the same sentence in seven phoneme-string
  formats. This is the only way to judge whether the spec's §1.2 format
  deviations actually matter — and whether the direction is right, since the
  format argument is an inference.

  Group 2 — 阶段 2（V27）: v1.1-zh (bopomofo tokenizer, voice zf_001) fed the
  official `ZHFrontend` output versus a 2a-style input (pinyin-pro readings,
  no erhua, no large_pinyin). Compared against the v1.0 clips from group 1,
  which is what ships today.

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

# --- the 2a-style bopomofo --------------------------------------------------

def build_bopomofo_table(frontend):
    """
    syllable -> (initial, final) in ZHFrontend's own convention.

    Reuses `_get_initials_finals` rather than reimplementing it, because that
    method is where the `i` -> `ii` / `iii` substitution for z/c/s and zh/ch/sh/r
    happens — reimplementing it is how you get `ㄗㄧ` instead of `ㄗㄭ`.
    """
    from pypinyin.constants import PINYIN_DICT
    from misaki.zh_frontend import ZH_MAP

    table = {}
    for codepoint in PINYIN_DICT:
        char = chr(codepoint)
        try:
            initials, finals = frontend._get_initials_finals(char)
        except Exception:
            continue
        if len(initials) != 1 or len(finals) != 1:
            continue
        syllable = lazy_pinyin(char, style=Style.NORMAL)[0]
        if not syllable:
            continue
        final = re.sub(r'\d$', '', finals[0])
        ini = ZH_MAP.get(initials[0], '')
        fin = ZH_MAP.get(final)
        if fin is None:
            continue
        # pypinyin writes `ü` where the product's table writes `v`; key both the
        # same way or every `nü`/`lüe` syllable misses the table.
        table.setdefault(syllable.replace('ü', 'v'), (ini, fin))
    return table


def bopomofo_of(syllable_with_tone: str, table: dict) -> str:
    tone = syllable_with_tone[-1]
    # pinyin-pro writes the neutral tone as `0`; the v1.1-zh vocab has 1-5 and no
    # `0`, so an unmapped `0` is silently deleted by the normalizer and the
    # syllable loses its (already empty) tone mark — harmless here, but it also
    # means the input no longer matches what the front end emits.
    if tone == '0':
        tone = '5'
    key = syllable_with_tone[:-1].replace('ü', 'v')
    entry = table.get(key)
    if entry is None:
        raise SystemExit(f'no bopomofo for syllable {key!r}')
    return entry[0] + entry[1] + tone


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    from misaki.zh import ZHG2P
    from misaki.zh_frontend import ZHFrontend

    g2p = ZHG2P(version='1.1', en_callable=lambda t: t)
    frontend = ZHFrontend()
    bopo = build_bopomofo_table(frontend)

    tok10 = Tokenizer(V10 / 'tokenizer.json', 'v1.0')
    tok11 = Tokenizer(V11 / 'tokenizer.json', 'v1.1-zh')
    m10 = Model(V10 / 'model.onnx', V10 / 'voices/zf_xiaobei.bin', 'v1.0/zf_xiaobei')
    m11 = Model(V11 / 'model.onnx', V11 / 'voices/zf_001.bin', 'v1.1-zh/zf_001')

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
    print('group 1 — 格式对齐 (v1.0 + zf_xiaobei)')
    for entry in variants:
        add('fmt', entry['sentenceId'], entry['text'], entry['why'], entry['label'], entry['note'],
            entry['phonemes'], m10, tok10, 'v1.0 / zf_xiaobei')

    # The training target itself, for comparison. Produced by a subprocess — see
    # `legacy_reference` for why that is not optional.
    print('group 1 — legacy 参考')
    for sid, entry in sentences.items():
        add('fmt', sid, entry['text'], entry['why'], 'legacy 参考（训练目标）',
            'jieba 词边界 · 无变调 · 已删 U+032F · 标点紧邻',
            legacy[entry['text']], m10, tok10, 'v1.0 / zf_xiaobei')

    # Group 2: v1.1-zh, official front end vs a 2a-style input.
    print('group 2 — v1.1-zh (zf_001)')
    two_a = json.loads((HERE / 'two-a.json').read_text())
    for sid, entry in sentences.items():
        text = entry['text']

        phonemes, _ = g2p(text)
        add('v11', sid, text, entry['why'], 'v1.1-zh 官方 ZHFrontend',
            'sandhi + 儿化 + jieba 词性 + large_pinyin（目标）',
            phonemes, m11, tok11, 'v1.1-zh / zf_001')

        # 2a-style: the readings our pipeline produces (pinyin-pro, sandhi on,
        # patches applied), re-encoded as bopomofo and joined with `/` the way
        # ZHFrontend joins words. The IPA has already folded the tones into
        # arrows, so the readings come from two-a.json.
        syllables = two_a[sid]['syllables']
        lengths = two_a[sid]['wordLengths']
        at = 0
        encoded = []
        for length in lengths:
            encoded.append(''.join(bopomofo_of(s, bopo) for s in syllables[at:at + length]))
            at += length
        add('v11', sid, text, entry['why'], 'v1.1-zh 2a 式（我们的读音）',
            'pinyin-pro 读音 + 注音符号 + `/` 分隔 + 一/不变调；无儿化、无 large_pinyin',
            '/'.join(encoded), m11, tok11, 'v1.1-zh / zf_001')

    (HERE / 'samples.json').write_text(json.dumps(clips, ensure_ascii=False, indent=1))
    print(f'\nwrote samples.json ({len(clips)} clips) and {len(clips)} wavs to {OUT}')


if __name__ == '__main__':
    main()
