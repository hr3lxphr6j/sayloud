import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderConfig, ProviderId } from '~/lib/providers/types';
import type { PrefetchRequest, Speaker, SpeakerEvents, SpeakRequest } from '~/lib/speaker';
import { type ConfigSource, SpeakerRouter } from '~/lib/speaker-router';

const DASHSCOPE: ProviderConfig = { provider: 'dashscope', apiKey: 'k', model: 'cosyvoice-v3' };
const ELEVEN: ProviderConfig = { provider: 'elevenlabs', apiKey: 'k' };

const REQUEST: SpeakRequest = { text: 'hello', voice: 'v1', rate: 1, lang: 'en-US' };

/** A speaker that records what it was asked to say and can be told to speak. */
function fakeSpeaker(name: string, options: { prefetch?: boolean } = {}) {
  const requests: SpeakRequest[] = [];
  const prefetches: PrefetchRequest[][] = [];
  const listeners = new Map<keyof SpeakerEvents, Set<(payload: never) => void>>();
  const speaker: Speaker = {
    speak(request) {
      requests.push(request);
    },
    ...(options.prefetch
      ? {
          prefetch(batch: readonly PrefetchRequest[]) {
            prefetches.push([...batch]);
          },
        }
      : {}),
    stop: vi.fn(),
    on(event, handler) {
      let handlers = listeners.get(event);
      if (!handlers) {
        handlers = new Set();
        listeners.set(event, handlers);
      }
      handlers.add(handler as (payload: never) => void);
      return () => {
        handlers.delete(handler as (payload: never) => void);
      };
    },
    dispose: vi.fn(),
  };

  return {
    name,
    speaker,
    requests,
    prefetches,
    stop: speaker.stop as ReturnType<typeof vi.fn>,
    dispose: speaker.dispose as ReturnType<typeof vi.fn>,
    deliver(event: keyof SpeakerEvents, payload: unknown): void {
      for (const handler of listeners.get(event) ?? []) {
        (handler as (value: unknown) => void)(payload);
      }
    },
    get listenerCount(): number {
      let total = 0;
      for (const handlers of listeners.values()) total += handlers.size;
      return total;
    },
  };
}

function fakeConfig(
  config: ProviderConfig | null,
  voices: Partial<Record<ProviderId, string>> = {}
) {
  const source: ConfigSource = {
    getConfig: vi.fn(async () => config),
    getSelectedVoice: vi.fn(async (provider: ProviderId) => voices[provider] ?? null),
  };
  return source;
}

/** A configuration that a test can change between refreshes. */
function mutableConfig(
  config: ProviderConfig | null,
  voices: Partial<Record<ProviderId, string>> = {}
) {
  const state = { config, voices };
  const source: ConfigSource = {
    getConfig: async () => state.config,
    getSelectedVoice: async (provider: ProviderId) => state.voices[provider] ?? null,
  };
  return { state, source };
}

/** A router over the shared browser and cloud fakes. */
function routerOver(
  config: ConfigSource,
  browser: ReturnType<typeof fakeSpeaker>,
  cloud: ReturnType<typeof fakeSpeaker>
): SpeakerRouter {
  return new SpeakerRouter({
    browser: browser.speaker,
    config,
    createCloud: () => cloud.speaker,
    resolveBrowserVoice: (lang) => `browser:${lang}`,
  });
}

