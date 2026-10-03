/**
 * The Chinese parity corpus: one Han run, the pinyin and the IPA the JavaScript
 * pipeline produces for it, and — where the Rust pipeline deliberately differs —
 * what Rust produces instead.
 *
 * It is committed, and both sides are pinned to it:
 *
 * - this file checks the JavaScript pipeline still produces `js` and `jsPinyin`;
 * - `crates/phonemize/tests/zh_parity.rs` checks the Rust pipeline produces
 *   `rust ?? js` and the same `jsPinyin`.
 *
 * Neither side can drift alone. A change to `pinyin-pro`, to the syllable table,
 * or to the JavaScript pipeline fails here and forces whoever made it to decide
 * what the Rust output should become.
 *
 * Regenerate after an intended JavaScript change:
 *
 * ```text
 * PHONEMIZE_UPDATE_PARITY=1 pnpm vitest run tests/unit/models/phonemize/zh-parity.test.ts
 * ```
 *
 * Two things about the inputs, both of which would otherwise look like sloppiness:
 *
 * - **Every input is Han characters only.** These are runs, not sentences:
 *   `hanToIpa` is the step that reads a run of Han characters, and the caller has
 *   already split punctuation, numerals and Latin off (`splitRuns`, `numbersToHan`,
 *   `mapPunctuation` — all phase 6 on the Rust side). A comma in an input would
 *   make `pinyin-pro` return fewer syllables than characters and the JavaScript
 *   would throw rather than phonemize.
 * - **`js` is one space per syllable** (`singleSyllableWords`), not the production
 *   spacing. Production groups syllables into words with jieba and puts a space
 *   only between words; that is phase 6 on the Rust side, and pinning the
 *   syllable-level answer now keeps this corpus about the readings and the
 *   syllable table rather than about a segmenter that has not been ported.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pinyin } from 'pinyin-pro';
import { describe, expect, it } from 'vitest';
import { hanToIpa, singleSyllableWords } from '~/lib/models/phonemize/chinese';

const CORPUS_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  'crates',
  'phonemize',
  'tests',
  'fixtures',
  'zh-parity.json'
);

interface Sample {
  input: string;
  /** What `pinyin-pro` reports, `toneType: 'num'` with `nonZh: 'removed'`. */
  jsPinyin: string[];
  /** What the JavaScript IPA step produces, one space per syllable. */
  js: string;
  /** What Rust produces, when it is not meant to be the same as `js`. */
  rust?: string;
  /** Why they differ. Required whenever `rust` is present. */
  divergence?: string;
}

interface Corpus {
  generatedBy: string;
  samples: Sample[];
}

/**
 * The inputs, chosen to cover the paths that can break independently: the
 * syllable table's tones, the phrase tables' polyphones, the four special-reading
 * rules, and the probability scaling that only a long run reaches.
 *
 * Kept as text rather than as a JSON fixture so the reason each sample exists
 * sits next to it — a corpus is documentation of what was checked, and a bare
 * list of strings loses that.
 */
const INPUTS: string[] = [
  // The syllable table: the four tones, the neutral tone, the `ü` spelling, and
  // U+032F in 好's IPA (`xau̯`).
  '你好世界',
  '妈麻马骂',
  '吗',
  '女绿略虐',
  '好',
  '〇一',

  // Polyphones the phrase tables resolve. Each of these is wrong if a character
  // is read on its own, which is what the corpus is here to notice.
  '银行行长',
  '一行白鹭上青天',
  '长大了',
  '音乐和快乐',
  '重复一遍',
  '的确',
  '目的',
  '项目的进度',
  '慢慢地',
  '跑得快',
  // The five the P5 spec measured as wrong in both pinyin-pro and pypinyin, kept
  // because they are the ones most likely to change under a dictionary update.
  '还书',
  '着装',
  '咖喱',
  '乳臭',
  '相片',
  // A four-character phrase from DICT4 and a three-character one from DICT3, so
  // both of the longer pattern tables are exercised.
  '成吉思汗',
  '为什么',

  // 一 and 不: the sandhi rules, the neutral-tone reduplication rule, the
  // blocking suffix list, and the numeral rule table.
  '一个',
  '不是',
  '看一看',
  '去不去',
  '一的',
  '第一',
  '十一',
  '二十',
  '一千',
  '万里',
  '一重',
  '十行',
  '重行',

  // 了 and 々, the two characters read by rule rather than from the table.
  '了',
  '春天来了',
  '人々',
  '々',

  // Long enough that the segmentation's probabilities would underflow to zero if
  // they were compared as plain products, which is what `decimal` is for.
  '中华人民共和国',
  '人工智能技术正在快速发展',
  '经济全球化',
  '他是一个非常努力的学生每天早上六点起床跑步然后去图书馆学习到晚上十点才回家休息',
  '这段话的长度超过了一百个字符所以它会被用来检验分词算法在概率相乘时的处理方式因为如果不做处理的话所有的候选分词方案的乘积都会下溢为零从而无法比较',
];

const UPDATE = process.env.PHONEMIZE_UPDATE_PARITY === '1';

/** The corpus as it is on disk, or a fresh one built from {@link INPUTS}. */
function build(): Corpus {
  // Loaded whether or not this is a regeneration: `rust` and `divergence` are
  // decisions about the Rust side that this file does not recompute, so a
  // comparison that dropped them would report a difference on every run.
  const existing = loadExisting();
  const samples: Sample[] = [];

  for (const input of INPUTS) {
    const jsPinyin = pinyin(input, { toneType: 'num', type: 'array', nonZh: 'removed' });
    const js = hanToIpa(input, input, singleSyllableWords);
    const previous = existing?.samples.find((sample) => sample.input === input);
    samples.push(
      previous?.rust === undefined
        ? { input, jsPinyin, js }
        : { input, jsPinyin, js, rust: previous.rust, divergence: previous.divergence }
    );
  }

  return { generatedBy: 'tests/unit/models/phonemize/zh-parity.test.ts', samples };
}

/** The committed corpus, so a regeneration keeps its divergence notes. */
function loadExisting(): Corpus | undefined {
  try {
    return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;
  } catch {
    return undefined;
  }
}

describe('the Chinese parity corpus', () => {
  it('is what the JavaScript pipeline produces', () => {
    const corpus = build();

    if (UPDATE) {
      mkdirSync(dirname(CORPUS_PATH), { recursive: true });
      writeFileSync(CORPUS_PATH, `${JSON.stringify(corpus, null, 2)}\n`);
      console.log(`wrote ${CORPUS_PATH} (${corpus.samples.length} samples)`);
      return;
    }

    const committed = loadExisting();
    expect(committed, `${CORPUS_PATH} is missing; regenerate it`).toBeDefined();

    // Compared as a whole rather than sample by sample so a change to the
    // JavaScript output reports the two objects that differ, which is what the
    // person reading it needs.
    expect(corpus.samples).toEqual(committed?.samples);
  });

  it('records a reason for every sample Rust is meant to differ on', () => {
    const committed = loadExisting();
    for (const sample of committed?.samples ?? []) {
      if (sample.rust !== undefined) {
        expect(
          sample.divergence,
          `${JSON.stringify(sample.input)} records a Rust divergence with no reason`
        ).toBeTruthy();
      }
    }
  });
});
