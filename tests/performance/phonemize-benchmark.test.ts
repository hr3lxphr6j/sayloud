/**
 * What one sentence costs to phonemize, in milliseconds.
 *
 * This is a benchmark rather than a correctness test. The pipeline's output is
 * pinned elsewhere; what nothing else would notice is it becoming ten times
 * slower, and a user notices that as a stutter before a sentence rather than as
 * a wrong sound. The bounds below are therefore loose on purpose — they are
 * there to catch a change of kind, not a change of a few percent, because the
 * machine running them is not the machine they were measured on.
 *
 * It runs the **real** inputs: the wasm the build ships, the 8.5 MB IPADic
 * dictionary and the 1.6 MB Chinese word list. A benchmark on stand-in data
 * would measure the stand-in.
 *
 * `pnpm test:performance`. Not part of `pnpm test`, and not part of CI: the
 * numbers only mean something next to the machine they came from, and a shared
 * runner's noise would make a bound either useless or flaky.
 *
 * Four costs, each here rather than assumed:
 *
 * - **Per sentence, warm.** The number that matters: it is paid once per
 *   sentence, while the previous one is playing.
 * - **The first English call.** `EnglishG2p::new()` builds a 13 MB hash map out
 *   of the embedded CMU dictionary, lazily and once, so that cost lands on
 *   whichever sentence comes first unless something warms it. It is measured
 *   instead of being hidden by a warm-up loop.
 * - **Cold start.** `prepare` decompresses the dictionary inside the wasm —
 *   1.6 MB for Chinese, 8.5 MB for Japanese — which the plan's risk list names
 *   as the first sentence's cost. This says how big it actually is: the two
 *   numbers are almost entirely decompression, because the glue caches the
 *   compiled module after the first instance, which is why English's is 1 ms.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { DictionaryBytes } from '~/lib/models/phonemize-dict';
import { RustPhonemizer } from '~/lib/models/phonemize-rust';
import { FakeCaches, fakeFetch } from '../unit/models/fakes';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/** The wasm `pnpm build:wasm` produced, which is what the extension ships. */
const WASM = new Uint8Array(
  readFileSync(resolve(ROOT, 'lib/models/phonemize-wasm/phonemize_bg.wasm'))
);

const IPADIC_URL = '/dictionaries/lindera-ipadic-ja.bin.zst';
const JIEBA_URL = '/dictionaries/jieba-zh-dict.bin.zst';

function asset(name: string): DictionaryBytes {
  return new Uint8Array(readFileSync(resolve(ROOT, `public/dictionaries/${name}.bin.zst`)));
}

/**
 * A phonemizer wired to the real dictionaries, over the fake transport the unit
 * tests use. The wrapper's only requirement is something that answers with
 * bytes, and a real fetch would measure the loopback rather than the pipeline.
 */
function newPhonemizer(): RustPhonemizer {
  return new RustPhonemizer({
    wasm: WASM,
    fetch: fakeFetch({
      [IPADIC_URL]: { bytes: asset('lindera-ipadic-ja') },
      [JIEBA_URL]: { bytes: asset('jieba-zh-dict') },
    }),
    cacheStorage: new FakeCaches(),
  });
}

/** A sentence of roughly the length a reader's paragraphs are cut into. */
const CHINESE = '这是一段测试文本用于验证音素化的性能表现是否符合预期目标需要达到';
const JAPANESE = 'これはテストテキストで、音素化のパフォーマンスが期待通りか検証します。';
const ENGLISH = 'This is a test sentence, used to check how long phonemization takes.';

type Options = { frontend: 'kokoro-v1'; lang: string };

/** A prepared phonemizer, and the number of calls it has already answered. */
async function prepared(options: Options): Promise<RustPhonemizer> {
  const phonemizer = newPhonemizer();
  await phonemizer.ready;
  await phonemizer.prepare(options.frontend, options.lang);
  return phonemizer;
}

/**
 * The median of `iterations` calls, in milliseconds.
 *
 * The median rather than the mean: one garbage collection in a loop of twenty is
 * a plausible thing to happen, and it would move a mean by more than the
 * pipeline's own cost. The calls before these are warm-ups, so a lazy
 * initialisation is not being measured as if it were per-sentence work.
 */
