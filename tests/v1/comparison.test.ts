/**
 * P6 V1: `piper-plus@0.7.0`'s Rust wasm versus the existing JS chain.
 *
 * Like the V0 harness this file's output is *data*, not assertions: it runs the
 * same 30 samples through three front ends and writes
 * `piper-plus-comparison.json` and `vocab-check.json`. The verdict lives in
 * `v1-summary.md`, because "is this output good enough" is not a boolean.
 *
 * The three chains:
 *
 *   - **JS chain** — `lib/models/phonemize/`, what ships today (the reference).
 *   - **wasm** — `piper-plus/wasm/multilingual`. Measured twice for Chinese:
 *     as shipped (no pinyin dictionary, which is what the npm tarball gives
 *     you) and with the TONE3 dictionaries this harness derives from upstream.
 *   - **v0 g2p** — `@piper-plus/g2p@0.4.2`, read out of `tests/v0/` as the
 *     known-failed reference, so the three-way comparison is in one file.
 *
 * Reading the wasm's output needs care: it returns phoneme *IDs*, so the
 * harness inverts an exhaustive `phoneme_id_map` to recover the phoneme
 * string, and expands the PUA code points piper-plus uses for multi-character
 * tokens. See `wasm-harness.mjs`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { phonemizerFor } from '~/lib/models/phonemize';
import { createHarness, createVocabHarness } from './wasm-harness.mjs';

const OUT_DIR = resolve(process.cwd(), 'tests/v1');
const V0_DIR = resolve(process.cwd(), 'tests/v0');

/** The same 30 samples V0 used, so the two reports are directly comparable. */
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

const LANG_TAG: Record<string, string> = { zh: 'zh-CN', ja: 'ja-JP', en: 'en-US' };

function langTagFor(lang: string): string {
  return LANG_TAG[lang] ?? lang;
}

interface VocabFile {
  [key: string]: { source: string; count: number; chars: string[] };
}

function requireVocab(vocabs: VocabFile, key: string): VocabFile[string] {
  const found = vocabs[key];
  if (!found) throw new Error(`kokoro-vocabs.json has no "${key}" vocabulary`);
  return found;
}

/** Run one thunk, turning a throw into `{ error }` instead of aborting. */
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

/**
 * Classify what the wasm produced for one sample.
 *
 * `passthrough` is the failure mode that matters: piper-plus falls back to
 * character-level tokenisation whenever a language has no G2P wired up, and a
 * character-level echo of the input is not a phoneme string. Detected by
 * comparing the emitted tokens against the input's own characters, ignoring
 * whitespace (the encoder drops spaces).
 */
function classify(input: string, wasmOutput: string | null, jsOutput: string | null): string {
  if (wasmOutput === null) return 'error';
  const strip = (value: string) => value.replace(/\s+/g, '');
  const wasmBare = strip(wasmOutput);
  const inputBare = strip(input);
  if (wasmBare === inputBare) return 'passthrough';
  if (jsOutput !== null && wasmBare === strip(jsOutput)) return 'identical';
  // Both sides non-empty and neither echoes the input: a genuine G2P difference.
  return 'ipa-differs';
}

interface SampleRow {
  input: string;
  jsChain: { output: string | null; error: string | null };
  wasm: {
    tokens: string[] | null;
    output: string | null;
    puaTokens: string[] | null;
    puaOutput: string | null;
    detected: string | null;
    error: string | null;
    classification: string;
  };
  /** Chinese only: the same call after `setChineseDictionary` (TONE3 dicts). */
  wasmWithZhDict: {
    tokens: string[] | null;
    output: string | null;
    puaTokens: string[] | null;
    puaOutput: string | null;
    error: string | null;
    classification: string;
  } | null;
  v0G2P: { output: string | null; error: string | null };
}

