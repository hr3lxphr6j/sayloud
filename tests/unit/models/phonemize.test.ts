/**
 * The phonemizer (P4 spec §3.11, P5 spec §3).
 *
 * The Chinese path is pinyin-pro plus a generated lookup table plus jieba-wasm
 * for word boundaries, so it is tested for real here — including the wasm, which
 * loads in about 125 ms once (see `ensureJieba`). The English path is espeak-ng's
 * wasm; only its language mapping and the *dispatch* are exercised, because
 * loading the wasm is exactly what `FakePhonemizer` exists to avoid. The real
 * English audio is covered by the manual acceptance run (spec §9).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { phonemizerFor } from '~/lib/models/phonemize';
import {
  ChinesePhonemizer,
  ensureJieba,
  hanToIpa,
  jiebaBoundaries,
  joinByWords,
  mapPunctuation,
  retone,
  singleSyllableWords,
  splitRuns,
  TONE_MAPPING,
  UnknownSyllableError,
} from '~/lib/models/phonemize/chinese';
import { FakePhonemizer } from '~/lib/models/phonemize/fake';
import { numbersToHan } from '~/lib/models/phonemize/numbers';
import table from '~/lib/models/phonemize/pinyin-table.json';
import { isChinese } from '~/lib/models/phonemize/types';
import { KOKORO_VOCAB } from './kokoro-vocab';

const ENTRIES = table as Record<string, string>;

const TONE_LETTERS = ['˥', '˧', '˩'];
const ARROWS = ['↓', '→', '↗', '↘'];

/**
 * The two combining marks the tokenizer's normaliser strips.
 *
 * Both come out of the syllable table (`au̯`, `ɻ̩`) and are absent from the
 * tokenizer's vocabulary. The verification round established that this is
 * harmless — the model was trained through the same normaliser — so the table
 * is allowed to emit them and the test below tolerates exactly these two.
 */
const STRIPPED_MARKS = ['\u032F', '\u0329'];

describe('the syllable table', () => {
  it('holds the 426 syllables the generator produced', () => {
    expect(Object.keys(ENTRIES)).toHaveLength(426);
  });

  it('resolves every syllable for every tone', () => {
    for (const [syllable, template] of Object.entries(ENTRIES)) {
      expect(template, syllable).not.toBe('');

      for (const tone of [1, 2, 3, 4, 5]) {
        const ipa = retone(template.replaceAll('0', TONE_MAPPING[tone] ?? ''));
        expect(ipa, `${syllable} tone ${tone}`).not.toBe('');

        // Exactly one arrow for the four contour tones, none for the neutral
        // one. A second arrow would mean a tone letter survived in the middle
        // of a syllable, which would read as a spurious tone change.
        const arrows = ARROWS.filter((arrow) => ipa.includes(arrow));
        expect(arrows, `${syllable} tone ${tone}: ${ipa}`).toHaveLength(tone === 5 ? 0 : 1);

        for (const letter of TONE_LETTERS) {
          expect(ipa, `${syllable} tone ${tone} kept a tone letter`).not.toContain(letter);
        }
      }
    }
  });

  it('only emits characters the tokenizer knows or a known-stripped mark', () => {
    // A phoneme the tokenizer does not have is dropped without an error, so
    // the character simply is not heard. This is the test that would notice a
    // table regenerated against a different tokenizer.
    const vocab = new Set(KOKORO_VOCAB);
    const unknown = new Set<string>();

    for (const template of Object.values(ENTRIES)) {
      for (const character of template) {
        if (character === '0') continue;
        if (vocab.has(character) || STRIPPED_MARKS.includes(character)) continue;
        unknown.add(character);
      }
    }

    expect([...unknown]).toEqual([]);
  });
});

describe('retone', () => {
  it('folds each tone contour into its arrow', () => {
    expect(retone('ni˥')).toBe('ni→');
    expect(retone('ni˧˥')).toBe('ni↗');
    expect(retone('ni˧˩˧')).toBe('ni↓');
    expect(retone('ni˥˩')).toBe('ni↘');
  });

  it('replaces the fourth tone before the first', () => {
    // `˥` is a prefix of `˥˩`, so the wrong order turns every fourth tone into
    // a first tone — and only fourth tones, which is easy to miss.
    expect(retone('ʂɻ̩˥˩')).toBe('ʂɻ̩↘');
  });
});

