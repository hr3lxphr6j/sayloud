import { describe, expect, it } from 'vitest';
import {
  CANONICAL_HOST,
  canonicalModelUrl,
  canonicalVoiceUrl,
  customBase,
  HUGGINGFACE_HOST,
  isCanonicalModelUrl,
  isOurs,
  isVoiceUrl,
  KOKORO_VOICES_CACHE,
  MODEL_HOSTS,
  MODELSCOPE_HOST,
  resolveUrl,
  TRANSFORMERS_CACHE,
  voiceUrlPrefix,
} from '~/lib/models/urls';

const REPO = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const FILE = 'onnx/model_quantized.onnx';
const CANONICAL = `https://model-cache.sayloud.invalid/${REPO}/resolve/main/${FILE}`;

describe('canonical URLs', () => {
  it('builds a model URL on a host that can never resolve', () => {
    expect(canonicalModelUrl(REPO, FILE)).toBe(CANONICAL);
    expect(CANONICAL_HOST).toBe('https://model-cache.sayloud.invalid/');
  });

  it('always says `main`, whatever the real source calls its branch', () => {
    expect(canonicalModelUrl(REPO, 'config.json')).toContain('/resolve/main/');
  });

  it('builds the voice URL kokoro-js hardcodes for itself', () => {
    // The exact string, because the library looks the cache up by it.
    expect(canonicalVoiceUrl(REPO, 'voices/af_heart.bin')).toBe(
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/af_heart.bin'
    );
    expect(voiceUrlPrefix(REPO)).toBe(
      'https://huggingface.co/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/main/voices/'
    );
  });

  it('names the two buckets the way their owners do', () => {
    expect(TRANSFORMERS_CACHE).toBe('transformers-cache');
    expect(KOKORO_VOICES_CACHE).toBe('kokoro-voices');
  });
});

describe('resolveUrl', () => {
  it('resolves to Hugging Face on `main`', () => {
    expect(resolveUrl(CANONICAL, { host: 'huggingface' })).toBe(
      `https://huggingface.co/${REPO}/resolve/main/${FILE}`
    );
  });

  it('resolves to ModelScope on `master`', () => {
    expect(resolveUrl(CANONICAL, { host: 'modelscope' })).toBe(
      `https://modelscope.cn/models/${REPO}/resolve/master/${FILE}`
    );
  });

  it('resolves to a custom mirror, defaulting to `main`', () => {
    expect(resolveUrl(CANONICAL, { host: 'custom', customHostUrl: 'https://mirror.test/m' })).toBe(
      `https://mirror.test/m/${REPO}/resolve/main/${FILE}`
    );
  });

  it('uses a custom mirror revision when one is given', () => {
    expect(
      resolveUrl(CANONICAL, {
        host: 'custom',
        customHostUrl: 'https://mirror.test/m',
        revision: 'v2',
      })
    ).toBe(`https://mirror.test/m/${REPO}/resolve/v2/${FILE}`);
  });

  it('tolerates a trailing slash on the custom base', () => {
    expect(
      resolveUrl(CANONICAL, { host: 'custom', customHostUrl: 'https://mirror.test/m/' })
    ).toContain('https://mirror.test/m/onnx-community/');
  });

  it('refuses to build a custom URL with no mirror', () => {
    expect(() => resolveUrl(CANONICAL, { host: 'custom' })).toThrow(/needs a URL/);
    expect(() => customBase({ host: 'custom', customHostUrl: '   ' })).toThrow(/needs a URL/);
  });

  it('rewrites the voice URL to ModelScope, keeping the file path', () => {
    const voice = canonicalVoiceUrl(REPO, 'voices/af_heart.bin');
    expect(resolveUrl(voice, { host: 'modelscope' })).toBe(
      'https://modelscope.cn/models/onnx-community/Kokoro-82M-v1.0-ONNX/resolve/master/voices/af_heart.bin'
    );
  });

  it('leaves the voice URL alone on Hugging Face, where it already points', () => {
    const voice = canonicalVoiceUrl(REPO, 'voices/af_heart.bin');
    expect(resolveUrl(voice, { host: 'huggingface' })).toBe(voice);
  });

  it('resolves a canonical URL the same way twice', () => {
    // The fetch patch re-resolves what a previous pass produced, so a rewrite
    // must be idempotent for a real Hugging Face URL.
    const once = resolveUrl(CANONICAL, { host: 'huggingface' });
    expect(resolveUrl(once, { host: 'modelscope' })).toBe(
      resolveUrl(CANONICAL, { host: 'modelscope' })
    );
  });

  it('passes a foreign URL through untouched', () => {
    const foreign = 'https://example.com/some/other/thing.json';
    expect(resolveUrl(foreign, { host: 'modelscope' })).toBe(foreign);
    expect(resolveUrl('', { host: 'modelscope' })).toBe('');

    // A real ModelScope URL is already resolved; rewriting it again would be
    // inventing a second prefix.
    const real = `https://modelscope.cn/models/${REPO}/resolve/master/${FILE}`;
    expect(resolveUrl(real, { host: 'huggingface' })).toBe(real);
  });

  it('passes through a URL that only looks like ours', () => {
    expect(resolveUrl(`${CANONICAL_HOST}${REPO}`, { host: 'modelscope' })).toBe(
      `${CANONICAL_HOST}${REPO}`
    );
    expect(resolveUrl(`${CANONICAL_HOST}${REPO}/resolve/main/`, { host: 'modelscope' })).toBe(
      `${CANONICAL_HOST}${REPO}/resolve/main/`
    );
  });
});

describe('the predicates', () => {
  it('recognises our own keys', () => {
    expect(isCanonicalModelUrl(CANONICAL)).toBe(true);
    expect(isOurs(CANONICAL)).toBe(true);
    expect(isVoiceUrl(canonicalVoiceUrl(REPO, 'voices/af_heart.bin'))).toBe(true);
    expect(isOurs(canonicalVoiceUrl(REPO, 'voices/af_heart.bin'))).toBe(true);
  });

  it('does not claim anything else', () => {
    expect(isCanonicalModelUrl('https://huggingface.co/x/y/resolve/main/z')).toBe(false);
    expect(isVoiceUrl('https://huggingface.co/x/y/resolve/main/z.onnx')).toBe(false);
    // Only voice files, so a stray Hugging Face URL is left alone.
    expect(isVoiceUrl('https://huggingface.co/x/y/resolve/main/model.onnx')).toBe(false);
    expect(isVoiceUrl(`${HUGGINGFACE_HOST}${REPO}/resolve/main/voices/`)).toBe(false);
    expect(isOurs('https://example.com/whatever')).toBe(false);
    expect(isOurs('')).toBe(false);
  });

  it('knows the shape of the host enum the UI offers', () => {
    expect([...MODEL_HOSTS]).toEqual(['auto', 'huggingface', 'modelscope', 'custom']);
    expect(MODELSCOPE_HOST).toBe('https://modelscope.cn/models/');
  });
});
