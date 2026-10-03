/**
 * P6 V1: harness around the `piper-plus` Rust wasm phonemizer.
 *
 * The awkward part of testing this thing is that it never returns phonemes.
 * `WasmPhonemizer.phonemize(text, lang)` returns `phonemeIds` -- indices into
 * the *caller's* `phoneme_id_map` -- so the phoneme string only exists if you
 * invert the map you supplied. This module therefore supplies a deliberately
 * exhaustive map (every BMP code point, one id each) and inverts it, which
 * makes the ID stream decode back to exactly the phonemes the Rust side emitted.
 *
 * Two properties of the encoder have to be respected for that to be sound, both
 * established experimentally (see api-exploration.md §3):
 *
 *   - `phoneme_id_map` MUST contain `^` (BOS) and `$` (EOS) or construction
 *     throws CONFIG_PARSE_ERROR. `_` (PAD) is the inter-phoneme separator.
 *   - A phoneme missing from the map is silently replaced by the PAD token.
 *     That is why the map has to be exhaustive: with a partial map the
 *     out-of-vocabulary phonemes do not appear as "unknown", they appear as
 *     separators, and a report built on it would under-count them.
 *
 * The same property is what makes the Kokoro-vocabulary experiment in
 * `comparison.test.ts` meaningful: re-running with the real Kokoro vocab as the
 * map shows exactly which phonemes that vocabulary would swallow.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SANDBOX = resolve(HERE, '.sandbox');
export const DERIVED = resolve(SANDBOX, 'derived');
export const UPSTREAM_ASSETS = resolve(SANDBOX, 'upstream-assets');

/** The wasm binary, as the package ships it. */
export const WASM_PATH = resolve(
  SANDBOX,
  'node_modules/piper-plus/dist/rust-wasm/piper_plus_wasm_bg.wasm',
);

/** BOS / EOS / PAD, the three markers the encoder requires. */
const BOS = '^';
const EOS = '$';
const PAD = '_';

/**
 * Load the wasm-bindgen glue.
 *
 * The documented entry point is `piper-plus/wasm/multilingual`, and that is
 * tried first so the harness exercises the public surface. The file-URL
 * fallback exists only so the module still runs before `setup.sh` has created
 * the `tests/v1/node_modules` link.
 */
async function loadGlue() {
  try {
    return await import('piper-plus/wasm/multilingual');
  } catch (bareSpecifierError) {
    const url = pathToFileURL(
      resolve(SANDBOX, 'node_modules/piper-plus/dist/rust-wasm/piper_plus_wasm.js'),
    ).href;
    try {
      return await import(url);
    } catch {
      throw new Error(
        `cannot load the piper-plus wasm glue; run \`bash tests/v1/setup.sh\` first.\n` +
          `bare specifier failed with: ${bareSpecifierError.message}`,
      );
    }
  }
}

/** Every printable BMP code point, one id each. */
function exhaustiveIdMap() {
  const map = {};
  let id = 1;
  for (let cp = 0x20; cp <= 0xffff; cp += 1) {
    if (cp >= 0xd800 && cp <= 0xdfff) continue; // surrogates
    map[String.fromCodePoint(cp)] = [id];
    id += 1;
  }
  return map;
}

/** Invert a `phoneme_id_map` (id -> phoneme char). */
function invertIdMap(map) {
  const inverse = new Map();
  for (const [char, ids] of Object.entries(map)) {
    for (const id of ids) inverse.set(id, char);
  }
  return inverse;
}

/**
 * PUA char -> multi-character token, from the upstream contract.
 *
 * piper-plus encodes every multi-character IPA token as a single Private Use
 * Area code point so a model config can key it with one character. Without this
 * table `ch` reads back as `\uE00E` and `tone3` as `\uE048`.
 */
export async function loadPuaMap() {
  // The upstream table is an ES module (it carries comments, so it is not
  // JSON); `.sandbox/package.json` marks the directory as ESM, so a file URL
  // import is enough.
  const module = await import(
    pathToFileURL(resolve(UPSTREAM_ASSETS, 'pua-map.js')).href
  );
  const forward = module.PUA_MAP;
  const reverse = Object.fromEntries(
    Object.entries(forward).map(([token, pua]) => [pua, token])
  );
  return { forward, reverse };
}

