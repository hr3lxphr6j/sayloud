/**
 * A performance benchmark for `@piper-plus/g2p`, the JavaScript candidate the
 * phonemizer evaluation measured first.
 *
 * Run with `node tests/v0/performance-benchmark.mjs`. Writes
 * `performance-results.json` next to itself and prints a table.
 *
 * A note on what "wasm load time" means here: this package ships **no wasm**.
 * It is pure JavaScript rule tables (283.8 KB of source, 23 files). So the
 * first metric measures module import plus per-language construction, which is
 * the equivalent cold-start cost — there is no instantiation step to measure,
 * and reporting one would be inventing a number.
 *
 * Japanese is expected to fail: `JapaneseG2P` requires an OpenJTalk wasm module
 * injected via `G2P.create({ openjtalkModule })`, and the package neither ships
 * one nor bundles the ~55 MB dictionary it needs. The failure is recorded
 * rather than thrown, because it is a finding, not a crash.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

/** Targets set for this candidate before it was measured. */
const TARGETS = {
  loadMs: 100,
  zhMsPerSentence: 1,
  jaMsPerSentence: 1,
  enMsPerSentence: 5,
  memoryMb: 50,
};

const ITERATIONS = 20;

/** Exactly 50 characters per language, so the three numbers are comparable. */
const SAMPLES = {
  zh: '人工智能技术正在快速发展并且深刻改变着我们日常生活的方方面面今天天气非常好我们一起去公园散步吧很开心',
  ja: '日本語の音声合成技術は急速に発展しており私たちの日常生活のさまざまな場面で活用されていますとても便利',
  en: 'Artificial intelligence is advancing rapidly today',
};

for (const [lang, text] of Object.entries(SAMPLES)) {
  const length = [...text].length;
  if (length !== 50) {
    throw new Error(`sample for ${lang} is ${length} characters, expected 50`);
  }
}

/** Mean of the middle 80% of samples, which drops the first-call JIT spike. */
function trimmedMean(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const drop = Math.floor(sorted.length * 0.1);
  const kept = sorted.slice(drop, sorted.length - drop);
  return kept.reduce((sum, value) => sum + value, 0) / kept.length;
}

function stats(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    iterations: samples.length,
    minMs: Number(sorted[0].toFixed(4)),
    medianMs: Number(sorted[Math.floor(sorted.length / 2)].toFixed(4)),
    trimmedMeanMs: Number(trimmedMean(samples).toFixed(4)),
    maxMs: Number(sorted[sorted.length - 1].toFixed(4)),
  };
}

/** Run `fn` `ITERATIONS` times, returning per-call durations in ms. */
function time(fn) {
  const samples = [];
  for (let i = 0; i < ITERATIONS; i += 1) {
    const start = performance.now();
    fn();
    samples.push(performance.now() - start);
  }
  return samples;
}

function mb(bytes) {
  return Number((bytes / 1024 / 1024).toFixed(2));
}

// ---- 1. module import -------------------------------------------------------

const importStart = performance.now();
const mod = await import('@piper-plus/g2p');
const importMs = performance.now() - importStart;

const { G2P, EnglishG2P, ChineseG2P } = mod;

const results = {
  meta: {
    generatedAt: new Date().toISOString(),
    package: '@piper-plus/g2p',
    packageVersion: '0.4.2',
    node: process.version,
    iterations: ITERATIONS,
    sampleLength: 50,
    targets: TARGETS,
    note:
      'This package ships no wasm; "load" is ES module import time plus per-language construction.',
  },
  load: {
    moduleImportMs: Number(importMs.toFixed(4)),
    targetMs: TARGETS.loadMs,
    pass: importMs < TARGETS.loadMs,
  },
  languages: {},
  memory: null,
  verdict: null,
};

// ---- 2-4. per language ------------------------------------------------------

async function benchmarkLanguage(lang) {
  const text = SAMPLES[lang];

  const initStart = performance.now();
  let phonemize;
  let mode = null;

  try {
    if (lang === 'en') {
      const g2p = new EnglishG2P();
      phonemize = (input) => g2p.phonemize(input).tokens.join('');
      mode = 'rule-based (pure JS)';
    } else if (lang === 'zh') {
      const g2p = new ChineseG2P();
      phonemize = (input) => g2p.phonemize(input).tokens.join('');
      mode = g2p.mode;
    } else {
      const g2p = await G2P.create({ languages: ['ja'] });
      phonemize = (input) => g2p.phonemize(input, { language: 'ja' }).tokens.join('');
      mode = 'openjtalk';
    }
  } catch (error) {
    return {
      initMs: Number((performance.now() - initStart).toFixed(4)),
      status: 'blocked',
      mode: null,
      error: error instanceof Error ? error.message : String(error),
      stats: null,
      targetMs: TARGETS[`${lang}MsPerSentence`],
      pass: false,
    };
  }

  const initMs = performance.now() - initStart;
  const output = phonemize(text);
  const samples = time(() => phonemize(text));
  const s = stats(samples);

  return {
    initMs: Number(initMs.toFixed(4)),
    status: 'ok',
    mode,
    error: null,
    output,
    outputLength: [...output].length,
    stats: s,
    targetMs: TARGETS[`${lang}MsPerSentence`],
    pass: s.trimmedMeanMs < TARGETS[`${lang}MsPerSentence`],
  };
}

