/**
 * The on-device model registry (P4 spec §3.1): the one place that describes
 * which models exist, what they cost, and which tier a machine should use.
 *
 * It deliberately has **no runtime dependencies**. The side panel and the
 * offscreen worker both import it, and the side panel must never pull
 * `onnxruntime-web` (or anything that pulls it) into its bundle — the model tab
 * only downloads files, it never runs them.
 *
 * The tier sizes are measured constants rather than `Content-Length` probes:
 * the UI has to show "163 MB" *before* the download starts. The numbers come
 * from the ModelScope file-listing API (risk-verification doc §1.2/§1.3) and
 * are quoted in MB, so they are the decimal values the repository reports.
 */
import type { MessageKey } from '../i18n/messages.en';

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

/** The grouping unit of a `model+voices` model; a tier is one set of files. */
export interface ModelTier {
  /** Family-scoped id: `'q8' | 'fp16' | 'fp32'` for Kokoro. */
  readonly id: string;
  /** i18n label, e.g. "Light". */
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
  /**
   * Where this tier is the *preferred* one (spec §3.7.2).
   *
   * Absent means "never selected automatically, manual choice only".
   */
  readonly preferredFor?: readonly DeviceClass[];
}

/**
 * How much GPU a machine has, in the three classes the measurements found.
 *
 * The split is an empirical result, not a guess (spec §3.7.1): `q8` gains
 * nothing from WebGPU (its dequantisation nodes fall back to the CPU), so the
 * tier worth having depends on `shader-f16` rather than on "GPU or not".
 */
export type DeviceClass = 'webgpu-f16' | 'webgpu' | 'wasm';

/** What the caller measured about the device, before picking a tier. */
export interface DeviceCaps {
  readonly webgpu: boolean;
  readonly shaderF16: boolean;
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
  /** Voices offered, counting only the ones this extension can synthesize. */
  readonly voiceCount: number;
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
 * 100%. Measured from the ModelScope file listing (verification doc §1.3).
 */
export const SHARED_FILE_BYTES: Readonly<Record<string, number>> = {
  'config.json': 44,
  'tokenizer.json': 3_497,
  'tokenizer_config.json': 113,
};

/**
 * Kokoro 82M, the only model P4 ships.
 *
 * `languages` lists what can actually be synthesized: the 28 English voices go
 * through `kokoro-js`'s own path, the 8 Chinese ones through the built
 * phonemizer. The repository's other 18 voices need a G2P per language, so
 * they are not counted and not listed (spec §1.1.1).
 */
export const KOKORO_82M: OnDeviceModel = {
  id: 'kokoro-82m',
  family: 'kokoro',
  shape: 'model+voices',
  labelKey: 'model.kokoro-82m',
  repo: 'onnx-community/Kokoro-82M-v1.0-ONNX',
  license: {
    name: 'Apache-2.0',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
  },
  languages: ['en-US', 'en-GB', 'zh-CN'],
  voiceCount: 36,
  tiers: [
    {
      // Smallest, and the only sensible choice without WebGPU: the GPU cannot
      // be used anyway, so q8's weakness on it costs nothing.
      id: 'q8',
      labelKey: 'model.tier.light',
      engineArg: 'q8',
      bytes: 92_360_000,
      preferredFor: ['wasm'],
      files: [...SHARED_MODEL_FILES, 'onnx/model_quantized.onnx'],
    },
    {
      // Best on a WebGPU device with `shader-f16`: measured RTF ≈ 0.15, at half
      // of fp32's size.
      id: 'fp16',
      labelKey: 'model.tier.standard',
      engineArg: 'fp16',
      bytes: 163_230_000,
      preferredFor: ['webgpu-f16'],
      files: [...SHARED_MODEL_FILES, 'onnx/model_fp16.onnx'],
    },
    {
      // WebGPU without `shader-f16`, and the most compatible.
      id: 'fp32',
      labelKey: 'model.tier.hifi',
      engineArg: 'fp32',
      bytes: 325_530_000,
      preferredFor: ['webgpu'],
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

/** The class a machine belongs to, from what the caller measured. */
export function deviceClass(caps: DeviceCaps): DeviceClass {
  if (!caps.webgpu) return 'wasm';
  return caps.shaderF16 ? 'webgpu-f16' : 'webgpu';
}

/**
 * The tier this machine should use, from its capabilities alone.
 *
 * A pure function on purpose: "which tier is recommended" and "which tier is
 * downloaded" are different questions, and only the store can answer the
 * second. The model tab combines the two into a "recommended" badge next to a
 * "download" button.
 *
 * Falls back to the first tier so a caller always gets something to show, and
 * returns undefined only for a model with no tiers at all.
 */
export function preferredTier(model: OnDeviceModel, caps: DeviceCaps): ModelTier | undefined {
  const tiers = model.tiers;
  if (!tiers || tiers.length === 0) return undefined;

  const wanted = deviceClass(caps);
  return tiers.find((tier) => tier.preferredFor?.includes(wanted)) ?? tiers[0];
}
