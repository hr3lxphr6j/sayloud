/**
 * The Chinese *frontend* parity corpus: whole sentences, and the IPA the
 * JavaScript pipeline produces for them.
 *
 * The sibling corpus (`zh-parity.test.ts`) pins one Han run at a time — the
 * readings, the syllable table and the tone arrows — with one space per syllable.
 * This one pins everything phase 6 added around that run: the numeral reading,
 * the punctuation map, the script split, and jieba's word boundaries, which is
 * where the spaces in the output come from.
 *
 * It is committed, and both sides are pinned to it:
 *
 * - this file checks the JavaScript pipeline still produces `js`;
 * - `crates/phonemize/tests/zh_pipeline.rs` checks the Rust pipeline produces
 *   exactly the same string.
 *
 * Neither side can drift alone. A change to `pinyin-pro`, to jieba's dictionary,
 * to the punctuation map or to the numeral rules fails here and forces whoever
 * made it to decide what the Rust output should become.
 *
 * Regenerate after an intended JavaScript change:
 *
 * ```text
 * PHONEMIZE_UPDATE_PARITY=1 pnpm vitest run tests/unit/models/phonemize/zh-frontend-parity.test.ts
 * ```
 *
 * # Why there is no Latin text in the corpus
 *
 * A Latin run is the one step where the two pipelines deliberately use different
 * engines: `chinese.ts` hands it to espeak, Rust hands it to its CMU Dict backend
 * (the phase 4 decision, recorded in `pipeline::phonemize_zh`). They agree on
 * initialisms and can disagree on a mixed-case word espeak would have invented a
 * pronunciation for, so a corpus containing Latin text would pin a divergence
 * rather than a shared answer — and a corpus of deliberate mismatches stops being
 * read.
 *
 * Mixed text is covered instead by `crates/phonemize/tests/zh_pipeline.rs`, which
 * asserts the Han half is unchanged by the Latin run beside it. The Latin
 * phonemizer below throws, so a Latin character reaching this corpus is a loud
 * failure here rather than a silent one in the fixture.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ChinesePhonemizer, ensureJieba } from '~/lib/models/phonemize/chinese';

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
  'zh-frontend-parity.json'
);

interface Sample {
  input: string;
  /** What `ChinesePhonemizer.phonemize` produces for it. */
  js: string;
}

interface Corpus {
  generatedBy: string;
  samples: Sample[];
}

/**
 * The inputs, chosen to cover the paths that can break independently.
 *
 * Kept as text rather than as a JSON fixture so the reason each sample exists
 * sits next to it — a corpus is documentation of what was checked, and a bare
 * list of strings loses that.
 */
const INPUTS: string[] = [
  // The P5 spec's own §3.11.7 example: a numeral with a decimal, a percentage,
  // a full-width full stop, and the tone sandhi in 增长. The JavaScript suite
  // asserts this exact string in `phonemize.test.ts`, so it is the one sample
  // with a second, independent pin.
  '第 3 季度营收增长了 15.6%。',

  // Word boundaries. 人设 and 曾经 are the words the user reported as paused
  // inside; the rest are ordinary sentences whose segmentation is not obvious.
  '人设曾经',
  '你好世界',
  '他昨天去图书馆还书了。',
  '我们中出了一个叛徒',
  '中华人民共和国武汉市长江大桥',
  '银行行长',
  '一行白鹭上青天',
  '人工智能技术正在改变世界',
  '这个项目的性能优化还有很大空间',

  // Numerals, one sample per rule and per documented gap. `numbers.ts` is the
  // oracle for all of these; several are surprising on purpose.
  '我有3只猫',
  '123',
  '1234567890',
  '3.14',
  '15.',
  '50%',
  '15.6%',
  '1.2.3%',
  '1.2.3',
  '０１２３',
  '２０２２年',
  '15％',
  '1,234',
  '价格是123.45元',
  '100015',

  // Punctuation: the comma that becomes a period, the 顿号 that stays a comma,
  // the quotation marks that become `“ ”` rather than `"`, and the marks that
  // are dropped because the tokenizer has no token for them.
  '你好，世界。',
  '一、二、三',
  '真的吗？是的！',
  '注意：安全；第一',
  '「引用」',
  '《书名》',
  '【标题】',
  '（括号）',
  '好-坏',
  // `-`, `/` and `%` are not in the tokenizer's vocabulary, so they are dropped
  // rather than emitted for it to discard. Spelled without Latin letters, because
  // the corpus is Han, numerals and punctuation only.
  '好-坏/好%坏',

  // Whitespace: the space between two Han runs is the only word boundary there
  // is, so it has to survive; runs of it collapse.
  '你好 世界',
  '你好   世界',
  '你好　世界',
  '  你好世界  ',
  '   ',

  // Runs the Chinese front end cannot read. Kana is `other` to `chinese.ts` and
  // is dropped; the vocabulary gate would otherwise catch it.
  '你好あ世界',

  // Characters that are Han to `chinese.ts` but not to `common.ts`'s segmenter:
  // 〇 (U+3007) and the compatibility ideographs (U+F900-U+FAFF).
  '〇一二三',
  '豈',

  // Long enough that the segmentation's probabilities would underflow to zero if
  // they were compared as plain products, which is what `decimal` is for.
  '他是一个非常努力的学生每天早上六点起床跑步然后去图书馆学习到晚上十点才回家休息',
  '这段话的长度超过了一百个字符所以它会被用来检验分词算法在概率相乘时的处理方式因为如果不做处理的话所有的候选分词方案的乘积都会下溢为零从而无法比较',

  // Nothing to say. Not an error, and not a crash.
  '',
];

const UPDATE = process.env.PHONEMIZE_UPDATE_PARITY === '1';

/**
 * A Latin phonemizer that refuses to run.
 *
 * The corpus is Han, numerals and punctuation only (see the file comment). If a
 * future edit puts a Latin character in one of the inputs, this makes that a
 * failure in the generator rather than a sample whose JavaScript half came from
 * espeak and whose Rust half cannot.
 */
function noLatin(text: string): Promise<string> {
  return Promise.reject(new Error(`the parity corpus must not contain Latin text: ${text}`));
}

/** The corpus as it is on disk. */
function loadExisting(): Corpus | undefined {
  try {
    return JSON.parse(readFileSync(CORPUS_PATH, 'utf8')) as Corpus;
  } catch {
    return undefined;
  }
}

describe('the Chinese frontend parity corpus', () => {
  it('is what the JavaScript pipeline produces', async () => {
    await ensureJieba();
    const phonemizer = new ChinesePhonemizer(noLatin);

    const samples: Sample[] = [];
    for (const input of INPUTS) {
      samples.push({ input, js: await phonemizer.phonemize(input, 'zh-CN') });
    }
    const corpus: Corpus = {
      generatedBy: 'tests/unit/models/phonemize/zh-frontend-parity.test.ts',
      samples,
    };

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

  it('keeps every sample free of Latin text', () => {
    // The invariant the throwing phonemizer above enforces at generation time,
    // asserted against the committed file too — a fixture edited by hand would
    // otherwise slip past the generator entirely.
    for (const sample of loadExisting()?.samples ?? []) {
      expect(sample.input, 'the corpus is Han, numerals and punctuation only').not.toMatch(
        /[A-Za-z]/
      );
    }
  });
});