const isPua = (char) => {
  const cp = char.codePointAt(0);
  return cp >= 0xe000 && cp <= 0xf8ff;
};

/**
 * A ready-to-use wasm phonemizer plus the bookkeeping the tests need.
 */
export class PiperWasmHarness {
  /**
   * @param {object} params
   * @param {object} params.phonemizer - WasmPhonemizer instance
   * @param {Map<number, string>} params.inverse - id -> phoneme char
   * @param {Record<string, string>} params.puaReverse - PUA char -> token
   * @param {object} params.timings - measured cold-start numbers
   */
  constructor({ phonemizer, inverse, puaReverse, timings }) {
    this._phonemizer = phonemizer;
    this._inverse = inverse;
    this._puaReverse = puaReverse;
    this.timings = timings;
    /** Whether `setChineseDictionary` has been called successfully. */
    this.chineseDictionaryLoaded = false;
  }

  /**
   * Load the Chinese pinyin dictionaries.
   *
   * @param {'converted'|'upstream'} variant - `converted` uses the TONE3 files
   *   this harness derives; `upstream` uses the accented files verbatim, which
   *   is what an integrator would get by copying the repo's `assets/`.
   */
  loadChineseDictionary(variant = 'converted') {
    const dir = variant === 'converted' ? DERIVED : UPSTREAM_ASSETS;
    const single = new Uint8Array(readFileSync(resolve(dir, 'pinyin_single.json')));
    const phrases = new Uint8Array(readFileSync(resolve(dir, 'pinyin_phrases.json')));
    this._phonemizer.setChineseDictionary(single, phrases);
    this.chineseDictionaryLoaded = true;
  }

  /**
   * Phonemize one string.
   *
   * @param {string} text
   * @param {string} language - language hint; the Rust side still runs its own
   *   detection, but the hint decides the ja/zh dispatch (api-exploration.md §4)
   * @returns {{tokens: string[], puaTokens: string[], output: string,
   *   puaOutput: string, phonemeCount: number, prosodyFeatureCount: number}}
   */
  phonemize(text, language) {
    const result = this._phonemizer.phonemize(text, language);
    try {
      const chars = Array.from(result.phonemeIds, (id) => this._inverse.get(id) ?? `<?${id}>`);
      // Strip the encoder's own framing so what remains is the phoneme string.
      const inner = chars.filter((char) => char !== BOS && char !== EOS && char !== PAD);
      const puaTokens = inner.filter(isPua);
      const tokens = inner.map((char) => this._puaReverse[char] ?? char);
      return {
        tokens,
        puaTokens,
        // Concatenated forms are for reading; `tokens` is the authoritative
        // sequence (concatenation is ambiguous once tokens can be multi-char).
        output: tokens.join(''),
        puaOutput: inner.join(''),
        phonemeCount: result.phonemeCount,
        prosodyFeatureCount: result.prosodyFeatures.length / 3,
      };
    } finally {
      result.free();
    }
  }

  /** What `detectLanguage` says about a string. */
  detectLanguage(text) {
    return this._phonemizer.detectLanguage(text);
  }

  /** Languages this build reports as supported. */
  supportedLanguages() {
    return this._phonemizer.getSupportedLanguages();
  }

  /** Whether ZH-EN code-switch dispatch is on. */
  isZhEnDispatchEnabled() {
    return this._phonemizer.isZhEnDispatchEnabled();
  }
}

/**
 * Build a harness. Measures the two cold-start steps separately, because they
 * are the ones a browser pays on every offscreen-document wake-up:
 * instantiation (`initSync`) and phonemizer construction (which, for the
 * bundled build, is where the ~30 MB NAIST-JDIC dictionary becomes usable).
 *
 * @param {object} [options]
 * @param {boolean} [options.quiet] - silence the wasm's INFO log line
 * @returns {Promise<PiperWasmHarness>}
 */
