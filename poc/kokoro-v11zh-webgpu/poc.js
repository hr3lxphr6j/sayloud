/**
 * Kokoro v1.1-zh browser POC — does WebGPU work, and is it correct? (throwaway)
 *
 * Runs every fixture through fp32/fp16 on the WebGPU and WASM execution
 * providers, and scores each result against a Python CPU fp32 reference.
 *
 * The scoring metric is the whole point of this file. Bit-exact comparison is
 * useless here, for a reason worth writing down:
 *
 *   - The graph contains RandomNormalLike / RandomUniformLike nodes, and ONNX
 *     Runtime is not run-to-run reproducible: run #2 of a session differs from
 *     run #1 (maxAbs ~0.12 on a peak of 0.49), while the *first* run of any new
 *     session is bit-identical to the first run of the previous one.
 *   - So a waveform comparison must be robust to that: Pearson correlation of
 *     the raw samples, plus correlation of the short-time energy envelope and a
 *     brightness proxy, which survive noise/phase differences if the phonemes
 *     and timing are the same.
 *
 * fp16 is included because P4 found Kokoro v1.0's fp16 weights produce silently
 * wrong audio on WebGPU while being the fastest configuration. "It ran and made
 * sound" is not evidence; every combination has to be scored.
 *
 * Inputs come from fixtures.json, which `make-fixtures.py` produced through the
 * real misaki `ZHG2P(version='1.1')` — so the token ids are exactly what the
 * model was trained to see.
 */
import * as ort from '/ort/ort.webgpu.min.mjs';

// No cross-origin isolation here (matching the extension), so no SharedArrayBuffer.
ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = '/ort/';
ort.env.logLevel = 'error';

const RATE = 24000;
const log = document.getElementById('log');
const lines = [];
function say(text, cls = '') {
  lines.push(cls ? `<span class="${cls}">${text}</span>` : text);
  log.innerHTML = lines.join('\n');
  console.log(text);
}

async function fetchF32(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return new Float32Array(await res.arrayBuffer());
}

function toWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buf);
  const ascii = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return new Uint8Array(buf);
}

const mean = (x) => x.reduce((s, v) => s + v, 0) / x.length;

function corr(a, b) {
  const n = Math.min(a.length, b.length);
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = a[i] - ma;
    const y = b[i] - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return num / (Math.sqrt(da) * Math.sqrt(db) || 1);
}

/**
 * Short-time energy and a brightness proxy, on a fixed frame grid.
 *
 * Both survive run-to-run noise: the same utterance has the same loudness and
 * brightness contours even when the samples differ. The brightness proxy is the
 * ratio of first-difference energy to signal energy, which rises with frequency
 * and costs one extra pass instead of a per-frame FFT.
 */
function envelope(x, frame = 1024, hop = 256) {
  const frames = Math.max(0, Math.floor((x.length - frame) / hop));
  const energy = new Float32Array(frames);
  const bright = new Float32Array(frames);
  const window = new Float32Array(frame);
  for (let i = 0; i < frame; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame);

  for (let f = 0; f < frames; f += 1) {
    const off = f * hop;
    let sum = 0;
    let diff = 0;
    let base = 0;
    for (let i = 0; i < frame; i += 1) {
      const a = x[off + i] * window[i];
      sum += a * a;
      if (i > 0) {
        const b = x[off + i - 1] * window[i - 1];
        diff += (a - b) * (a - b);
      }
      base += a * a;
    }
    energy[f] = Math.sqrt(sum / frame);
    bright[f] = Math.sqrt(diff / (base || 1e-12));
  }
  return { energy, bright };
}

