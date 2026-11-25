import { describe, expect, it } from 'vitest';
import { KOKORO_82M, MODELS, modelById, SHARED_MODEL_FILES, tierById } from '~/lib/models/registry';

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

  it('quotes the measured tier size', () => {
    // Written down from the file-listing API rather than probed, because the UI
    // has to show the size before anything is downloaded.
    expect(tierById(KOKORO_82M, 'fp32')?.bytes).toBe(325_532_000);
  });

  it('maps the tier to the file its dtype actually requests', () => {
    // The mapping was measured; a tier naming a file the repository does not
    // have is a 404 that only shows up at download time.
    expect(tierById(KOKORO_82M, 'fp32')?.files).toContain('onnx/model.onnx');
  });

  it('ships only the full-precision weights', () => {
    // q8 and fp16 were removed on 2026-11-16: measured on Apple Silicon and
    // NVIDIA, neither produced usable audio on any backend. Keeping them as
    // "not recommended" would still let a machine download 92 or 163 MB of
    // weights it cannot use.
    expect(KOKORO_82M.tiers?.map((tier) => tier.id)).toEqual(['fp32']);
    expect(tierById(KOKORO_82M, 'q8')).toBeUndefined();
    expect(tierById(KOKORO_82M, 'fp16')).toBeUndefined();

    const files = (KOKORO_82M.tiers ?? []).flatMap((tier) => tier.files);
    expect(files.some((file) => file.includes('quantized'))).toBe(false);
    expect(files.some((file) => file.includes('fp16'))).toBe(false);
  });

  it('counts only the voices it can synthesize', () => {
    // 28 English plus 8 Chinese plus 5 Japanese; the other 13 need a G2P per language.
    expect(KOKORO_82M.voiceCount).toBe(41);
    expect(KOKORO_82M.languages).toEqual(['en-US', 'en-GB', 'zh-CN', 'ja']);
    expect(KOKORO_82M.voiceFile?.('zf_xiaoxiao')).toBe('voices/zf_xiaoxiao.bin');
  });
});