describe('numbersToHan', () => {
  it.each([
    ['3', '三'],
    ['15', '十五'],
    ['100', '一百'],
    ['105', '一百零五'],
    ['110', '一百一十'],
    ['1000', '一千'],
    ['2024', '二千零二十四'],
    ['10000', '一万'],
    ['10001', '一万零一'],
    ['12345', '一万二千三百四十五'],
    ['100000', '十万'],
    ['1000000', '一百万'],
    ['110000', '十一万'],
    ['100000000', '一亿'],
    ['100000001', '一亿零一'],
    ['100015', '十万零一十五'],
  ])('reads %s as %s', (input, expected) => {
    expect(numbersToHan(input)).toBe(expected);
  });

  it('reads a decimal digit by digit', () => {
    expect(numbersToHan('15.6')).toBe('十五点六');
    expect(numbersToHan('0.5')).toBe('零点五');
  });

  it('puts the percent in front', () => {
    expect(numbersToHan('15.6%')).toBe('百分之十五点六');
    // The literal reading, not the idiom 百分之百: 200% has only 百分之二百, and
    // one rule that covers both is better than an idiom plus an exception.
    expect(numbersToHan('100%')).toBe('百分之一百');
  });

  it('reads a number too large for a double digit by digit', () => {
    // 1234567890123456789 is not exactly representable; reading it as a number
    // would produce a different number than the one on the page.
    expect(numbersToHan('1234567890123456789')).toBe('一二三四五六七八九零一二三四五六七八九');
  });

  it('leaves text without digits alone', () => {
    expect(numbersToHan('你好')).toBe('你好');
  });
});

describe('mapPunctuation', () => {
  it('turns full-width punctuation into the ASCII the tokenizer has', () => {
    expect(mapPunctuation('你好，世界。')).toBe('你好, 世界.');
    expect(mapPunctuation('真的吗？')).toBe('真的吗?');
  });

  it('maps quotes and brackets', () => {
    expect(mapPunctuation('他说：“好”')).toBe('他说: “好”');
    expect(mapPunctuation('《书名》')).toBe('“书名”');
    expect(mapPunctuation('（括号）')).toBe('(括号)');
  });
});

describe('splitRuns', () => {
  it('separates Han, Latin and everything else', () => {
    expect(splitRuns('你好API!')).toEqual([
      { kind: 'han', text: '你好' },
      { kind: 'latin', text: 'API' },
      { kind: 'other', text: '!' },
    ]);
  });

  it('treats the CJK extensions and the compatibility ideographs as Han', () => {
    // A character that fell out of the Han run would land in the punctuation
    // run and be dropped there without a word.
    expect(splitRuns('㐀﨎').map((run) => run.kind)).toEqual(['han']);
  });
});