function compare(a, b) {
  // A length mismatch is itself a finding, not a reason to skip scoring: fp16
  // was observed to return a different sample count for the same input. Score
  // the overlapping prefix and report the mismatch alongside it.
  const lengthMismatch = a.length === b.length ? null : `${a.length} vs ${b.length}`;
  const n = Math.min(a.length, b.length);
  const head = a.subarray(0, n);
  const tail = b.subarray(0, n);

  let maxAbs = 0;
  let nan = 0;
  for (let i = 0; i < n; i += 1) {
    if (Number.isNaN(a[i])) nan += 1;
    else maxAbs = Math.max(maxAbs, Math.abs(a[i] - b[i]));
  }
  const ea = envelope(head);
  const eb = envelope(tail);
  return {
    lengthMismatch,
    maxAbs,
    nan,
    corr: corr(head, tail),
    envelopeCorr: corr(ea.energy, eb.energy),
    brightCorr: corr(ea.bright, eb.bright),
  };
}

/** `NaN` is a result here, not a crash — format it rather than throwing. */
const fmt = (x, digits = 4) =>
  typeof x === 'number' && Number.isFinite(x) ? x.toFixed(digits) : String(x);

const stats = (x) => {
  let sum = 0;
  let peak = 0;
  let nonFinite = 0;
  for (const v of x) {
    if (!Number.isFinite(v)) nonFinite += 1;
    else {
      sum += v * v;
      peak = Math.max(peak, Math.abs(v));
    }
  }
  const finite = x.length - nonFinite;
  return {
    duration: +(x.length / RATE).toFixed(3),
    rms: +(finite ? Math.sqrt(sum / finite) : 0).toFixed(5),
    peak: +peak.toFixed(4),
    nonFinite,
  };
};