describe('SpeakerRouter', () => {
  let browser: ReturnType<typeof fakeSpeaker>;
  let cloud: ReturnType<typeof fakeSpeaker>;
  let router: SpeakerRouter;
  let created: ProviderConfig[];

  beforeEach(() => {
    browser = fakeSpeaker('browser');
    cloud = fakeSpeaker('cloud', { prefetch: true });
    created = [];
    router = new SpeakerRouter({
      browser: browser.speaker,
      config: fakeConfig(null),
      createCloud: (config) => {
        created.push(config);
        return cloud.speaker;
      },
      resolveBrowserVoice: (lang) => `browser:${lang}`,
    });
  });

  describe('before the configuration is read', () => {
    it('uses the browser voice', () => {
      expect(router.isCloud).toBe(false);
      expect(router.provider).toBe('browser');

      router.speak(REQUEST);

      expect(browser.requests).toEqual([REQUEST]);
      expect(cloud.requests).toEqual([]);
    });

    it('resolves browser voices by language', () => {
      expect(router.resolveVoice('en-US')).toBe('browser:en-US');
    });
  });

  describe('refresh', () => {
    it('keeps the browser voice when nothing is configured', async () => {
      await router.refresh();

      expect(router.isCloud).toBe(false);
      expect(created).toEqual([]);
      expect(router.resolveVoice('zh-CN')).toBe('browser:zh-CN');
    });

    it('keeps the browser voice when the browser is the configured provider', async () => {
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: fakeConfig({ provider: 'browser', lang: 'en-US' }),
        createCloud: () => cloud.speaker,
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await router.refresh();

      expect(router.isCloud).toBe(false);
    });

    it('switches to the cloud voice when a provider and a voice are configured', async () => {
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: fakeConfig(DASHSCOPE, { dashscope: 'longxiaochun' }),
        createCloud: (config) => {
          created.push(config);
          return cloud.speaker;
        },
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await router.refresh();

      expect(router.isCloud).toBe(true);
      expect(router.provider).toBe('dashscope');
      expect(created).toEqual([DASHSCOPE]);
      // The browser voice is silenced before the cloud voice takes over.
      expect(browser.stop).toHaveBeenCalled();

      router.speak(REQUEST);
      expect(cloud.requests).toEqual([REQUEST]);
      expect(browser.requests).toEqual([]);
    });

    it('resolves the configured cloud voice for every language', async () => {
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: fakeConfig(DASHSCOPE, { dashscope: 'longxiaochun' }),
        createCloud: () => cloud.speaker,
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await router.refresh();

      expect(router.resolveVoice('en-US')).toBe('longxiaochun');
      expect(router.resolveVoice('zh-CN')).toBe('longxiaochun');
    });

    it('falls back to the browser voice when the provider has no voice', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: fakeConfig(DASHSCOPE),
        createCloud: () => cloud.speaker,
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await router.refresh();

      expect(router.isCloud).toBe(false);
      expect(router.resolveVoice('en-US')).toBe('browser:en-US');
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('no voice is selected'));
      warn.mockRestore();
    });

    it('falls back to the browser voice when this build has no cloud speaker', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: fakeConfig(DASHSCOPE, { dashscope: 'longxiaochun' }),
        createCloud: () => null,
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await router.refresh();

      expect(router.isCloud).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('unavailable'));
      warn.mockRestore();
    });

    it('keeps the same cloud speaker when nothing changed', async () => {
      const config = fakeConfig(DASHSCOPE, { dashscope: 'longxiaochun' });
      router = new SpeakerRouter({
        browser: browser.speaker,
        config,
        createCloud: (providerConfig) => {
          created.push(providerConfig);
          return cloud.speaker;
        },
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await router.refresh();
      await router.refresh();

      expect(created).toHaveLength(1);
      // Rebuilding would have stopped the sentence that is playing.
      expect(cloud.stop).not.toHaveBeenCalled();
    });

    it('rebuilds when the voice changes, disposing the speaker it replaced', async () => {
      const voices: Partial<Record<ProviderId, string>> = { dashscope: 'first' };
      const built: Array<ReturnType<typeof fakeSpeaker>> = [];
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: {
          getConfig: async () => DASHSCOPE,
          getSelectedVoice: async (provider) => voices[provider] ?? null,
        },
        createCloud: () => {
          const speaker = fakeSpeaker(`cloud-${built.length + 1}`);
          built.push(speaker);
          return speaker.speaker;
        },
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await router.refresh();
      voices.dashscope = 'second';
      await router.refresh();

      expect(built).toHaveLength(2);
      expect(built[0]?.dispose).toHaveBeenCalled();
      expect(built[1]?.dispose).not.toHaveBeenCalled();
      expect(router.resolveVoice('en')).toBe('second');
    });

    it('returns to the browser voice when the cloud provider is dropped', async () => {
      const config = fakeConfig(DASHSCOPE, { dashscope: 'longxiaochun' });
      router = new SpeakerRouter({
        browser: browser.speaker,
        config,
        createCloud: () => cloud.speaker,
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });
      await router.refresh();

      vi.mocked(config.getConfig).mockResolvedValue({ provider: 'browser' });
      await router.refresh();

      expect(router.isCloud).toBe(false);
      expect(cloud.dispose).toHaveBeenCalled();
      expect(router.resolveVoice('en-US')).toBe('browser:en-US');
    });

    it('switches between two cloud providers', async () => {
      const config = fakeConfig(DASHSCOPE, { dashscope: 'a', elevenlabs: 'b' });
      router = new SpeakerRouter({
        browser: browser.speaker,
        config,
        createCloud: (providerConfig) => {
          created.push(providerConfig);
          return cloud.speaker;
        },
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });
      await router.refresh();

      vi.mocked(config.getConfig).mockResolvedValue(ELEVEN);
      await router.refresh();

      expect(router.provider).toBe('elevenlabs');
      expect(router.resolveVoice('en')).toBe('b');
      expect(created).toEqual([DASHSCOPE, ELEVEN]);
    });

    it('survives storage that cannot be read', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: {
          getConfig: async () => {
            throw new Error('storage is gone');
          },
          getSelectedVoice: async () => null,
        },
        createCloud: () => cloud.speaker,
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await expect(router.refresh()).resolves.toBeUndefined();

      expect(router.isCloud).toBe(false);
      expect(router.resolveVoice('en-US')).toBe('browser:en-US');
      error.mockRestore();
    });

    it('survives a cloud speaker that cannot be built', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: fakeConfig(DASHSCOPE, { dashscope: 'longxiaochun' }),
        createCloud: () => {
          throw new Error('the offscreen API is missing');
        },
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await expect(router.refresh()).resolves.toBeUndefined();

      expect(router.isCloud).toBe(false);
      expect(router.resolveVoice('en-US')).toBe('browser:en-US');
      error.mockRestore();
    });

    it('survives a voice lookup that fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: {
          getConfig: async () => DASHSCOPE,
          getSelectedVoice: async () => {
            throw new Error('storage is gone');
          },
        },
        createCloud: () => cloud.speaker,
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });

      await expect(router.refresh()).resolves.toBeUndefined();

      expect(router.isCloud).toBe(false);
      error.mockRestore();
    });
  });

  describe('events', () => {
    // Fresh speakers: the ones the outer harness builds are shared with the
    // tests that assert on listener counts.
    let eventsBrowser: ReturnType<typeof fakeSpeaker>;
    let eventsCloud: ReturnType<typeof fakeSpeaker>;
    let routed: SpeakerRouter;

    beforeEach(async () => {
      eventsBrowser = fakeSpeaker('browser');
      eventsCloud = fakeSpeaker('cloud');
      routed = routerOver(
        fakeConfig(DASHSCOPE, { dashscope: 'longxiaochun' }),
        eventsBrowser,
        eventsCloud
      );
      await routed.refresh();
    });

    it('forwards the active speaker events', () => {
      const seen: unknown[] = [];
      routed.on('start', () => seen.push('start'));
      routed.on('word', (span) => seen.push(span));
      routed.on('end', () => seen.push('end'));
      routed.on('error', (message) => seen.push(message));

      eventsCloud.deliver('start', undefined);
      eventsCloud.deliver('word', { charStart: 0, charEnd: 5 });
      eventsCloud.deliver('end', undefined);
      eventsCloud.deliver('error', 'boom');

      expect(seen).toEqual(['start', { charStart: 0, charEnd: 5 }, 'end', 'boom']);
    });

    it('stops forwarding from a speaker that was replaced', async () => {
      const { state, source } = mutableConfig(DASHSCOPE, { dashscope: 'longxiaochun' });
      const ownBrowser = fakeSpeaker('browser');
      const ownCloud = fakeSpeaker('cloud');
      const routed = routerOver(source, ownBrowser, ownCloud);
      const seen: unknown[] = [];
      routed.on('end', () => seen.push('end'));
      await routed.refresh();

      // The provider is dropped while the cloud speaker is the active one.
      state.config = null;
      await routed.refresh();

      ownCloud.deliver('end', undefined);
      ownBrowser.deliver('end', undefined);

      // Only the browser voice is speaking, so only its event arrives.
      expect(seen).toEqual(['end']);
    });

    it('stops listening to the speaker it left', async () => {
      const { state, source } = mutableConfig(DASHSCOPE, { dashscope: 'longxiaochun' });
      const ownBrowser = fakeSpeaker('browser');
      const ownCloud = fakeSpeaker('cloud');
      const routed = routerOver(source, ownBrowser, ownCloud);
      await routed.refresh();
      expect(ownCloud.listenerCount).toBe(4);

      state.config = null;
      await routed.refresh();

      expect(ownCloud.listenerCount).toBe(0);
      expect(ownBrowser.listenerCount).toBe(4);
    });
  });

  describe('switching speakers', () => {
    /** A router whose configuration a test can change, with its own speakers. */
    async function playingRouter() {
      const { state, source } = mutableConfig(DASHSCOPE, { dashscope: 'longxiaochun' });
      const ownBrowser = fakeSpeaker('browser');
      const ownCloud = fakeSpeaker('cloud');
      const routed = routerOver(source, ownBrowser, ownCloud);
      const seen: string[] = [];
      routed.on('start', () => seen.push('start'));
      routed.on('end', () => seen.push('end'));
      await routed.refresh();
      return { state, routed, ownBrowser, ownCloud, seen };
    }

    it('ends the sentence a provider change cut off, so playback continues', async () => {
      const { state, routed, ownBrowser, ownCloud, seen } = await playingRouter();
      ownCloud.deliver('start', undefined);

      state.config = null;
      await routed.refresh();

      // The engine waits for the sentence it was speaking to end; without this
      // it would sit in `playing` with nothing playing, forever.
      expect(seen).toEqual(['start', 'end']);

      routed.speak(REQUEST);
      expect(ownBrowser.requests).toEqual([REQUEST]);
      expect(ownCloud.requests).toEqual([]);
    });

    it('says nothing when the change happens between sentences', async () => {
      const { state, routed, ownCloud, seen } = await playingRouter();
      ownCloud.deliver('start', undefined);
      ownCloud.deliver('end', undefined);

      state.config = null;
      await routed.refresh();

      expect(seen).toEqual(['start', 'end']);
    });

    it('says nothing after a stop, which already ended the sentence', async () => {
      const { state, routed, ownCloud, seen } = await playingRouter();
      ownCloud.deliver('start', undefined);
      routed.stop();

      state.config = null;
      await routed.refresh();

      expect(seen).toEqual(['start']);
    });

    it('says nothing after an error, which the engine handles itself', async () => {
      const { state, routed, ownCloud, seen } = await playingRouter();
      ownCloud.deliver('start', undefined);
      ownCloud.deliver('error', 'boom');

      state.config = null;
      await routed.refresh();

      expect(seen).toEqual(['start']);
    });
  });

  describe('prefetch', () => {
    it('forwards to the cloud speaker that is active', async () => {
      router = new SpeakerRouter({
        browser: browser.speaker,
        config: fakeConfig(DASHSCOPE, { dashscope: 'longxiaochun' }),
        createCloud: () => cloud.speaker,
        resolveBrowserVoice: (lang) => `browser:${lang}`,
      });
      await router.refresh();

      router.prefetch([{ text: 'next', voice: 'longxiaochun' }]);

      expect(cloud.prefetches).toEqual([[{ text: 'next', voice: 'longxiaochun' }]]);
      expect(browser.prefetches).toEqual([]);
    });

    it('is a no-op while the browser voice is active', () => {
      expect(() => router.prefetch([{ text: 'next', voice: 'Samantha' }])).not.toThrow();

      expect(browser.prefetches).toEqual([]);
      expect(cloud.prefetches).toEqual([]);
    });

    it('follows the active speaker across a switch', async () => {
      const { state, source } = mutableConfig(DASHSCOPE, { dashscope: 'longxiaochun' });
      const ownBrowser = fakeSpeaker('browser');
      const ownCloud = fakeSpeaker('cloud', { prefetch: true });
      const routed = routerOver(source, ownBrowser, ownCloud);
      await routed.refresh();

      routed.prefetch([{ text: 'one', voice: 'v' }]);
      state.config = null;
      await routed.refresh();
      routed.prefetch([{ text: 'two', voice: 'v' }]);

      // The browser voice has no prefetch, so the second call goes nowhere.
      expect(ownCloud.prefetches).toEqual([[{ text: 'one', voice: 'v' }]]);
    });
  });

  describe('stop and dispose', () => {
    it('stops whichever speaker is active', async () => {
      router.stop();
      expect(browser.stop).toHaveBeenCalledTimes(1);
      expect(cloud.stop).not.toHaveBeenCalled();
    });

    it('disposes both speakers and drops its listeners', async () => {
      const { source } = mutableConfig(DASHSCOPE, { dashscope: 'longxiaochun' });
      const routed = routerOver(source, browser, cloud);
      const seen: unknown[] = [];
      routed.on('end', () => seen.push('end'));
      await routed.refresh();

      routed.dispose();

      expect(browser.dispose).toHaveBeenCalled();
      expect(cloud.dispose).toHaveBeenCalled();
      expect(cloud.listenerCount).toBe(0);

      cloud.deliver('end', undefined);
      expect(seen).toEqual([]);
    });
  });
});