describe('hanToIpa', () => {
  // These exercise the syllable table, not the word boundaries, so they ask for
  // one word per syllable: it keeps the expected strings about the syllables and
  // keeps the 3.8 MB jieba wasm out of this file. The spacing itself is covered
  // by the `word boundaries` block below.
  const syllables = (han: string) => hanToIpa(han, han, singleSyllableWords);

  it('produces the verified IPA for a sentence', () => {
    expect(syllables('你好世界')).toBe('ni↓ xau↓ ʂɻ̩↘ ʨje↘');
  });

  it('gives the four tones four different shapes', () => {
    const [first, second, third, fourth] = ['妈', '麻', '马', '骂'].map(syllables);
    expect([first, second, third, fourth]).toEqual(['ma→', 'ma↗', 'ma↓', 'ma↘']);
    expect(new Set([first, second, third, fourth]).size).toBe(4);
  });

  it('keeps the neutral tone toneless', () => {
    // pinyin-pro reports the neutral tone as `0`; the table and TONE_MAPPING
    // use `5`. Skipping the mapping drops the tone *and* leaves the `0` in the
    // IPA, so the syllable would be read as a digit.
    expect(syllables('吗')).toBe('ma');
    expect(syllables('吗')).not.toContain('0');
  });

  it('resolves a syllable spelled with ü', () => {
    // The table spells it `v` (pypinyin's toneless form) and pinyin-pro spells
    // it `ü`, so the lookup has to translate. Without that these characters
    // vanish from the audio without an error — the verification script had
    // exactly this bug, and its five test sentences happened not to contain one.
    expect(syllables('女')).toBe('ny↓');
    expect(syllables('绿')).toBe('ly↘');
    expect(syllables('略')).toBe('lɥe↘');
    expect(syllables('虐')).toBe('nɥe↘');
  });

  it('deletes U+032F, as misaki does', () => {
    // misaki's legacy path ends with `replace(chr(815), '')`. The tokenizer's
    // normalizer would drop it anyway, but matching the training target exactly
    // is what makes `compare-legacy-g2p.py` able to compare strictly rather than
    // normalise the difference away. 好 has the mark (`xau̯`), 你 does not.
    expect(syllables('好')).toBe('xau↓');
    expect(syllables('好')).not.toContain('\u032F');
  });

  it('raises rather than returning nothing for a character it cannot read', () => {
    // U+3400 is in the Han range but absent from pinyin-pro's dictionary.
    expect(() => syllables('㐀')).toThrow(UnknownSyllableError);
    expect(() => syllables('你好㐀')).toThrow(/pinyin-pro could not read/);
  });
});

describe('joinByWords', () => {
  it('concatenates inside a word and separates between words', () => {
    expect(joinByWords(['ni↓', 'xau↓', 'ʂɻ̩↘', 'ʨje↘'], [2, 2], 'test')).toBe('ni↓xau↓ ʂɻ̩↘ʨje↘');
  });

  it('is the identity when every word is one syllable', () => {
    expect(joinByWords(['a', 'b', 'c'], [1, 1, 1], 'test')).toBe('a b c');
  });

  it('refuses boundaries that do not cover the syllables', () => {
    // The boundaries come from jieba and the syllables from pinyin-pro, so they
    // can disagree. Slicing on a wrong boundary moves a syllable into the
    // neighbouring word — audible, and silent about it.
    expect(() => joinByWords(['a', 'b', 'c'], [2], 'test')).toThrow(/cover 2 of 3/);
    expect(() => joinByWords(['a', 'b'], [1, 1, 1], 'test')).toThrow(/cover 3 of 2/);
  });
});

describe('jieba word boundaries', () => {
  beforeAll(async () => {
    await ensureJieba();
  });

  it('groups a word into one unit, so no pause lands inside it', () => {
    // The user's report: 人设 and 曾经 were being split, and the model paused
    // between the characters. One word means one unit means no boundary.
    expect(jiebaBoundaries('人设')).toEqual([2]);
    expect(jiebaBoundaries('曾经')).toEqual([2]);
    expect(jiebaBoundaries('你好世界')).toEqual([2, 2]);
  });

  it('leaves 还书 whole, which is what hmm: true buys', () => {
    // jieba-wasm ships jieba-rs's dictionary, not Python jieba's dict.txt, and
    // 还书 is where the two differ — but only with HMM off. `cut(text, false)`
    // gives 还|书; Python's `jieba.lcut` has HMM on by default, so `cut(text,
    // true)` is the matching call. Measured on 24 sentences they agree 24/24
    // with HMM on and diverge on the first one with it off.
    expect(jiebaBoundaries('他昨天去图书馆还书了。')).toEqual([1, 2, 1, 3, 2, 1, 1]);
  });
});

