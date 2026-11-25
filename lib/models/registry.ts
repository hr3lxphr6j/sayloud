/**
 * The on-device model registry: the one place that describes
 * which models exist and what they cost.
 *
 * It deliberately has **no runtime dependencies**. The side panel and the
 * offscreen worker both import it, and the side panel must never pull
 * `onnxruntime-web` (or anything that pulls it) into its bundle — the model tab
 * only downloads files, it never runs them.
 *
 * The file sizes are measured constants rather than `Content-Length` probes:
 * the UI has to show "325 MB" *before* the download starts. The numbers come
 * from the ModelScope file-listing API and
 * are quoted in MB, so they are the decimal values the repository reports.
 */
import type { MessageKey } from '../i18n/messages.en';
import type { VocabId } from './vocab';

/** Which engine family implements a model. One family is one adapter. */
export type OnDeviceFamily = 'kokoro' | 'kitten' | 'piper' | 'vits';

/**
 * How a model's files are grouped, which is also how the UI presents it.
 *
 * - `model+voices`: one download, many voices (Kokoro, Kitten, SpeechT5).
 * - `per-voice`: one file per voice or language (Piper, MMS-TTS).
 * - `multi-component`: several models that must run together.
 */
export type ModelShape = 'model+voices' | 'per-voice' | 'multi-component';

/**
 * The grouping unit of a `model+voices` model; a tier is one set of files.
 *
 * Kokoro has exactly one — the full-precision weights. The quantised (`q8`) and
 * half-precision (`fp16`) variants were removed on 2026-11-16: measured on
 * Apple Silicon and on NVIDIA they produced unusable audio, so there was
 * nothing left for a smaller tier to be *for*.
 */
export interface ModelTier {
  /** Family-scoped id: `'fp32'` for Kokoro. */
  readonly id: string;
  /** i18n label, e.g. "FP32". */
  readonly labelKey: MessageKey;
  /**
   * The value handed to the engine (for Kokoro, the transformers.js `dtype`).
   *
   * Kept separate from `id` because the two are only accidentally equal: an
   * engine's dtype vocabulary is not the registry's, and a future tier may
   * differ.
   */
  readonly engineArg: string;
  /** Paths relative to the model root. Always includes the tier's own ONNX. */
  readonly files: readonly string[];
  /** Measured size of the tier's own files. */
  readonly bytes: number;
}

/** One model the extension can run locally. */
export interface OnDeviceModel {
  /** Stable id, e.g. `'kokoro-82m'`; what `LocalConfig.modelId` holds. */
  readonly id: string;
  readonly family: OnDeviceFamily;
  readonly shape: ModelShape;
  readonly labelKey: MessageKey;
  /** Repository id, the same string on Hugging Face and ModelScope. */
  readonly repo: string;
  /** Required: a model whose licence is unknown does not belong in the list. */
  readonly license: { readonly name: string; readonly url: string };
  /** BCP-47 tags this model can actually speak. */
  readonly languages: readonly string[];
  /**
   * The phoneme inventory its voices need.
   *
   * A property of the model rather than of the text or the voice: v1.0 and
   * v1.1-zh are two models with two inventories, and the same Chinese sentence
   * phonemizes to different characters for each. The language says which
   * pipeline runs; this says which characters come out of it.
   */
  readonly vocab: VocabId;
  /** Voices offered, counting only the ones this extension can synthesize. */
  readonly voiceCount: number;
  /**
   * Repositories this one replaced, oldest sense of the word.
   *
   * The old weights are unreachable once the repository changes — every key
   * this store builds names the current one — so the UI can tell a user with
   * them still installed what happened and what to do. Files under a
   * superseded repository are what [`unknown-model prune`] clears; see the
   * store's `pruneUnknownModels`.
   */
  readonly supersedes?: readonly string[];
  /** `model+voices` groups its files into tiers; other shapes use `files`. */
  readonly tiers?: readonly ModelTier[];
  readonly files?: readonly string[];
  /** Voice file path template, for `model+voices` models. */
  readonly voiceFile?: (voiceId: string) => string;
}

/**
 * The files every tier of a model shares.
 *
 * Structural, so it lives with the tier definitions rather than with the
 * sizes; the downloader needs it to tell a tier's own file from a shared one,
 * and the store needs it to decide what may be deleted.
 */
export const SHARED_MODEL_FILES: readonly string[] = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
];

/**
 * The measured size of each shared file.
 *
 * Tiny next to the weights, but the tier's `bytes` is the ONNX alone, so the
 * download's progress total has to add these back or the bar would never reach
 * 100%. Measured from the ModelScope file listing.
 */
export const SHARED_FILE_BYTES: Readonly<Record<string, number>> = {
  'config.json': 44,
  'tokenizer.json': 3_497,
  'tokenizer_config.json': 113,
};

/**
 * Kokoro 82M, the only model the extension ships.
 *
 * `languages` lists what can actually be synthesized: the 28 English voices go
 * through `kokoro-js`'s own path, the 8 Chinese ones through the built
 * phonemizer. The repository's other 18 voices need a G2P per language, so
 * they are not counted and not listed.
 */
export const KOKORO_82M: OnDeviceModel = {
  id: 'kokoro-82m',
  family: 'kokoro',
  shape: 'model+voices',
  labelKey: 'model.kokoro-82m',
  // The `-timestamped` fork of the same weights: one added `durations` output
  // (per token, how many frames the model spoke it for) and a byte-identical
  // waveform — verified sample for sample against the plain repository on three
  // sentences, `maxdiff = 0`. The word timings come from the added output, and
  // the audio from the same weights the voices were graded against.
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX-timestamped',
  supersedes: ['onnx-community/Kokoro-82M-v1.0-ONNX'],
  license: {
    name: 'Apache-2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
  languages: ['en-US', 'en-GB', 'zh-CN', 'ja'],
  vocab: 'kokoro-v1',
  voiceCount: 41,
  tiers: [
    {
      // The only tier. `q8` and `fp16` were removed rather than re-ranked:
      // measured on both Apple Silicon and NVIDIA, neither produced usable
      // audio on any backend, so a smaller download was not a trade the user
      // could make. `fp32` runs on WebGPU and on the CPU, and is the one set of
      // weights this model ships.
      id: 'fp32',
      labelKey: 'model.tier.fp32',
      engineArg: 'fp32',
      bytes: 325_532_000,
      files: [...SHARED_MODEL_FILES, 'onnx/model.onnx'],
    },
  ],
  voiceFile: (voiceId: string) => `voices/${voiceId}.bin`,
};

/** Every on-device model this build knows about. */
export const MODELS: readonly OnDeviceModel[] = [KOKORO_82M];

/** The model with this id, or undefined. */
export function modelById(id: string): OnDeviceModel | undefined {
  return MODELS.find((model) => model.id === id);
}

/** The tier with this id, or undefined when the model has no such tier. */
export function tierById(model: OnDeviceModel, id: string): ModelTier | undefined {
  return model.tiers?.find((tier) => tier.id === id);
}