async function main() {
  const adapter = await navigator.gpu.requestAdapter();
  say(
    `webgpu adapter: ${adapter ? `${adapter.info?.vendor}/${adapter.info?.architecture} f16=${adapter.features.has('shader-f16')}` : 'none'}`
  );

  const fixtures = await (await fetch('/models/fixtures.json')).json();
  const voice = await fetchF32('/models/voices/zf_001.bin');
  say(`fixtures: ${fixtures.map((f) => `${f.name}(${f.refSeconds}s)`).join('  ')}`);
  say('');

  const MODELS = [
    { dtype: 'fp32', url: '/models/model.onnx' },
    { dtype: 'fp16', url: '/models/model_fp16.onnx' },
  ];
  const EPS = ['webgpu', 'wasm'];
  const combos = [];

  for (const { dtype, url } of MODELS) {
    const tFetch = performance.now();
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const fetchMs = Math.round(performance.now() - tFetch);

    for (const ep of EPS) {
      const combo = {
        label: `${ep}/${dtype}`,
        ep,
        dtype,
        fetchMs,
        bytesMB: +(bytes.byteLength / 1024 / 1024).toFixed(1),
        runs: [],
      };
      say(`${combo.label}  (${combo.bytesMB} MB fetched in ${fetchMs} ms)`);

      let session;
      try {
        const t0 = performance.now();
        session = await ort.InferenceSession.create(bytes, {
          executionProviders: [ep],
          graphOptimizationLevel: 'all',
          // The fp16 graph has ~1300 nodes ORT cannot constant-fold; without this
          // the C++ layer floods stderr and buries the actual results.
          logSeverityLevel: 3,
        });
        combo.sessionMs = Math.round(performance.now() - t0);
      } catch (error) {
        combo.fatal = String(error).slice(0, 300);
        say(`  session failed: ${combo.fatal}`, 'bad');
        combos.push(combo);
        continue;
      }

      for (const [index, fixture] of fixtures.entries()) {
        const record = { name: fixture.name, refSeconds: fixture.refSeconds };
        try {
          const style = voice.slice(fixture.styleRow * 256, fixture.styleRow * 256 + 256);
          const feeds = {
            input_ids: new ort.Tensor('int64', BigInt64Array.from(fixture.ids.map(BigInt)), [
              1,
              fixture.ids.length,
            ]),
            style: new ort.Tensor('float32', style, [1, 256]),
            speed: new ort.Tensor('float32', Float32Array.from([1.0]), [1]),
          };

          const tCold = performance.now();
          const first = await session.run(feeds);
          record.coldMs = Math.round(performance.now() - tCold);

          const tWarm = performance.now();
          const second = await session.run(feeds);
          record.warmMs = Math.round(performance.now() - tWarm);

          const wave = first.waveform.data;
          const ref = await fetchF32(`/models/ref-${fixture.name}.f32`);
          record.samples = wave.length;
          record.stats = stats(wave);
          record.diff = compare(wave, ref);
          record.rtf = +(record.warmMs / 1000 / (wave.length / RATE)).toFixed(3);
          record.durationOutput = Number(second.duration?.data?.[0] ?? -1);
          if (index === 0) {
            record.runToRunMaxAbs = compare(wave, second.waveform.data).maxAbs;
          }

          await fetch(`/save?name=${ep}_${dtype}_${fixture.name}.wav`, {
            method: 'POST',
            body: toWav(wave, RATE),
          });
        } catch (error) {
          record.error = String(error).slice(0, 300);
        }
        combo.runs.push(record);

        if (record.error) {
          say(`  ${record.name.padEnd(7)} FAIL ${record.error}`, 'bad');
          continue;
        }
        const broken = record.diff.nan > 0 || record.diff.lengthMismatch !== null;
        const same = record.diff.envelopeCorr > 0.98 && record.diff.corr > 0.9;
        const verdict = broken ? 'BROKEN' : same ? 'same as ref' : 'DIFFERS from ref';
        say(
          `  ${record.name.padEnd(7)} ${verdict.padEnd(15)} warm ${String(record.warmMs).padStart(5)}ms  rtf ${String(record.rtf).padStart(5)}  ` +
            `corr ${fmt(record.diff.corr)}  envelope ${fmt(record.diff.envelopeCorr)}  ` +
            `nonFinite ${record.stats.nonFinite}/${record.samples}` +
            (record.diff.lengthMismatch ? `  LENGTH ${record.diff.lengthMismatch}` : ''),
          broken || !same ? 'bad' : 'ok'
        );
      }
      await session.release();
      combos.push(combo);
    }
  }

  say('');
  say('--- summary ---');
  const head = [
    'combo',
    'session',
    'fetch',
    'fixture',
    'cold',
    'warm',
    'rtf',
    'corr',
    'envelope',
    'verdict',
  ];
  say(head.map((h, i) => (i <= 2 ? h.padEnd(13) : h.padStart(11))).join(''));
  for (const combo of combos) {
    if (combo.fatal) {
      say(
        `${combo.label.padEnd(13)}${String(combo.sessionMs ?? '-').padStart(11)}${String(combo.fetchMs).padStart(11)}${'FAIL'.padStart(11)}`
      );
      continue;
    }
    for (const r of combo.runs) {
      const broken = r.error || r.diff?.nan > 0 || r.diff?.lengthMismatch !== null;
      const same = r.diff && r.diff.envelopeCorr > 0.98 && r.diff.corr > 0.9;
      const verdict = r.error ? 'FAIL' : broken ? 'BROKEN' : same ? 'same' : 'DIFFERS';
      say(
        `${combo.label.padEnd(13)}${String(combo.sessionMs).padStart(11)}${String(combo.fetchMs).padStart(11)}` +
          `${r.name.padStart(11)}${String(r.coldMs).padStart(11)}${String(r.warmMs).padStart(11)}${String(r.rtf).padStart(11)}` +
          `${fmt(r.diff?.corr).padStart(11)}${fmt(r.diff?.envelopeCorr).padStart(11)}${verdict.padStart(11)}`
      );
    }
  }

  window.__result = { adapter: adapter?.info, combos };
  window.__done = true;
}

main().catch((error) => {
  say('FATAL ' + String(error), 'bad');
  window.__result = { fatal: String(error) };
  window.__done = true;
});