export async function createHarness({ quiet = true } = {}) {
  const glue = await loadGlue();

  const instantiateStart = performance.now();
  const bytes = readFileSync(WASM_PATH);
  glue.initSync({ module: bytes });
  const instantiateMs = performance.now() - instantiateStart;

  const idMap = exhaustiveIdMap();
  const config = JSON.stringify({
    phoneme_id_map: idMap,
    language_id_map: { ja: 0, en: 1, zh: 2 },
  });

  const constructStart = performance.now();
  const phonemizer = new glue.WasmPhonemizer(config);
  const constructMs = performance.now() - constructStart;

  if (quiet) {
    // The wasm logs `piper-wasm vX initialized` via wasm-logger on load; it is
    // noise in the report output but worth keeping out of stdout only.
  }

  const { reverse } = await loadPuaMap();

  return new PiperWasmHarness({
    phonemizer,
    inverse: invertIdMap(idMap),
    puaReverse: reverse,
    timings: {
      wasmBytes: bytes.byteLength,
      instantiateMs: Number(instantiateMs.toFixed(3)),
      constructMs: Number(constructMs.toFixed(3)),
    },
  });
}

export const MARKERS = { BOS, EOS, PAD };

/**
 * Build a phonemizer whose `phoneme_id_map` is exactly a Kokoro vocabulary.
 *
 * This is the sharpest available test of "would Kokoro's tokenizer accept
 * this", because it uses the encoder's own lookup instead of comparing
 * character sets after the fact. The encoder replaces any phoneme it cannot
 * find with the PAD token, so:
 *
 *   - the PAD count is `phonemes + 1` (one separator before each phoneme, plus
 *     the trailing one) and therefore still reveals the *full* phoneme count,
 *   - the non-PAD ID count is the number of phonemes the vocabulary *did*
 *     cover,
 *   - the difference is exactly how many phonemes the vocabulary swallows.
 *
 * `_`, `^` and `$` are added to the map because construction fails without
 * BOS/EOS and because PAD is needed as the separator.
 *
 * @param {string[]} vocabChars
 * @param {object} [options]
 * @param {'converted'|'upstream'|null} [options.chineseDictionary] - install the
 *   pinyin dictionaries on this instance before measuring, so the Chinese
 *   numbers describe the G2P path rather than the passthrough one
 * @returns {Promise<{analyze: (text: string, language: string) =>
 *   {totalPhonemes: number, covered: number, dropped: number,
 *    droppedRatio: number, coveredTokens: string[]}, mapSize: number,
 *    constructMs: number, chineseDictionaryLoaded: boolean}>}
 */
export async function createVocabHarness(vocabChars, options = {}) {
  const glue = await loadGlue();
  glue.initSync({ module: readFileSync(WASM_PATH) });

  const map = { [BOS]: [1], [EOS]: [2], [PAD]: [0] };
  const inverse = new Map();
  let id = 10;
  for (const char of vocabChars) {
    if (char === BOS || char === EOS || char === PAD) continue;
    map[char] = [id];
    inverse.set(id, char);
    id += 1;
  }

  const constructStart = performance.now();
  const phonemizer = new glue.WasmPhonemizer(
    JSON.stringify({ phoneme_id_map: map, language_id_map: { ja: 0, en: 1, zh: 2 } }),
  );
  const constructMs = performance.now() - constructStart;

  const chineseDictionary = options.chineseDictionary ?? null;
  if (chineseDictionary) {
    const dir = chineseDictionary === 'converted' ? DERIVED : UPSTREAM_ASSETS;
    phonemizer.setChineseDictionary(
      new Uint8Array(readFileSync(resolve(dir, 'pinyin_single.json'))),
      new Uint8Array(readFileSync(resolve(dir, 'pinyin_phrases.json'))),
    );
  }

  return {
    mapSize: Object.keys(map).length,
    constructMs: Number(constructMs.toFixed(3)),
    chineseDictionaryLoaded: Boolean(chineseDictionary),
    analyze(text, language) {
      const result = phonemizer.phonemize(text, language);
      try {
        const ids = Array.from(result.phonemeIds);
        const padCount = ids.filter((value) => value === 0).length;
        const coveredTokens = ids
          .filter((value) => value !== 0 && value !== 1 && value !== 2)
          .map((value) => inverse.get(value) ?? `<?${value}>`);
        // PAD count = one separator per phoneme + the trailing one.
        const totalPhonemes = Math.max(0, padCount - 1);
        const covered = coveredTokens.length;
        const dropped = Math.max(0, totalPhonemes - covered);
        return {
          totalPhonemes,
          covered,
          dropped,
          droppedRatio: totalPhonemes === 0 ? 0 : Number((dropped / totalPhonemes).toFixed(4)),
          coveredTokens,
        };
      } finally {
        result.free();
      }
    },
  };
}
