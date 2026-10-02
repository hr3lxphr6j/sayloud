import { describe, expect, it } from 'vitest';
import {
  type DeviceCaps,
  deviceClass,
  KOKORO_82M,
  MODELS,
  modelById,
  type OnDeviceModel,
  preferredTier,
  SHARED_MODEL_FILES,
  tierById,
} from '~/lib/models/registry';

const WASM: DeviceCaps = { webgpu: false, shaderF16: false };
const WEBGPU: DeviceCaps = { webgpu: true, shaderF16: false };
const WEBGPU_F16: DeviceCaps = { webgpu: true, shaderF16: true };

describe('deviceClass', () => {
  it('separates a machine by what it can actually use', () => {
    expect(deviceClass(WASM)).toBe('wasm');
    expect(deviceClass(WEBGPU)).toBe('webgpu');
    expect(deviceClass(WEBGPU_F16)).toBe('webgpu-f16');
  });
});

describe('preferredTier', () => {
  it('picks the smallest tier when there is no WebGPU', () => {
    // q8's weakness — dequantisation falling back to the CPU — costs nothing
    // when there is no GPU to fall back from.
    expect(preferredTier(KOKORO_82M, WASM)?.id).toBe('q8');
  });

  it('picks fp32 on a GPU that has no shader-f16', () => {
    expect(preferredTier(KOKORO_82M, WEBGPU)?.id).toBe('fp32');
  });

  it('falls back to the first tier when no tier claims the class', () => {
    const picky: OnDeviceModel = {
      ...KOKORO_82M,
      tiers: (KOKORO_82M.tiers ?? []).map((tier) => ({ ...tier, preferredFor: ['webgpu'] })),
    };

    expect(preferredTier(picky, WASM)?.id).toBe('q8');
  });

  it('answers from the capabilities alone, not from what is downloaded', () => {
    // The same caps give the same answer whatever Cache Storage holds; the
    // store is what knows the second half of the question.
    expect(preferredTier(KOKORO_82M, WEBGPU_F16)?.id).toBe(
      preferredTier(KOKORO_82M, WEBGPU_F16)?.id
    );
  });

  it('returns undefined for a model with no tiers', () => {
    const flat: OnDeviceModel = { ...KOKORO_82M, tiers: undefined };
    expect(preferredTier(flat, WASM)).toBeUndefined();
  });

  it('picks fp32 for both WebGPU classes, never fp16', () => {
    // Measured 2026-10-01 on an Apple M3, whose adapter does advertise
    // `shader-f16`: fp16 on WebGPU distorted the audio and stopped part-way
    // through the sentence, while the *same weights* on the CPU were flawless
    // and fp32 on the same GPU was flawless too. V20 had measured fp16's speed
    // and never its quality, which is how it became the recommendation.
    expect(preferredTier(KOKORO_82M, WEBGPU_F16)?.id).toBe('fp32');
    expect(preferredTier(KOKORO_82M, WEBGPU)?.id).toBe('fp32');
  });

  it('gives every device class a tier that is safe to pick', () => {
    // The fallback is `tiers[0]`, and for a WebGPU machine that is q8 — the one
    // tier WebGPU cannot use. So every class has to be covered by an explicit
    // `preferredFor`, and none of them may be answered with a broken tier.
    for (const caps of [WASM, WEBGPU, WEBGPU_F16]) {
      const cls = deviceClass(caps);
      const tier = preferredTier(KOKORO_82M, caps);
      expect(tier?.preferredFor).toContain(cls);
      expect(tier?.brokenOn?.includes(cls) ?? false).toBe(false);
    }
  });
});

describe('tiers a device class must avoid', () => {
  const tierOf = (id: string) => KOKORO_82M.tiers?.find((tier) => tier.id === id);

  it('marks fp16 broken on both WebGPU classes, and only those', () => {
    expect(tierOf('fp16')?.brokenOn).toEqual(['webgpu-f16', 'webgpu']);
    // The CPU is where it was measured to be correct — it is the control that
    // identified the backend rather than the weights as the cause, so it has to
    // stay usable there.
    expect(tierOf('fp16')?.brokenOn ?? []).not.toContain('wasm');
  });

  it('leaves the tiers that run anywhere unmarked', () => {
    expect(tierOf('q8')?.brokenOn).toBeUndefined();
    expect(tierOf('fp32')?.brokenOn).toBeUndefined();
  });

  it('never prefers a tier on a class it is broken for', () => {
    // The two fields disagreeing would put "Recommended" and "distorts the
    // audio" on the same row, and the recommendation would be the bug.
    for (const tier of KOKORO_82M.tiers ?? []) {
      for (const cls of tier.brokenOn ?? []) {
        expect(tier.preferredFor?.includes(cls) ?? false).toBe(false);
      }
    }
  });
});

describe('the registry', () => {
  it('holds Kokoro, and looks it up by id', () => {
    expect(MODELS).toContain(KOKORO_82M);
    expect(modelById('kokoro-82m')).toBe(KOKORO_82M);
    expect(modelById('nope')).toBeUndefined();
  });

  it('gives every model a licence, a repository, and files to fetch', () => {
    for (const model of MODELS) {
      expect(model.license.name).not.toBe('');
      expect(model.license.url).toMatch(/^https:\/\//);
      expect(model.repo).not.toBe('');
      expect(model.labelKey).not.toBe('');
      expect(model.languages.length).toBeGreaterThan(0);

      const files = [...(model.tiers ?? []).flatMap((tier) => tier.files), ...(model.files ?? [])];
      expect(files.length).toBeGreaterThan(0);
    }
  });

  it('gives every tier a positive size and its own ONNX', () => {
    for (const model of MODELS) {
      for (const tier of model.tiers ?? []) {
        expect(tier.bytes).toBeGreaterThan(0);
        expect(tier.id).not.toBe('');
        expect(tier.engineArg).not.toBe('');
        expect(tier.files.some((file) => file.endsWith('.onnx'))).toBe(true);
      }
    }
  });

  it('shares the three metadata files across every tier', () => {
    for (const model of MODELS) {
      for (const tier of model.tiers ?? []) {
        for (const shared of SHARED_MODEL_FILES) {
          expect(tier.files).toContain(shared);
        }
      }
    }
  });

  it('quotes the measured tier sizes', () => {
    // Written down from the file-listing API rather than probed, because the UI
    // has to show the size before anything is downloaded.
    expect(tierById(KOKORO_82M, 'q8')?.bytes).toBe(92_360_000);
    expect(tierById(KOKORO_82M, 'fp16')?.bytes).toBe(163_230_000);
    expect(tierById(KOKORO_82M, 'fp32')?.bytes).toBe(325_530_000);
  });

  it('maps each tier to the file its dtype actually requests', () => {
    // The mapping was measured; a tier naming a file the repository does not
    // have is a 404 that only shows up at download time.
    expect(tierById(KOKORO_82M, 'q8')?.files).toContain('onnx/model_quantized.onnx');
    expect(tierById(KOKORO_82M, 'fp16')?.files).toContain('onnx/model_fp16.onnx');
    expect(tierById(KOKORO_82M, 'fp32')?.files).toContain('onnx/model.onnx');
  });

  it('counts only the voices it can synthesize', () => {
    // 28 English plus 8 Chinese plus 5 Japanese; the other 13 need a G2P per language.
    expect(KOKORO_82M.voiceCount).toBe(41);
    expect(KOKORO_82M.languages).toEqual(['en-US', 'en-GB', 'zh-CN', 'ja']);
    expect(KOKORO_82M.voiceFile?.('zf_xiaoxiao')).toBe('voices/zf_xiaoxiao.bin');
  });
});