for (const lang of ['zh', 'ja', 'en']) {
  results.languages[lang] = await benchmarkLanguage(lang);
}

// The Chinese number is fast because it does nothing: `ChineseG2P` in this
// package is character-level passthrough (`mode: 'fallback'`), so what was
// measured is the cost of splitting a string into characters. Flagged rather
// than counted, because a 0.002 ms "pass" that produces the input text back
// would otherwise flatter the verdict.
for (const [lang, r] of Object.entries(results.languages)) {
  r.meaningful = r.status === 'ok' && r.mode !== 'fallback';
  if (r.status === 'ok' && !r.meaningful) {
    r.meaningfulNote =
      `${lang} ran in character-passthrough fallback mode; it emits no phonemes, so this ` +
      'timing measures string iteration rather than G2P.';
  }
}

// ---- 5. memory --------------------------------------------------------------

if (global.gc) global.gc();
const usage = process.memoryUsage();
results.memory = {
  rssMb: mb(usage.rss),
  heapTotalMb: mb(usage.heapTotal),
  heapUsedMb: mb(usage.heapUsed),
  externalMb: mb(usage.external),
  arrayBuffersMb: mb(usage.arrayBuffers),
  // Heap is the number a browser extension can actually budget for; rss
  // includes the Node runtime itself.
  heapUsedTargetMb: TARGETS.memoryMb,
  pass: mb(usage.heapUsed) < TARGETS.memoryMb,
};

// ---- verdict ----------------------------------------------------------------

const checks = {
  load: results.load.pass,
  zh: results.languages.zh.pass,
  ja: results.languages.ja.pass,
  en: results.languages.en.pass,
  memory: results.memory.pass,
};

const passed = Object.values(checks).filter(Boolean).length;
const total = Object.values(checks).length;

// "Meaningful" excludes checks that passed without exercising any G2P: a
// language that returns its input unchanged is trivially fast.
const meaningfulChecks = {
  load: results.load.pass,
  zh: results.languages.zh.pass && results.languages.zh.meaningful,
  ja: results.languages.ja.pass && results.languages.ja.meaningful,
  en: results.languages.en.pass && results.languages.en.meaningful,
  memory: results.memory.pass,
};
const meaningfulPassed = Object.values(meaningfulChecks).filter(Boolean).length;

results.verdict = {
  checks,
  passed,
  total,
  passRate: Number((passed / total).toFixed(2)),
  meetsBriefThreshold: passed / total >= 0.8,
  meaningfulChecks,
  meaningfulPassed,
  meaningfulTotal: Object.keys(meaningfulChecks).length,
  meaningfulPassRate: Number((meaningfulPassed / Object.keys(meaningfulChecks).length).toFixed(2)),
};

writeFileSync(
  resolve(OUT_DIR, 'performance-results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);

// ---- report -----------------------------------------------------------------

console.log('\n=== @piper-plus/g2p performance (50 chars, 20 iterations) ===\n');
console.log(`module import          ${importMs.toFixed(3)} ms   (target < ${TARGETS.loadMs})`);
for (const lang of ['zh', 'ja', 'en']) {
  const r = results.languages[lang];
  if (r.status === 'blocked') {
    console.log(`${lang.padEnd(22)} BLOCKED: ${r.error?.slice(0, 70)}`);
  } else {
    console.log(
      `${lang.padEnd(22)} ${String(r.stats.trimmedMeanMs).padStart(7)} ms  ` +
        `(median ${r.stats.medianMs} ms, target < ${r.targetMs})  ${r.pass ? 'PASS' : 'FAIL'}`,
    );
  }
}
console.log(
  `\nheap used              ${results.memory.heapUsedMb} MB   (target < ${TARGETS.memoryMb})  ` +
    `${results.memory.pass ? 'PASS' : 'FAIL'}`,
);
console.log(`\nverdict: ${passed}/${total} checks passed`);
console.log(
  `meaningful: ${results.verdict.meaningfulPassed}/${results.verdict.meaningfulTotal} ` +
    '(excludes timings that measured a no-op)',
);
console.log(`wrote ${resolve(OUT_DIR, 'performance-results.json')}\n`);