describe('ChinesePhonemizer', () => {
  const latin = async (text: string): Promise<string> => `«${text}»`;
  const phonemizer = new ChinesePhonemizer(latin);

  beforeAll(async () => {
    await ensureJieba();
  });

  it('reproduces the verified mixed pipeline', async () => {
    // The spec's own §3.11.7 example, which exercises numerals, punctuation and
    // the tone sandhi pinyin-pro applies to 增长 (zēng zhǎng, not cháng). Note
    // the spacing: one space between words, none inside them.
    await expect(phonemizer.phonemize('第 3 季度营收增长了 15.6%。', 'zh-CN')).resolves.toBe(
      'ti↘ sa→n ʨi↘tu↘ i↗ŋʂou→ ʦə→ŋꭧa↓ŋ lɤ pai↓fə→nꭧɻ̩→ʂɻ̩↗u↓ tjɛ↓nljou↘.'
    );
  });

  it('spells Latin runs out through the Latin front end', async () => {
    // The spaces around `API` are the original text's, not ours — the runs are
    // concatenated with nothing inserted, so the only spaces are the ones the
    // text and the word boundaries already carry.
    await expect(phonemizer.phonemize('这里有个 API 接口。', 'zh-CN')).resolves.toBe(
      'ꭧɤ↘li↓ jou↓kɤ↘ «API» ʨje→kʰou↓.'
    );
  });

  it('keeps only the punctuation the tokenizer has', async () => {
    // `-` and `%` are not in Kokoro's vocabulary. Emitting them would be
    // pointless at best; the percent sign in particular is already spoken by
    // the numeral conversion.
    await expect(phonemizer.phonemize('好-坏', 'zh-CN')).resolves.toBe('xau↓xwai↘');
  });

  it('puts punctuation flush against the phoneme before it', async () => {
    // misaki appends each non-Han segment verbatim, and `mapPunctuation` emits
    // `", "` — the space comes *after* the mark. `parts.join(' ')` used to put
    // one in front of every mark as well, which is the deviation the P5 spec
    // calls B.
    await expect(phonemizer.phonemize('你好世界。', 'zh-CN')).resolves.toBe('ni↓xau↓ ʂɻ̩↘ʨje↘.');
  });

  it('collapses whitespace', async () => {
    await expect(phonemizer.phonemize('你好   世界', 'zh-CN')).resolves.toBe('ni↓xau↓ ʂɻ̩↘ʨje↘');
  });

  it('survives being called concurrently', async () => {
    // The run regex carries a `lastIndex`, and phonemize awaits inside the
    // loop over runs. A shared regex object would let two sentences interleave
    // and read each other's runs.
    const [a, b] = await Promise.all([
      phonemizer.phonemize('你好世界。', 'zh-CN'),
      phonemizer.phonemize('妈麻马骂。', 'zh-CN'),
    ]);
    expect(a).toBe('ni↓xau↓ ʂɻ̩↘ʨje↘.');
    expect(b).toBe('ma→ma↗ma↓ ma↘.');
  });

  it('returns nothing for text with nothing to say', async () => {
    await expect(phonemizer.phonemize('   ', 'zh-CN')).resolves.toBe('');
  });
});

describe('FakePhonemizer', () => {
  it('returns fixed IPA and records the calls', async () => {
    const fake = new FakePhonemizer({ ipa: 'la la' });
    await expect(fake.phonemize('你好', 'zh-CN')).resolves.toBe('la la');
    expect(fake.calls).toEqual([{ text: '你好', lang: 'zh-CN' }]);
  });

  it('can echo the input', async () => {
    const fake = new FakePhonemizer({ echo: true });
    await expect(fake.phonemize('你好', 'zh-CN')).resolves.toBe('你好');
  });

  it('can fail on demand', async () => {
    const fake = new FakePhonemizer({ failOn: '爆炸' });
    await expect(fake.phonemize('爆炸', 'zh-CN')).rejects.toThrow(/told to fail/);
    await expect(fake.phonemize('安全', 'zh-CN')).resolves.toBe('fəˈnɛm');
  });
});

describe('phonemizerFor', () => {
  it('picks the Chinese pipeline for every Chinese tag', async () => {
    await expect(phonemizerFor('zh-CN')).resolves.toBeInstanceOf(ChinesePhonemizer);
    await expect(phonemizerFor('zh-Hans')).resolves.toBeInstanceOf(ChinesePhonemizer);
    expect(isChinese('zh-TW')).toBe(true);
  });

  it('picks the English pipeline otherwise', async () => {
    const phonemizer = await phonemizerFor('en-GB');
    expect(phonemizer).not.toBeInstanceOf(ChinesePhonemizer);
    expect(isChinese('en-US')).toBe(false);
  });
});
