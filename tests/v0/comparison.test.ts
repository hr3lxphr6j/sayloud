/**
 * P6 V0: `@piper-plus/g2p` versus the existing JS chain.
 *
 * The output of this file is *data*, not assertions: it runs the same 30
 * samples through both front ends and writes `piper-comparison.json` and
 * `vocab-check.json` next to itself. The judgement is made in `v0-summary.md`,
 * by a human reading the numbers, because "is this output good enough" is not
 * a thing a boolean can answer here.
 *
 * Two chains are compared per sample:
 *
 *   - **JS chain** — `lib/models/phonemize/`, the thing that ships today.
 *   - **piper** — `@piper-plus/g2p`, the candidate.
 *
 * Every call is individually wrapped: the whole point of the exercise is to
 * find out which of the three languages work, and one throwing language must
 * not hide the other two.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { EnglishG2P, G2P } from '@piper-plus/g2p';
import { describe, expect, it } from 'vitest';
import { phonemizerFor } from '~/lib/models/phonemize';

const OUT_DIR = resolve(process.cwd(), 'tests/v0');

const SAMPLES: Record<string, string[]> = {
  zh: [
    '你好',
    '今天天气很好',
    '我喜欢编程',
    '中文测试',
    '数字123',
    '标点符号！',
    '混合text测试',
    '长句子用于测试性能表现',
    '简短',
    '经营管理',
  ],
  ja: [
    'こんにちは',
    '今日はいい天気ですね',
    '経営',
    'テスト',
    'ありがとう',
    '日本語',
    'カタカナ',
    'ひらがな',
    '漢字',
    'お元気ですか',
  ],
  en: [
    'hello',
    'world',
    'test',
    'never',
    'hello world',
    'The quick brown fox',
    'testing',
    'phoneme',
    'synthesis',
    'text to speech',
  ],
};

/** The BCP-47 tag each sample language is fed to the JS chain as. */
const LANG_TAG: Record<string, string> = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' };

/**
 * `LANG_TAG[lang]`, defaulted.
 *
 * `noUncheckedIndexedAccess` makes every index expression `string | undefined`,
 * and a fallback keeps the call sites free of non-null assertions.
 */
function langTagFor(lang: string): string {
  return LANG_TAG[lang] ?? lang;
}

/**
 * The same 50-character samples the standalone piper benchmark uses.
 *
 * Re-measured here rather than quoted from the P6 spec so both front ends are
 * timed on one machine in one process — the spec's numbers came from a
 * different session, and comparing across sessions is how a 2x error hides.
 */
const PERF_SAMPLES: Record<string, string> = {
  zh: '人工智能技术正在快速发展并且深刻改变着我们日常生活的方方面面今天天气非常好我们一起去公园散步吧很开心',
  ja: '日本語の音声合成技術は急速に発展しており私たちの日常生活のさまざまな場面で活用されていますとても便利',
  en: 'Artificial intelligence is advancing rapidly today',
};
const PERF_ITERATIONS = 20;

interface VocabFile {
  [key: string]: { source: string; count: number; chars: string[] };
}

interface SampleResult {
  input: string;
  /** `lib/models/phonemize/` output, or the error it threw. */
  jsChain: { output: string | null; error: string | null };
  /** `@piper-plus/g2p` output, or the error it threw. */
  piper: { tokens: string[] | null; joined: string | null; error: string | null };
  identical: boolean;
}

/**
 * A vocabulary from the fixture, or a loud failure.
 *
 * Indexing the parsed JSON yields `T | undefined` under
 * `noUncheckedIndexedAccess`; silently continuing on a missing vocabulary would
 * turn a broken fixture into a report that says "0 characters missing".
 */
function requireVocab(vocabs: VocabFile, key: string): VocabFile[string] {
  const found = vocabs[key];
  if (!found) {
    throw new Error(`kokoro-vocabs.json has no "${key}" vocabulary`);
  }
  return found;
}