describe('V1: piper-plus Rust wasm vs the JS chain', () => {
  it('compares all 30 samples and writes piper-plus-comparison.json', async () => {
    const harness = await createHarness();

    // V0's results are read back rather than re-run: it is the same package and
    // the same samples, and re-running it would add nothing but runtime.
    const v0 = JSON.parse(readFileSync(resolve(V0_DIR, 'piper-comparison.json'), 'utf8')) as {
      comparison: Record<
        string,
        { input: string; piper: { joined: string | null; error: string | null } }[]
      >;
    };
    const v0ByInput = new Map<string, { output: string | null; error: string | null }>();
    for (const rows of Object.values(v0.comparison)) {
      for (const row of rows) {
        v0ByInput.set(row.input, { output: row.piper.joined, error: row.piper.error });
      }
    }

    const comparison: Record<string, SampleRow[]> = {};
    const perLanguageSummary: Record<string, unknown> = {};

    for (const [lang, samples] of Object.entries(SAMPLES)) {
      const rows: SampleRow[] = [];
      const jsPhonemizer = await phonemizerFor(lang);

      // Chinese as shipped: no dictionary, so the phonemizer is in its initial
      // PassthroughPhonemizer state. This pass must run before the dictionary
      // is installed, because setChineseDictionary mutates the instance.
      const zhDictLoaded = lang === 'zh';
      if (zhDictLoaded) {
        // Nothing to do: `createHarness()` is dictionary-free by construction.
      }

      for (const input of samples) {
        const js = await captureAsync(() => jsPhonemizer.phonemize(input, langTagFor(lang)));
        const wasmResult = capture(() => harness.phonemize(input, lang));
        const v0Ref = v0ByInput.get(input) ?? { output: null, error: 'absent from V0 report' };

        rows.push({
          input,
          jsChain: { output: js.value, error: js.error },
          wasm: wasmResult.value
            ? {
                tokens: wasmResult.value.tokens,
                output: wasmResult.value.output,
                puaTokens: wasmResult.value.puaTokens,
                puaOutput: wasmResult.value.puaOutput,
                detected: harness.detectLanguage(input),
                error: null,
                classification: classify(input, wasmResult.value.output, js.value),
              }
            : {
                tokens: null,
                output: null,
                puaTokens: null,
                puaOutput: null,
                detected: null,
                error: wasmResult.error,
                classification: 'error',
              },
          wasmWithZhDict: null,
          v0G2P: v0Ref,
        });
      }

      // Second pass: with the TONE3 dictionaries installed.
      let zhDictPass: SampleRow[] | null = null;
      if (zhDictLoaded) {
        harness.loadChineseDictionary('converted');
        zhDictPass = [];
        for (const row of rows) {
          const jsOutput = row.jsChain.output;
          const withDict = capture(() => harness.phonemize(row.input, lang));
          zhDictPass.push({
            ...row,
            wasmWithZhDict: withDict.value
              ? {
                  tokens: withDict.value.tokens,
                  output: withDict.value.output,
                  puaTokens: withDict.value.puaTokens,
                  puaOutput: withDict.value.puaOutput,
                  error: null,
                  classification: classify(row.input, withDict.value.output, jsOutput),
                }
              : {
                  tokens: null,
                  output: null,
                  puaTokens: null,
                  puaOutput: null,
                  error: withDict.error,
                  classification: 'error',
                },
          });
        }
      }

      comparison[lang] = zhDictPass ?? rows;

      const classifications = (
        list: SampleRow[],
        which: 'wasm' | 'wasmWithZhDict'
      ): Record<string, number> => {
        const counts: Record<string, number> = {};
        for (const row of list) {
          const source = which === 'wasm' ? row.wasm : row.wasmWithZhDict;
          if (!source) continue;
          const key = source.classification;
          counts[key] = (counts[key] ?? 0) + 1;
        }
        return counts;
      };
      perLanguageSummary[lang] = {
        asShipped: classifications(rows, 'wasm'),
        withZhDict: zhDictPass ? classifications(zhDictPass, 'wasmWithZhDict') : null,
      };
    }

    // ---- vocab check -------------------------------------------------------
    const vocabs = JSON.parse(
      readFileSync(resolve(V0_DIR, 'kokoro-vocabs.json'), 'utf8')
    ) as VocabFile;
    const vocabSets = {
      'v1.0': new Set(requireVocab(vocabs, 'v1.0').chars),
      'v1.1-zh': new Set(requireVocab(vocabs, 'v1.1-zh').chars),
    };

    const vocabCheck: Record<string, unknown> = {
      vocabSizes: { 'v1.0': vocabSets['v1.0'].size, 'v1.1-zh': vocabSets['v1.1-zh'].size },
      method:
        'Two independent measurements. (1) character-set diff of the wasm output against ' +
        'each vocabulary, run on both the raw PUA form (what a model config would have to ' +
        'key on) and the PUA-expanded form. (2) the vocabulary is used as the wasm ' +
        "phoneme_id_map, so the encoder's own lookup reports how many phonemes it " +
        'cannot resolve -- the encoder replaces those with the PAD token.',
      languages: {},
      vocabAsIdMap: {},
    };

    // The PUA-expanded form is compared too, because un-mapping PUA is a
    // legitimate adaptation step and it changes the answer a lot.
    //
    // Chinese gets a second pair of harnesses with the TONE3 dictionaries
    // installed, because measuring the passthrough state only says "Han
    // characters are not in the vocabulary" -- true, but it says nothing about
    // the G2P output an integrator would actually be adapting.
    const harnesses = {
      asShipped: {
        'v1.0': await createVocabHarness([...vocabSets['v1.0']]),
        'v1.1-zh': await createVocabHarness([...vocabSets['v1.1-zh']]),
      },
      zhWithDictionary: {
        'v1.0': await createVocabHarness([...vocabSets['v1.0']], {
          chineseDictionary: 'converted',
        }),
        'v1.1-zh': await createVocabHarness([...vocabSets['v1.1-zh']], {
          chineseDictionary: 'converted',
        }),
      },
    };
    (vocabCheck as Record<string, unknown>).vocabAsIdMap = {
      note:
        'droppedRatio is the share of phonemes the vocabulary cannot resolve, measured with ' +
        'the vocabulary itself as phoneme_id_map (the encoder replaces unresolvable ' +
        'phonemes with PAD). `asShipped` is the package as delivered; ' +
        '`zhWithDictionary` installs the TONE3 pinyin dictionaries first and is only ' +
        'meaningful for zh.',
      'v1.0': {
        mapSize: harnesses.asShipped['v1.0'].mapSize,
        constructMs: harnesses.asShipped['v1.0'].constructMs,
      },
      'v1.1-zh': {
        mapSize: harnesses.asShipped['v1.1-zh'].mapSize,
        constructMs: harnesses.asShipped['v1.1-zh'].constructMs,
      },
      languages: {},
    };

    const idMapLanguages: Record<string, unknown> = {};
    for (const [lang, rows] of Object.entries(comparison)) {
      const rawChars = new Set<string>();
      const expandedChars = new Set<string>();
      const jsChars = new Set<string>();

      for (const row of rows) {
        const wasmRow = row.wasmWithZhDict ?? row.wasm;
        if (wasmRow.puaOutput) for (const c of wasmRow.puaOutput) rawChars.add(c);
        if (wasmRow.output) for (const c of wasmRow.output) expandedChars.add(c);
        if (row.jsChain.output) for (const c of row.jsChain.output) jsChars.add(c);
      }

      const diff = (chars: Set<string>, set: Set<string>) =>
        [...chars].filter((c) => !set.has(c) && !/\s/.test(c)).sort();

      const perVocab: Record<string, unknown> = {};
      for (const [vocabName, set] of Object.entries(vocabSets)) {
        const rawMissing = diff(rawChars, set);
        const expandedMissing = diff(expandedChars, set);
        perVocab[vocabName] = {
          rawForm: {
            missing: rawMissing,
            missingCount: rawMissing.length,
            wasmCharCount: rawChars.size,
            missingRatio:
              rawChars.size === 0 ? 0 : Number((rawMissing.length / rawChars.size).toFixed(4)),
          },
          puaExpandedForm: {
            missing: expandedMissing,
            missingCount: expandedMissing.length,
            wasmCharCount: expandedChars.size,
            missingRatio:
              expandedChars.size === 0
                ? 0
                : Number((expandedMissing.length / expandedChars.size).toFixed(4)),
          },
        };
      }

      (vocabCheck.languages as Record<string, unknown>)[lang] = {
        wasmCharsRaw: [...rawChars].sort(),
        wasmCharsPuaExpanded: [...expandedChars].sort(),
        jsChainChars: [...jsChars].sort(),
        jsChainMissingFromV1: diff(jsChars, vocabSets['v1.0']),
        jsChainMissingFromV11zh: diff(jsChars, vocabSets['v1.1-zh']),
        againstWasm: perVocab,
      };

      // Per-sample drop measurement, using each vocabulary as the id map.
      const perSample: Record<string, unknown>[] = [];
      for (const row of rows) {
        const wasmRow = row.wasmWithZhDict ?? row.wasm;
        const entry: Record<string, unknown> = {
          input: row.input,
          wasmTokens: wasmRow.tokens,
          puaTokens: wasmRow.puaTokens,
          asShipped: {},
          zhWithDictionary: lang === 'zh' ? {} : null,
        };
        for (const vocabName of Object.keys(vocabSets)) {
          (entry.asShipped as Record<string, unknown>)[vocabName] = harnesses.asShipped[
            vocabName as keyof typeof harnesses.asShipped
          ].analyze(row.input, lang);
          if (lang === 'zh') {
            (entry.zhWithDictionary as Record<string, unknown>)[vocabName] =
              harnesses.zhWithDictionary[
                vocabName as keyof typeof harnesses.zhWithDictionary
              ].analyze(row.input, lang);
          }
        }
        perSample.push(entry);
      }
      idMapLanguages[lang] = perSample;
    }
    (vocabCheck.vocabAsIdMap as Record<string, unknown>).languages = idMapLanguages;

    // Aggregate the drop ratios per language, per vocabulary, per mode.
    interface DropEntry {
      totalPhonemes: number;
      dropped: number;
    }
    const aggregate = (
      samples: Record<string, unknown>[],
      mode: 'asShipped' | 'zhWithDictionary',
      vocabName: string
    ): { totalPhonemes: number; dropped: number; droppedRatio: number } => {
      const totals = samples.reduce<{ total: number; dropped: number }>(
        (acc, sample) => {
          const group = sample[mode] as Record<string, DropEntry> | null;
          const entry = group?.[vocabName];
          if (!entry) return acc;
          acc.total += entry.totalPhonemes;
          acc.dropped += entry.dropped;
          return acc;
        },
        { total: 0, dropped: 0 }
      );
      return {
        totalPhonemes: totals.total,
        dropped: totals.dropped,
        droppedRatio: totals.total === 0 ? 0 : Number((totals.dropped / totals.total).toFixed(4)),
      };
    };

    const dropSummary: Record<string, unknown> = {};
    for (const [lang, samples] of Object.entries(idMapLanguages)) {
      const list = samples as Record<string, unknown>[];
      dropSummary[lang] = {
        asShipped: {
          'v1.0': aggregate(list, 'asShipped', 'v1.0'),
          'v1.1-zh': aggregate(list, 'asShipped', 'v1.1-zh'),
        },
        zhWithDictionary:
          lang === 'zh'
            ? {
                'v1.0': aggregate(list, 'zhWithDictionary', 'v1.0'),
                'v1.1-zh': aggregate(list, 'zhWithDictionary', 'v1.1-zh'),
              }
            : null,
      };
    }
    (vocabCheck.vocabAsIdMap as Record<string, unknown>).summary = dropSummary;

    // ---- write -------------------------------------------------------------
    const meta = {
      generatedAt: new Date().toISOString(),
      package: 'piper-plus',
      packageVersion: '0.7.0',
      wasmBuild: 'multilingual (features: ja, zh, ko, es, fr, pt, sv)',
      node: process.version,
      sampleCount: Object.values(SAMPLES).reduce((sum, list) => sum + list.length, 0),
      perLanguage: Object.fromEntries(Object.entries(SAMPLES).map(([k, v]) => [k, v.length])),
      wasmTimings: harness.timings,
      wasmSupportedLanguages: harness.supportedLanguages(),
      zhEnDispatchEnabled: harness.isZhEnDispatchEnabled(),
      notes: [
        'Chinese is measured twice: as shipped (no pinyin dictionary ships in the npm ' +
          'tarball, so the phonemizer stays in its initial passthrough state) and with ' +
          'TONE3 dictionaries derived from upstream by scripts/convert-pinyin-tone3.mjs.',
        'The wasm build does not include English at all: the `multilingual` feature list ' +
          'is [ja, zh, ko, es, fr, pt, sv], so English falls back to character-level ' +
          'passthrough. English is handled by the JS layer in piper-plus itself.',
        'v0G2P is copied from tests/v0/piper-comparison.json (@piper-plus/g2p@0.4.2).',
        'Language detection is not reliable on its own: `detectLanguage` answers "zh" for ' +
          'every kanji-only string (経営, 日本語, 漢字, 東京, ...). The `language` argument to ' +
          'phonemize() does override it -- every Japanese sample here is phonemized with an ' +
          'explicit "ja" hint, which is the only reason kanji-only samples produced Japanese ' +
          'readings. The `detected` field records what auto-detection would have chosen.',
      ],
      perLanguageSummary,
    };

    writeFileSync(
      resolve(OUT_DIR, 'piper-plus-comparison.json'),
      `${JSON.stringify({ meta, comparison }, null, 2)}\n`
    );
    writeFileSync(
      resolve(OUT_DIR, 'vocab-check.json'),
      `${JSON.stringify({ meta, ...vocabCheck }, null, 2)}\n`
    );

    // The harness must have produced a row for every sample.
    for (const rows of Object.values(comparison)) {
      expect(rows).toHaveLength(10);
    }
    expect(harness.timings.wasmBytes).toBeGreaterThan(50_000_000);
  });

  it('records the three-way per-language classification counts', async () => {
    const report = JSON.parse(
      readFileSync(resolve(OUT_DIR, 'piper-plus-comparison.json'), 'utf8')
    ) as { meta: { perLanguageSummary: Record<string, unknown> } };
    // Every language must have been classified; a silently empty summary would
    // make the markdown tables in v1-summary.md lie.
    expect(Object.keys(report.meta.perLanguageSummary).sort()).toEqual(['en', 'ja', 'zh']);
  });
});