function medianMs(phonemizer: RustPhonemizer, text: string, options: Options): number {
  const WARMUPS = 3;
  const ITERATIONS = 20;

  for (let index = 0; index < WARMUPS; index += 1) phonemizer.phonemize(text, options);

  const samples: number[] = [];
  for (let index = 0; index < ITERATIONS; index += 1) {
    const start = performance.now();
    phonemizer.phonemize(text, options);
    samples.push(performance.now() - start);
  }
  samples.sort((left, right) => left - right);
  return samples[Math.floor(samples.length / 2)] ?? Number.NaN;
}

/**
 * Bounds, measured on the development machine (Apple Silicon, 2026-10-04) and
 * then given the headroom each one's name records.
 *
 * Headroom rather than a tight fit on purpose: these have to survive a loaded
 * laptop, and the point is to catch a change of kind. The measured value is in
 * each comment so that a failure reports both numbers, the way the build-size
 * bound does.
 */
/** Measured 0.050 ms (zh, 32 chars), 0.039 ms (ja, 35), 0.037 ms (en): ~20x. */
const WARM_BOUND_MS = 1;
/** Measured 18.0 ms — the CMU hash map, once per phonemizer: ~8x. */
const FIRST_ENGLISH_BOUND_MS = 150;
/** Measured 77.5 ms (Chinese, 1.6 MB) and 165.2 ms (Japanese, 8.5 MB): ~6x. */
const COLD_BOUND_MS = 1000;

describe('the cost of one sentence, warm', () => {
  it('Chinese', async () => {
    const options: Options = { frontend: 'kokoro-v1', lang: 'zh-CN' };
    const phonemizer = await prepared(options);

    const median = medianMs(phonemizer, CHINESE, options);
    console.log(`Chinese, ${[...CHINESE].length} characters: ${median.toFixed(3)} ms (median)`);
    expect(median).toBeLessThan(WARM_BOUND_MS);
  });

  it('Japanese', async () => {
    const options: Options = { frontend: 'kokoro-v1', lang: 'ja-JP' };
    const phonemizer = await prepared(options);

    const median = medianMs(phonemizer, JAPANESE, options);
    console.log(`Japanese, ${[...JAPANESE].length} characters: ${median.toFixed(3)} ms (median)`);
    expect(median).toBeLessThan(WARM_BOUND_MS);
  });

  it('English, with the first call reported separately', async () => {
    const options: Options = { frontend: 'kokoro-v1', lang: 'en-US' };
    const phonemizer = await prepared(options);

    const start = performance.now();
    const first = phonemizer.phonemize(ENGLISH, options);
    const firstMs = performance.now() - start;

    const median = medianMs(phonemizer, ENGLISH, options);
    console.log(
      `English: first call ${firstMs.toFixed(3)} ms, then ${median.toFixed(3)} ms (median)`
    );

    // Bounded separately, because it is a different cost: the hash map is built
    // once per document, and holding it to the per-sentence bound would fail on
    // a slow machine for something the user pays once.
    expect(first.phonemes.length).toBeGreaterThan(0);
    expect(firstMs).toBeLessThan(FIRST_ENGLISH_BOUND_MS);
    expect(median).toBeLessThan(WARM_BOUND_MS);
  });
});

describe('the cost of starting from nothing', () => {
  it('Chinese, including its 1.6 MB dictionary', async () => {
    const start = performance.now();
    await prepared({ frontend: 'kokoro-v1', lang: 'zh-CN' });
    const elapsed = performance.now() - start;

    console.log(`Cold start, Chinese: ${elapsed.toFixed(1)} ms (wasm + 1.6 MB dictionary)`);
    expect(elapsed).toBeLessThan(COLD_BOUND_MS);
  });

  it('Japanese, including its 8.5 MB dictionary', async () => {
    const start = performance.now();
    await prepared({ frontend: 'kokoro-v1', lang: 'ja-JP' });
    const elapsed = performance.now() - start;

    console.log(`Cold start, Japanese: ${elapsed.toFixed(1)} ms (wasm + 8.5 MB dictionary)`);
    expect(elapsed).toBeLessThan(COLD_BOUND_MS);
  });

  it('English, which needs no dictionary at all', async () => {
    const start = performance.now();
    await prepared({ frontend: 'kokoro-v1', lang: 'en-US' });
    const elapsed = performance.now() - start;

    console.log(`Cold start, English: ${elapsed.toFixed(1)} ms (wasm only)`);
    expect(elapsed).toBeLessThan(COLD_BOUND_MS);
  });
});
