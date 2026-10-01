#!/usr/bin/env python3
"""
Produce the legacy reference phoneme strings — the training target (throwaway).

    legacy_phonemes.py <sentences.json> <out.json>

`make-samples.py` runs this as a **subprocess**, and that is the whole point of
the file. It must not be imported.

misaki's legacy path is `jieba.lcut` + `pypinyin.lazy_pinyin`, and it never loads
`large_pinyin`. But `ZHFrontend.__init__` does — via
`pypinyin_dict.phrase_pinyin_data.large_pinyin.load()`, which mutates pypinyin's
**global** phrase dictionary. So merely importing misaki anywhere in the process
is enough to change what `lazy_pinyin` returns, and `large_pinyin` stores
*sandhi-applied* readings (一个 → yí ge, 一定 → yí dìng).

That is not hypothetical: the reference was corrupted this way twice. First by
skipping `map_punctuation` (the clips lost every pause), then by this — 一个 came
out as `i↗` where the real legacy path gives `i→`. A fresh interpreter makes the
second one structurally impossible.

This module therefore imports only jieba, pypinyin, cn2an and the syllable table.
If you ever need misaki here, stop: the reference has stopped being the reference.
"""
import json
import re
import sys
from pathlib import Path

import cn2an
import jieba
from pypinyin import Style, lazy_pinyin

TABLE = json.loads((Path(__file__).parent.parent.parent / 'lib/models/phonemize/pinyin-table.json').read_text())
TONE_LETTER = {1: '˥', 2: '˧˥', 3: '˧˩˧', 4: '˥˩', 5: ''}


def retone(ipa: str) -> str:
    return (ipa.replace('˧˩˧', '↓').replace('˧˥', '↗')
               .replace('˥˩', '↘').replace('˥', '→'))


def syllable_to_ipa(py: str) -> str:
    """The product's `syllableToIpa`, in Python."""
    tone = int(py[-1])
    tone = 5 if tone == 0 else tone
    key = py[:-1].replace('ü', 'v')
    template = TABLE.get(key)
    if template is None:
        raise SystemExit(f'no IPA for syllable {key!r} (from {py!r})')
    return retone(template.replace('0', TONE_LETTER[tone]))


def map_punctuation(text: str) -> str:
    """misaki `ZHG2P.map_punctuation`, verbatim."""
    for a, b in [('、', ', '), ('，', ', '), ('。', '. '), ('．', '. '), ('！', '! '),
                 ('：', ': '), ('；', '; '), ('？', '? '),
                 ('«', ' “'), ('»', '” '), ('《', ' “'), ('》', '” '),
                 ('「', ' “'), ('」', '” '), ('【', ' “'), ('】', '” '),
                 ('（', ' ('), ('）', ') ')]:
        text = text.replace(a, b)
    return text.strip()


def legacy_phonemes(text: str) -> str:
    """
    misaki's `ZHG2P.__call__` on the legacy path.

    cn2an, then map_punctuation, then `legacy_call`: jieba words, each word's
    syllables concatenated with no separator, words joined by a space, U+032F
    deleted at the end.

    `jieba.lcut`'s HMM is on by default and must stay on: with it off, 还书 comes
    out as 还|书. jieba-wasm needs `cut(text, true)` to match this.
    """
    text = map_punctuation(cn2an.transform(text, 'an2cn'))
    result = ''
    for segment in re.findall(r'[\u4E00-\u9FFF]+|[^\u4E00-\u9FFF]+', text):
        if re.match(r'[\u4E00-\u9FFF]', segment):
            words = jieba.lcut(segment, cut_all=False)
            segment = ' '.join(
                ''.join(syllable_to_ipa(p) for p in lazy_pinyin(w, style=Style.TONE3, neutral_tone_with_five=True))
                for w in words
            )
        result += segment
    return result.replace(chr(815), '')


def main() -> None:
    sentences = json.loads(Path(sys.argv[1]).read_text())
    out = {text: legacy_phonemes(text) for text in sentences}
    Path(sys.argv[2]).write_text(json.dumps(out, ensure_ascii=False, indent=1))
    for text, phonemes in out.items():
        print(f'  legacy {text[:14]:16} {phonemes}')


if __name__ == '__main__':
    main()
