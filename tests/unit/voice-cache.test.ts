import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { TtsApi, TtsVoiceLike } from '~/lib/speaker';
import { VoiceCache } from '~/lib/voice-cache';

function fakeTts(_voices: TtsVoiceLike[]) {
  let resolveVoices: (value: TtsVoiceLike[]) => void = () => {};
  const tts: TtsApi = {
    speak: vi.fn(),
    stop: vi.fn(),
    getVoices: vi.fn(
      () =>
        new Promise<TtsVoiceLike[]>((resolve) => {
          resolveVoices = resolve;
        })
    ),
  };
  return { tts, resolve: (value: TtsVoiceLike[]) => resolveVoices(value) };
}

const VOICES: TtsVoiceLike[] = [
  { voiceName: 'Tingting', lang: 'zh-CN' },
  { voiceName: 'Samantha', lang: 'en-US' },
];

describe('VoiceCache', () => {
  let fake: ReturnType<typeof fakeTts>;
  let cache: VoiceCache;

  beforeEach(() => {
    fake = fakeTts(VOICES);
    cache = new VoiceCache(fake.tts);
  });

  it('starts empty and resolves to undefined', () => {
    expect(cache.isEmpty).toBe(true);
    expect(cache.resolve('en-US')).toBeUndefined();
  });

  it('resolves a voice after refreshing', async () => {
    const refresh = cache.refresh();
    fake.resolve(VOICES);
    await refresh;

    expect(cache.isEmpty).toBe(false);
    expect(cache.size).toBe(2);
    expect(cache.resolve('en-US')).toBe('Samantha');
    expect(cache.resolve('zh-CN')).toBe('Tingting');
  });

  it('shares one request between concurrent refreshes', async () => {
    const first = cache.refresh();
    const second = cache.refresh();
    fake.resolve(VOICES);
    await Promise.all([first, second]);

    expect(fake.tts.getVoices).toHaveBeenCalledTimes(1);
  });

  it('keeps the previous list when a refresh fails', async () => {
    const refresh = cache.refresh();
    fake.resolve(VOICES);
    await refresh;

    vi.mocked(fake.tts.getVoices).mockRejectedValueOnce(new Error('offline'));
    await cache.refresh();

    expect(cache.resolve('en-US')).toBe('Samantha');
  });

  it('resolves to an empty name when the chosen voice is unnamed', async () => {
    const unnamed = fakeTts([{ lang: 'en-US' }]);
    const unnamedCache = new VoiceCache(unnamed.tts);
    const refresh = unnamedCache.refresh();
    unnamed.resolve([{ lang: 'en-US' }]);
    await refresh;

    // Empty means "any available voice" to chrome.tts, not "no voice".
    expect(unnamedCache.resolve('en-US')).toBe('');
  });

  it('resolves to undefined when no supported voice exists', async () => {
    const german = fakeTts([{ voiceName: 'Anna', lang: 'de-DE' }]);
    const germanCache = new VoiceCache(german.tts);
    const refresh = germanCache.refresh();
    german.resolve([{ voiceName: 'Anna', lang: 'de-DE' }]);
    await refresh;

    expect(germanCache.resolve('de-DE')).toBeUndefined();
  });
});