/** Run one thunk, turning a throw into `{ error }` rather than aborting. */
function capture<T>(fn: () => T): { value: T | null; error: string | null } {
  try {
    return { value: fn(), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

async function captureAsync<T>(
  fn: () => Promise<T>
): Promise<{ value: T | null; error: string | null }> {
  try {
    return { value: await fn(), error: null };
  } catch (error) {
    return { value: null, error: error instanceof Error ? error.message : String(error) };
  }
}

describe('V0: @piper-plus/g2p vs the JS chain', () => {
  it('compares all 30 samples and writes piper-comparison.json', async () => {
    const comparison: Record<string, SampleResult[]> = {};
    const errors: string[] = [];

    for (const [lang, samples] of Object.entries(SAMPLES)) {
      const rows: SampleResult[] = [];
      // Built once per language: both sides memoise their expensive init, so
      // re-creating them per sample would measure the wrong thing.
      const jsPhonemizer = await phonemizerFor(lang);

      // The piper instance for this language. English and Chinese are pure JS
      // and construct synchronously; Japanese needs an OpenJTalk wasm module
      // the package does not ship, so it fails and is recorded as such.
      let piperPhonemize: ((text: string) => { tokens: string[] }) | null = null;
      if (lang === 'en') {
        const g2p = new EnglishG2P();
        piperPhonemize = (text: string) => g2p.phonemize(text);
      } else if (lang === 'zh') {
        const created = await captureAsync(async () => {
          const g2p = await G2P.create({ languages: ['zh'] });
          return (text: string) => g2p.phonemize(text, { language: 'zh' });
        });
        if (created.error) {
          errors.push(`zh G2P.create failed: ${created.error}`);
        } else {
          piperPhonemize = created.value as (text: string) => { tokens: string[] };
        }
      } else if (lang === 'ja') {
        const created = await captureAsync(async () => {
          const g2p = await G2P.create({ languages: ['ja'] });
          return (text: string) => g2p.phonemize(text, { language: 'ja' });
        });
        if (created.error) {
          errors.push(`ja G2P.create failed: ${created.error}`);
        } else {
          piperPhonemize = created.value as (text: string) => { tokens: string[] };
        }
      }

      for (const input of samples) {
        const js = await captureAsync(() => jsPhonemizer.phonemize(input, langTagFor(lang)));
        const piper = piperPhonemize
          ? capture(() => piperPhonemize?.(input) ?? { tokens: [] })
          : { value: null, error: 'not initialised (see errors)' };

        const jsOutput = js.value;
        const piperTokens = piper.value ? piper.value.tokens : null;
        const piperJoined = piperTokens ? piperTokens.join('') : null;

        rows.push({
          input,
          jsChain: { output: jsOutput, error: js.error },
          piper: { tokens: piperTokens, joined: piperJoined, error: piper.error },
          identical: jsOutput !== null && piperJoined !== null && jsOutput === piperJoined,
        });
      }

      comparison[lang] = rows;
    }

    // ---- vocab check -------------------------------------------------------
    const vocabs = JSON.parse(
      readFileSync(resolve(OUT_DIR, 'kokoro-vocabs.json'), 'utf8')
    ) as VocabFile;

    const vocabSets = {
      'v1.0': new Set(requireVocab(vocabs, 'v1.0').chars),
      'v1.1-zh': new Set(requireVocab(vocabs, 'v1.1-zh').chars),
    };

    const vocabCheck: Record<string, unknown> = {
      vocabSizes: { 'v1.0': vocabSets['v1.0'].size, 'v1.1-zh': vocabSets['v1.1-zh'].size },
      languages: {},
    };

    for (const [lang, rows] of Object.entries(comparison)) {
      const piperChars = new Set<string>();
      const jsChars = new Set<string>();

      for (const row of rows) {
        if (row.piper.joined) for (const c of row.piper.joined) piperChars.add(c);
        if (row.jsChain.output) for (const c of row.jsChain.output) jsChars.add(c);
      }

      const perVocab: Record<string, unknown> = {};
      for (const [vocabName, set] of Object.entries(vocabSets)) {
        const missing = [...piperChars].filter((c) => !set.has(c) && !/\s/.test(c));
        perVocab[vocabName] = {
          missing: missing.sort(),
          missingCount: missing.length,
          piperCharCount: piperChars.size,
          // The denominator is the piper side: "how much of what piper emits
          // does the model not know". Whitespace is excluded from both sides
          // because the tokenizer normaliser drops it by design.
          missingRatio:
            piperChars.size === 0 ? 0 : Number((missing.length / piperChars.size).toFixed(4)),
        };
      }

      (vocabCheck.languages as Record<string, unknown>)[lang] = {
        piperChars: [...piperChars].sort(),
        jsChainChars: [...jsChars].sort(),
        jsChainMissingFromV1: [...jsChars]
          .filter((c) => !vocabSets['v1.0'].has(c) && !/\s/.test(c))
          .sort(),
        jsChainMissingFromV11zh: [...jsChars]
          .filter((c) => !vocabSets['v1.1-zh'].has(c) && !/\s/.test(c))
          .sort(),
        againstPiper: perVocab,
      };
    }

    // ---- write -------------------------------------------------------------
    const meta = {
      generatedAt: new Date().toISOString(),
      package: '@piper-plus/g2p',
      packageVersion: '0.4.2',
      node: process.version,
      sampleCount: Object.values(SAMPLES).length,
      perLanguage: Object.fromEntries(Object.entries(SAMPLES).map(([k, v]) => [k, v.length])),
      piperInitErrors: errors,
    };

    writeFileSync(
      resolve(OUT_DIR, 'piper-comparison.json'),
      `${JSON.stringify({ meta, comparison }, null, 2)}\n`
    );
    writeFileSync(
      resolve(OUT_DIR, 'vocab-check.json'),
      `${JSON.stringify({ meta, ...vocabCheck }, null, 2)}\n`
    );

    // The harness itself must have produced something for every sample.
    for (const rows of Object.values(comparison)) {
      expect(rows).toHaveLength(10);
    }
    // `errors` is data, not a failure — but it must be recorded.
    expect(Array.isArray(meta.piperInitErrors)).toBe(true);
  });

  it('measures the JS chain on the same 50-character samples', async () => {
    const perf: Record<string, unknown> = {
      meta: {
        generatedAt: new Date().toISOString(),
        subject: 'lib/models/phonemize/ (the chain that ships today)',
        node: process.version,
        iterations: PERF_ITERATIONS,
        sampleLength: 50,
      },
      languages: {},
    };

    for (const [lang, text] of Object.entries(PERF_SAMPLES)) {
      const phonemizer = await phonemizerFor(lang);
      // One warm-up call: the first Chinese sentence pays for jieba's wasm,
      // the first Japanese one for a 17 MB dictionary. Charging that to the
      // first sample would make the mean meaningless.
      await phonemizer.phonemize(text, langTagFor(lang));

      const samples: number[] = [];
      for (let i = 0; i < PERF_ITERATIONS; i += 1) {
        const start = performance.now();
        await phonemizer.phonemize(text, langTagFor(lang));
        samples.push(performance.now() - start);
      }

      const sorted = [...samples].sort((a, b) => a - b);
      const drop = Math.floor(sorted.length * 0.1);
      const kept = sorted.slice(drop, sorted.length - drop);
      const pick = (index: number): number => sorted[index] ?? 0;

      (perf.languages as Record<string, unknown>)[lang] = {
        minMs: Number(pick(0).toFixed(4)),
        medianMs: Number(pick(Math.floor(sorted.length / 2)).toFixed(4)),
        trimmedMeanMs: Number((kept.reduce((sum, v) => sum + v, 0) / kept.length).toFixed(4)),
        maxMs: Number(pick(sorted.length - 1).toFixed(4)),
      };
    }

    writeFileSync(
      resolve(OUT_DIR, 'js-chain-performance.json'),
      `${JSON.stringify(perf, null, 2)}\n`
    );

    expect(Object.keys(perf.languages as object)).toHaveLength(3);
  });
});
