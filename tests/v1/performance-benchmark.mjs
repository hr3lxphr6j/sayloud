/**
 * A performance benchmark for `piper-plus@0.7.0`'s Rust wasm, the second
 * candidate the phonemizer evaluation measured.
 *
 *   node tests/v1/performance-benchmark.mjs
 *
 * Writes `performance-results.json` next to itself and prints a table.
 *
 * The targets set for this candidate: wasm load < 200 ms, initialisation < 500 ms,
 * Chinese and Japanese 50-character sentences < 2 ms, English < 10 ms, heap
 * < 100 MB.
 *
 * Two of those measurements need a caveat, and the JSON marks them rather than
 * quietly counting them:
 *
 *   - **English** in this wasm build is character-level passthrough (the
 *     `multilingual` Cargo feature does not include `en`). It is fast because it
 *     does nothing, exactly like the JavaScript candidate's Chinese, which is
 *     passthrough there too (its Chinese mode is `fallback`). `meaningful: false`.
 *   - **Chinese** is measured twice. As shipped there is no pinyin dictionary,
 *     so it is also passthrough and also meaningless. With the TONE3
 *     dictionaries installed it does real work, and that number is the one that
 *     means anything.
 *
 * The reference numbers in `tests/v0/js-chain-performance.json` came from the
 * same machine and the same 50-character samples, so the comparison is
 * same-machine rather than cross-session.
 */
import { writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { createHarness } from './wasm-harness.mjs';

const OUT_DIR = dirname(fileURLToPath(import.meta.url));

/** Targets set for this candidate before it was measured. */
const TARGETS = {
  wasmLoadMs: 200,
  initMs: 500,
  zhMsPerSentence: 2,
  jaMsPerSentence: 2,
  enMsPerSentence: 10,
  memoryMb: 100,
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

// ---- 1. module import (the glue JS, not the binary) -------------------------

const importStart = performance.now();
const glue = await import('piper-plus/wasm/multilingual');
const importMs = performance.now() - importStart;

// ---- 2. wasm instantiation (this is where the 57 MB is paid) ---------------

const { readFileSync } = await import('node:fs');
const { WASM_PATH } = await import('./wasm-harness.mjs');
const bytes = readFileSync(WASM_PATH);

const loadStart = performance.now();
glue.initSync({ module: bytes });
const wasmLoadMs = performance.now() - loadStart;

// ---- 3. phonemizer construction (dictionary becomes usable here) -----------

const harness = await createHarness();

const results = {
  meta: {
    generatedAt: new Date().toISOString(),
    package: 'piper-plus',
    packageVersion: '0.7.0',
    wasmBuild: 'multilingual (ja, zh, ko, es, fr, pt, sv)',
    wasmBytes: bytes.byteLength,
    node: process.version,
    iterations: ITERATIONS,
    sampleLength: 50,
    targets: TARGETS,
    note:
      'wasmLoadMs is WebAssembly.Module compilation + instantiation of the 57 MB binary ' +
      '(initSync). constructMs is `new WasmPhonemizer(config)`, which is where the bundled ' +
      'NAIST-JDIC dictionary becomes usable. Both are paid again every time Chrome reclaims ' +
      'the offscreen document.',
  },
  load: {
    moduleImportMs: Number(importMs.toFixed(4)),
    wasmLoadMs: Number(wasmLoadMs.toFixed(4)),
    wasmLoadTargetMs: TARGETS.wasmLoadMs,
    pass: wasmLoadMs < TARGETS.wasmLoadMs,
  },
  init: {
    constructMs: harness.timings.constructMs,
    initTargetMs: TARGETS.initMs,
    pass: harness.timings.constructMs < TARGETS.initMs,
  },
  languages: {},
  memory: null,
  verdict: null,
};

// ---- 4. per language -------------------------------------------------------

/**
 * @param {string} lang
 * @param {boolean} withZhDict - Chinese only: install the TONE3 dictionaries
 *   first, so the timing measures pinyin conversion instead of passthrough.
 */
function benchmarkLanguage(lang, withZhDict = false) {
  const text = SAMPLES[lang];
  if (withZhDict) harness.loadChineseDictionary('converted');

  // One warm-up call, excluded from the samples.
  harness.phonemize(text, lang);

  const samples = time(() => harness.phonemize(text, lang));
  const s = stats(samples);
  const result = harness.phonemize(text, lang);

  // A language that echoes its input back is not doing G2P; its timing measures
  // string iteration. Flagged so the pass rate cannot be flattered.
  const inputBare = text.replace(/\s+/g, '');
  const meaningful = result.output.replace(/\s+/g, '') !== inputBare;

  return {
    status: 'ok',
    mode: meaningful ? 'rust-g2p' : 'passthrough',
    meaningful,
    meaningfulNote: meaningful
      ? null
      : `${lang} is in character-passthrough mode in this wasm build; the timing ` +
        'measures string iteration, not G2P.',
    output: result.output,
    outputLength: [...result.output].length,
    puaTokenCount: result.puaTokens.length,
    stats: s,
    targetMs: TARGETS[`${lang}MsPerSentence`],
    pass: s.trimmedMeanMs < TARGETS[`${lang}MsPerSentence`],
  };
}

results.languages.ja = benchmarkLanguage('ja');
results.languages.zh = benchmarkLanguage('zh');
results.languages.en = benchmarkLanguage('en');
results.languages.zhWithDictionary = {
  ...benchmarkLanguage('zh', true),
  note: 'same call with the TONE3 pinyin dictionaries installed',
};
results.languages.zhAsShipped = results.languages.zh;

// ---- 5. memory -------------------------------------------------------------

if (global.gc) global.gc();
const usage = process.memoryUsage();
results.memory = {
  rssMb: mb(usage.rss),
  heapTotalMb: mb(usage.heapTotal),
  heapUsedMb: mb(usage.heapUsed),
  externalMb: mb(usage.external),
  arrayBuffersMb: mb(usage.arrayBuffers),
  // The wasm's own linear memory is the interesting number here: the bundled
  // dictionary lives in it, and `external` is where Node accounts for it.
  heapUsedTargetMb: TARGETS.memoryMb,
  pass: mb(usage.heapUsed) < TARGETS.memoryMb,
};

// ---- verdict ---------------------------------------------------------------

const checks = {
  wasmLoad: results.load.pass,
  init: results.init.pass,
  ja: results.languages.ja.pass && results.languages.ja.meaningful,
  zh: results.languages.zhWithDictionary.pass && results.languages.zhWithDictionary.meaningful,
  en: results.languages.en.pass && results.languages.en.meaningful,
  memory: results.memory.pass,
};
const passed = Object.values(checks).filter(Boolean).length;
const total = Object.values(checks).length;

results.verdict = {
  checks,
  passed,
  total,
  passRate: Number((passed / total).toFixed(2)),
  meetsBriefThreshold: passed / total >= 0.8,
  note:
    'zh is scored on the dictionary-installed measurement, since the as-shipped ' +
    'passthrough would make it trivially fast. en cannot pass at all: this build has no ' +
    'English G2P, so its timing measures a no-op.',
};

writeFileSync(
  resolve(OUT_DIR, 'performance-results.json'),
  `${JSON.stringify(results, null, 2)}\n`,
);

// ---- report -----------------------------------------------------------------

console.log('\n=== piper-plus@0.7.0 Rust wasm performance (50 chars, 20 iterations) ===\n');
console.log(`wasm binary            ${mb(bytes.byteLength)} MB`);
console.log(`module import          ${importMs.toFixed(3)} ms`);
console.log(
  `wasm load (initSync)   ${wasmLoadMs.toFixed(3)} ms   (target < ${TARGETS.wasmLoadMs})  ` +
    `${results.load.pass ? 'PASS' : 'FAIL'}`,
);
console.log(
  `phonemizer construct   ${results.init.constructMs} ms   (target < ${TARGETS.initMs})  ` +
    `${results.init.pass ? 'PASS' : 'FAIL'}`,
);
for (const key of ['ja', 'zhAsShipped', 'zhWithDictionary', 'en']) {
  const r = results.languages[key];
  const flag = r.meaningful ? '' : '  [passthrough, not G2P]';
  console.log(
    `${key.padEnd(22)} ${String(r.stats.trimmedMeanMs).padStart(8)} ms  ` +
      `(median ${r.stats.medianMs} ms, target < ${r.targetMs})  ` +
      `${r.pass ? 'PASS' : 'FAIL'}${flag}`,
  );
}
console.log(
  `\nheap used              ${results.memory.heapUsedMb} MB   ` +
    `(target < ${TARGETS.memoryMb})  ${results.memory.pass ? 'PASS' : 'FAIL'}`,
);
console.log(`\nverdict: ${passed}/${total} checks passed (${results.verdict.passRate})`);
console.log(`wrote ${resolve(OUT_DIR, 'performance-results.json')}\n`);
