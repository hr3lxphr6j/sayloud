import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type AudioCache,
  type AudioTimeline,
  AudioWorker,
  prefetchConcurrency,
} from '~/lib/audio-worker';
import { CacheManager } from '~/lib/cache-manager';
import type { OffscreenCommand, OffscreenEvent } from '~/lib/offscreen-protocol';
import { ProviderError } from '~/lib/providers/errors';
import type { Provider, ProviderConfig, ProviderId, SynthesisResult } from '~/lib/providers/types';
import { type AudioLike, TimelinePlayer } from '~/lib/timeline-player';

const CONFIG: ProviderConfig = { provider: 'dashscope', apiKey: 'k', model: 'cosyvoice-v3' };

/** A rejection shaped like the one `fetch` produces when a signal fires. */
function abortError(): Error {
  return Object.assign(new Error('aborted'), { name: 'AbortError' });
}

/** Let the worker's in-flight promise chain advance by one turn. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Wait for a condition the worker reaches asynchronously. */
async function until(predicate: () => boolean, attempts = 50): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (predicate()) return;
    await tick();
  }
  throw new Error('the condition was never met');
}

function result(bytes = 8, overrides: Partial<SynthesisResult> = {}): SynthesisResult {
  return { audio: new ArrayBuffer(bytes), mime: 'audio/mpeg', durationMs: 0, ...overrides };
}

function synthesize(
  id = 's1',
  overrides: Partial<Extract<OffscreenCommand, { type: 'synthesize' }>> = {}
) {
  return {
    type: 'synthesize' as const,
    id,
    text: 'hello',
    voiceId: 'v1',
    // The worker forwards this to the provider untouched and none of these
    // cases are about it; the ones that do care override it.
    lang: 'en-US',
    config: CONFIG,
    ...overrides,
  };
}

function fakeProvider(overrides: Partial<Provider> = {}): Provider {
  return {
    id: 'dashscope' as ProviderId,
    name: 'DashScope',
    capabilities: () => ({ timings: 'none' as const, maxChars: 200, concurrency: 2 }),
    validate: async () => {},
    listVoices: async () => [],
    synthesize: vi.fn(async () => result()),
    ...overrides,
  } as Provider;
}

/** Everything the worker talks to, with the spies the assertions need. */
function harness(
  options: {
    provider?: Provider;
    player?: Partial<AudioTimeline>;
    providers?: Map<ProviderId, Provider>;
  } = {}
) {
  const provider = options.provider ?? fakeProvider();
  const providers = options.providers ?? new Map<ProviderId, Provider>([['dashscope', provider]]);

  const cache: AudioCache = {
    computeKey: vi.fn(async () => 'key'),
    get: vi.fn(async () => undefined),
    put: vi.fn(async () => {}),
  };

  const player: AudioTimeline = {
    load: vi.fn(async () => ({ durationMs: 1234, hasTimings: true })),
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    stop: vi.fn(),
    setRate: vi.fn(),
    setVolume: vi.fn(),
    getCurrentTimeMs: vi.fn(() => 0),
    ...options.player,
  };

  const events: OffscreenEvent[] = [];
  const worker = new AudioWorker({
    providers,
    cache,
    player,
    emit: (event) => events.push(event),
  });

  return { worker, provider, cache, player, events, providers };
}

describe('AudioWorker', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('synthesize', () => {
    it('synthesizes, caches, loads and reports ready', async () => {
      const { worker, provider, cache, player, events } = harness();

      const reply = await worker.handleCommand(synthesize());

      expect(provider.synthesize).toHaveBeenCalledWith(
        expect.objectContaining({ text: 'hello', voiceId: 'v1' }),
        CONFIG
      );
      expect(cache.put).toHaveBeenCalledWith('key', expect.anything());
      expect(player.load).toHaveBeenCalledWith('s1', expect.anything());
      expect(reply).toEqual({ durationMs: 1234, hasTimings: true });
      expect(events).toEqual([{ type: 'ready', id: 's1', durationMs: 1234, hasTimings: true }]);
    });

    it('passes the text and voice into the cache key', async () => {
      const { worker, cache } = harness();

      await worker.handleCommand(synthesize());

      expect(cache.computeKey).toHaveBeenCalledWith({
        text: 'hello',
        voiceId: 'v1',
        config: CONFIG,
      });
    });

    it('plays a cache hit without asking the provider', async () => {
      const { worker, provider, cache, player, events } = harness();
      const cached = result(64);
      vi.mocked(cache.get).mockResolvedValue(cached);

      const reply = await worker.handleCommand(synthesize());

      expect(provider.synthesize).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
      expect(player.load).toHaveBeenCalledWith('s1', cached);
      expect(reply).toEqual({ durationMs: 1234, hasTimings: true });
      expect(events).toHaveLength(1);
    });

    it('stops the sentence it replaces', async () => {
      const { worker, player } = harness();

      await worker.handleCommand(synthesize());

      expect(player.stop).toHaveBeenCalled();
    });

    it('reports a provider failure as an error event and no reply', async () => {
      const provider = fakeProvider({
        synthesize: vi.fn(async () => {
          throw new ProviderError('rate-limit', 'too many requests');
        }),
      });
      const { worker, player, events } = harness({ provider });

      const reply = await worker.handleCommand(synthesize());

      expect(reply).toBeUndefined();
      expect(player.load).not.toHaveBeenCalled();
      expect(events).toEqual([
        { type: 'error', id: 's1', code: 'rate-limit', message: 'too many requests' },
      ]);
    });

    it('reports an unexpected failure as unknown', async () => {
      const provider = fakeProvider({
        synthesize: vi.fn(async () => {
          throw new Error('the wiring is wrong');
        }),
      });
      const { worker, events } = harness({ provider });

      await worker.handleCommand(synthesize());

      expect(events).toEqual([
        { type: 'error', id: 's1', code: 'unknown', message: 'the wiring is wrong' },
      ]);
    });

    it('reports a provider with no adapter', async () => {
      const { worker, events } = harness();
      const config: ProviderConfig = { provider: 'elevenlabs', apiKey: 'k' };

      const reply = await worker.handleCommand(synthesize('s1', { config }));

      expect(reply).toBeUndefined();
      expect(events).toEqual([
        {
          type: 'error',
          id: 's1',
          code: 'unknown',
          message: 'no adapter is registered for the elevenlabs provider',
        },
      ]);
    });

    it('gives up on a provider that never answers', async () => {
      vi.useFakeTimers();
      const provider = fakeProvider({
        synthesize: vi.fn(
          (request) =>
            new Promise<SynthesisResult>((_resolve, reject) => {
              request.signal.addEventListener('abort', () => {
                reject(abortError());
              });
            })
        ),
      });
      const { worker, events } = harness({ provider });

      const pending = worker.handleCommand(synthesize());
      await vi.advanceTimersByTimeAsync(30_000);
      const reply = await pending;

      expect(reply).toBeUndefined();
      expect(events).toEqual([
        {
          type: 'error',
          id: 's1',
          code: 'network-error',
          message: 'the provider did not answer in time',
        },
      ]);
    });

    it('reports an audio that cannot be decoded', async () => {
      const { worker, events } = harness({
        player: {
          load: vi.fn(async () => {
            throw new Error('the audio could not be decoded');
          }),
        },
      });

      const reply = await worker.handleCommand(synthesize());

      expect(reply).toBeUndefined();
      expect(events).toEqual([
        { type: 'error', id: 's1', code: 'audio-error', message: 'the audio could not be decoded' },
      ]);
    });

    it('still plays when the cache key cannot be computed', async () => {
      const { worker, cache, player, events } = harness();
      vi.mocked(cache.computeKey).mockRejectedValue(new Error('no crypto'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const reply = await worker.handleCommand(synthesize());

      expect(reply).toEqual({ durationMs: 1234, hasTimings: true });
      expect(player.load).toHaveBeenCalled();
      expect(events).toHaveLength(1);
      warn.mockRestore();
    });

    it('still plays when the cache cannot be written', async () => {
      const { worker, cache, player, events } = harness();
      vi.mocked(cache.put).mockRejectedValue(new Error('quota exceeded'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const reply = await worker.handleCommand(synthesize());

      expect(reply).toEqual({ durationMs: 1234, hasTimings: true });
      expect(player.load).toHaveBeenCalled();
      expect(events).toHaveLength(1);
      warn.mockRestore();
    });

    it('still plays when the cache read fails', async () => {
      const { worker, cache, player, events } = harness();
      vi.mocked(cache.get).mockRejectedValue(new Error('the store is corrupt'));
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const reply = await worker.handleCommand(synthesize());

      expect(reply).toEqual({ durationMs: 1234, hasTimings: true });
      expect(player.load).toHaveBeenCalled();
      expect(events).toHaveLength(1);
      warn.mockRestore();
    });
  });

  describe('superseding', () => {
    it('drops a synthesis that a newer one replaced', async () => {
      const { worker, provider, player, events } = harness();
      let release: (value: SynthesisResult) => void = () => {};
      vi.mocked(provider.synthesize).mockReturnValue(
        new Promise<SynthesisResult>((resolve) => {
          release = resolve;
        })
      );

      const first = worker.handleCommand(synthesize('old'));
      const second = worker.handleCommand(synthesize('new'));

      release(result());
      const [firstReply, secondReply] = await Promise.all([first, second]);

      expect(firstReply).toBeUndefined();
      expect(secondReply).toEqual({ durationMs: 1234, hasTimings: true });
      // Only the newer sentence reaches the player, and only one ready event.
      expect(player.load).toHaveBeenCalledTimes(1);
      expect(player.load).toHaveBeenCalledWith('new', expect.anything());
      expect(events.filter((event) => event.type === 'ready')).toEqual([
        { type: 'ready', id: 'new', durationMs: 1234, hasTimings: true },
      ]);
    });

    it('aborts the request it replaced', async () => {
      const { worker, provider } = harness();
      const signals: AbortSignal[] = [];
      vi.mocked(provider.synthesize)
        .mockImplementationOnce(
          (request) =>
            new Promise<SynthesisResult>((_resolve, reject) => {
              signals.push(request.signal);
              request.signal.addEventListener('abort', () => reject(abortError()));
            })
        )
        .mockImplementation(async (request) => {
          signals.push(request.signal);
          return result();
        });

      const first = worker.handleCommand(synthesize('first'));
      await tick();
      const second = worker.handleCommand(synthesize('second'));
      const [firstReply, secondReply] = await Promise.all([first, second]);

      expect(signals[0]?.aborted).toBe(true);
      expect(signals[1]?.aborted).toBe(false);
      expect(firstReply).toBeUndefined();
      expect(secondReply).toEqual({ durationMs: 1234, hasTimings: true });
    });

    it('stays silent when a superseded request fails', async () => {
      const { worker, provider, events } = harness();
      let reject: (error: Error) => void = () => {};
      vi.mocked(provider.synthesize)
        .mockImplementationOnce(
          () =>
            new Promise<SynthesisResult>((_resolve, rejectPromise) => {
              reject = rejectPromise;
            })
        )
        .mockImplementation(async () => result());

      const first = worker.handleCommand(synthesize('old'));
      await tick();
      const second = worker.handleCommand(synthesize('new'));
      reject(abortError());
      await Promise.all([first, second]);

      expect(events.filter((event) => event.type === 'error')).toEqual([]);
    });
  });

  describe('playback commands', () => {
    it('plays the requested sentence from the requested offset', async () => {
      const { worker, player } = harness();

      await worker.handleCommand({ type: 'play', id: 's1', startTimeMs: 250 });

      expect(player.play).toHaveBeenCalledWith('s1', 250);
    });

    it('reports a playback failure as an audio error', async () => {
      const { worker, events } = harness({
        player: {
          play: vi.fn(async () => {
            throw new Error('audio s1 is not loaded');
          }),
        },
      });

      await worker.handleCommand({ type: 'play', id: 's1', startTimeMs: 0 });

      expect(events).toEqual([
        { type: 'error', id: 's1', code: 'audio-error', message: 'audio s1 is not loaded' },
      ]);
    });

    it('pauses', async () => {
      const { worker, player, events } = harness();
      await worker.handleCommand({ type: 'pause' });
      expect(player.pause).toHaveBeenCalled();
      expect(events).toEqual([]);
    });

    it('reports the loaded utterance id and its paused audio position', async () => {
      const { worker, events } = harness({ player: { getCurrentTimeMs: () => 850 } });
      await worker.handleCommand(synthesize('current'));
      await worker.handleCommand({ type: 'pause' });
      expect(events).toContainEqual({ type: 'paused', id: 'current', currentTimeMs: 850 });
      worker.stop();
      events.length = 0;
      await worker.handleCommand({ type: 'pause' });
      expect(events).toEqual([]);
    });

    it('changes the rate', async () => {
      const { worker, player } = harness();
      await worker.handleCommand({ type: 'setRate', rate: 1.5 });
      expect(player.setRate).toHaveBeenCalledWith(1.5);
    });

    it('changes the volume', async () => {
      const { worker, player } = harness();
      await worker.handleCommand({ type: 'setVolume', volume: 0.4 });
      expect(player.setVolume).toHaveBeenCalledWith(0.4);
    });

    it('stops the player and abandons the request in flight', async () => {
      const { worker, provider, player, events } = harness();
      const signals: AbortSignal[] = [];
      vi.mocked(provider.synthesize).mockImplementation(
        (request) =>
          new Promise<SynthesisResult>((_resolve, reject) => {
            signals.push(request.signal);
            request.signal.addEventListener('abort', () => reject(abortError()));
          })
      );

      const pending = worker.handleCommand(synthesize());
      await tick();
      await worker.handleCommand({ type: 'stop' });
      const reply = await pending;

      expect(reply).toBeUndefined();
      expect(signals[0]?.aborted).toBe(true);
      expect(player.stop).toHaveBeenCalled();
      expect(events).toEqual([]);
    });
  });

  describe('prefetch', () => {
    function prefetch(
      items: Array<{ text: string; voiceId: string }>,
      config: ProviderConfig = CONFIG
    ) {
      return { type: 'prefetch' as const, items, config };
    }

    /** A provider that holds every synthesis until the test releases it. */
    function deferredProvider() {
      const pending: Array<{
        text: string;
        signal: AbortSignal;
        resolve: (result: SynthesisResult) => void;
      }> = [];
      const provider = fakeProvider({
        synthesize: vi.fn(
          (request) =>
            new Promise<SynthesisResult>((resolve, reject) => {
              pending.push({ text: request.text, signal: request.signal, resolve });
              request.signal.addEventListener('abort', () => reject(abortError()));
            })
        ),
      });
      return { provider, pending };
    }

    it('does not stop the player or abort the synthesis in flight', async () => {
      const { provider, pending } = deferredProvider();
      const { worker, player } = harness({ provider });

      const playback = worker.handleCommand(synthesize('s1'));
      await tick();
      const stopsBefore = vi.mocked(player.stop).mock.calls.length;

      await worker.handleCommand(prefetch([{ text: 'next', voiceId: 'v1' }]));
      await tick();

      // The prefetch did run: it asked the provider for the next sentence.
      expect(pending.map((call) => call.text)).toEqual(['hello', 'next']);
      expect(pending[0]?.signal.aborted).toBe(false);
      expect(player.stop).toHaveBeenCalledTimes(stopsBefore);

      pending[0]?.resolve(result());
      await playback;
      pending[1]?.resolve(result());
      await tick();
    });

    it('stays silent when a prefetch fails', async () => {
      const provider = fakeProvider({
        synthesize: vi.fn(async () => {
          throw new ProviderError('rate-limit', 'too many requests');
        }),
      });
      const { worker, events } = harness({ provider });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

      await worker.handleCommand(prefetch([{ text: 'next', voiceId: 'v1' }]));
      await tick();

      // An `error` event would make the engine fall back to the browser voice
      // for a sentence the user never asked to hear yet.
      expect(events).toEqual([]);
      expect(warn).toHaveBeenCalled();
      warn.mockRestore();
    });

    it('cancels outstanding prefetches when the session stops', async () => {
      const { provider, pending } = deferredProvider();
      const { worker, cache } = harness({ provider });
      vi.mocked(cache.computeKey).mockImplementation(async (identity) => identity.text);

      await worker.handleCommand(prefetch([{ text: 'next', voiceId: 'v1' }]));
      await tick();
      expect(pending).toHaveLength(1);

      await worker.handleCommand({ type: 'stop' });

      expect(pending[0]?.signal.aborted).toBe(true);
      expect(cache.put).not.toHaveBeenCalled();
    });

    it('cancels outstanding prefetches when a seek supersedes them', async () => {
      const { provider, pending } = deferredProvider();
      const { worker, cache } = harness({ provider });
      vi.mocked(cache.computeKey).mockImplementation(async (identity) => identity.text);

      await worker.handleCommand(prefetch([{ text: 'next', voiceId: 'v1' }]));
      await tick();

      const playback = worker.handleCommand(synthesize('s2'));
      await tick();

      expect(pending[0]?.signal.aborted).toBe(true);
      // The cancelled prefetch never reached the cache.
      expect(cache.put).not.toHaveBeenCalledWith('next', expect.anything());

      pending[1]?.resolve(result());
      await playback;
    });

    it('runs two prefetches at a time for a cloud provider', async () => {
      const { provider, pending } = deferredProvider();
      const { worker } = harness({ provider });

      await worker.handleCommand(
        prefetch([
          { text: 'a', voiceId: 'v1' },
          { text: 'b', voiceId: 'v1' },
          { text: 'c', voiceId: 'v1' },
        ])
      );
      await tick();
      expect(pending).toHaveLength(2);

      pending[0]?.resolve(result());
      await until(() => pending.length === 3);
      expect(pending[2]?.text).toBe('c');

      pending[1]?.resolve(result());
      pending[2]?.resolve(result());
      await tick();
    });

    it('runs one prefetch at a time for a local endpoint', async () => {
      const { provider, pending } = deferredProvider();
      const providers = new Map<ProviderId, Provider>([['openai-compat', provider]]);
      const { worker } = harness({ providers });
      const local: ProviderConfig = {
        provider: 'openai-compat',
        baseUrl: 'http://localhost:8880/v1',
      };

      await worker.handleCommand(
        prefetch(
          [
            { text: 'a', voiceId: 'v1' },
            { text: 'b', voiceId: 'v1' },
          ],
          local
        )
      );
      await tick();
      expect(pending).toHaveLength(1);

      pending[0]?.resolve(result());
      await until(() => pending.length === 2);
      pending[1]?.resolve(result());
      await tick();
    });

    it('honors the on-device provider concurrency capability', async () => {
      const { provider, pending } = deferredProvider();
      provider.capabilities = () => ({ timings: 'none', maxChars: 200, concurrency: 1 });
      const { worker } = harness({ providers: new Map([['local', provider]]) });
      await worker.handleCommand(
        prefetch(
          [
            { text: 'a', voiceId: 'v1' },
            { text: 'b', voiceId: 'v1' },
          ],
          { provider: 'local' }
        )
      );
      await tick();
      expect(pending).toHaveLength(1);
      pending[0]?.resolve(result());
      await until(() => pending.length === 2);
      pending[1]?.resolve(result());
      await tick();
    });

    it('caps the queue so a huge document cannot pin memory', async () => {
      const provider = fakeProvider();
      const { worker } = harness({ provider });
      const items = Array.from({ length: 20 }, (_, index) => ({
        text: `s${index}`,
        voiceId: 'v1',
      }));

      await worker.handleCommand(prefetch(items));
      await until(() => vi.mocked(provider.synthesize).mock.calls.length === 8);
      await tick();

      expect(provider.synthesize).toHaveBeenCalledTimes(8);
    });

    it('serves a prefetched sentence from the cache without asking the provider again', async () => {
      const provider = fakeProvider();
      const { worker, cache } = harness({ provider });
      const store = new Map<string, SynthesisResult>();
      vi.mocked(cache.computeKey).mockImplementation(async (identity) => identity.text);
      vi.mocked(cache.get).mockImplementation(async (key) => store.get(key));
      vi.mocked(cache.put).mockImplementation(async (key, result) => {
        store.set(key, result);
      });

      await worker.handleCommand(prefetch([{ text: 'next', voiceId: 'v1' }]));
      await until(() => store.has('next'));
      expect(provider.synthesize).toHaveBeenCalledTimes(1);

      const reply = await worker.handleCommand(synthesize('s2', { text: 'next' }));

      expect(provider.synthesize).toHaveBeenCalledTimes(1);
      expect(reply).toEqual({ durationMs: 1234, hasTimings: true });
    });

    it('does not re-synthesize a sentence that is already cached', async () => {
      const provider = fakeProvider();
      const { worker, cache } = harness({ provider });
      const cached = result(4);
      vi.mocked(cache.computeKey).mockImplementation(async (identity) => identity.text);
      vi.mocked(cache.get).mockImplementation(async (key) => (key === 'next' ? cached : undefined));

      await worker.handleCommand(prefetch([{ text: 'next', voiceId: 'v1' }]));
      await tick();

      expect(provider.synthesize).not.toHaveBeenCalled();
      expect(cache.put).not.toHaveBeenCalled();
    });
  });

  describe('prefetchConcurrency', () => {
    it.each<[string, ProviderConfig, number]>([
      ['a cloud provider', CONFIG, 2],
      [
        'a remote openai-compatible endpoint',
        { provider: 'openai-compat', baseUrl: 'https://api.example.com/v1' },
        2,
      ],
      ['localhost', { provider: 'openai-compat', baseUrl: 'http://localhost:8880/v1' }, 1],
      ['127.0.0.1', { provider: 'openai-compat', baseUrl: 'http://127.0.0.1:8880/v1' }, 1],
      ['IPv6 loopback', { provider: 'openai-compat', baseUrl: 'http://[::1]:8880/v1' }, 1],
      ['an unparsable url', { provider: 'openai-compat', baseUrl: 'not a url' }, 2],
    ])('is %s', (_label, config, expected) => {
      expect(prefetchConcurrency(config)).toBe(expected);
    });
  });
});

describe('AudioWorker over the real cache and player', () => {
  /** A fake audio element driven by the test. */
  function fakeAudio() {
    const audio: AudioLike = {
      src: '',
      currentTime: 0,
      playbackRate: 1,
      volume: 1,
      duration: Number.NaN,
      paused: true,
      play: vi.fn(async () => {
        audio.paused = false;
      }),
      pause: vi.fn(() => {
        audio.paused = true;
      }),
      onloadedmetadata: null,
      onerror: null,
      onended: null,
    };
    return audio;
  }

  let events: OffscreenEvent[];
  let worker: AudioWorker;
  let provider: Provider;
  let cache: CacheManager;
  let audios: AudioLike[];

  beforeEach(() => {
    events = [];
    audios = [];
    provider = fakeProvider({
      synthesize: vi.fn(async () =>
        result(16, {
          durationMs: 0,
          timings: [{ charStart: 0, charEnd: 5, startMs: 0, endMs: 200 }],
        })
      ),
    });
    cache = new CacheManager({ factory: new IDBFactory(), dbName: 'test-cache' });

    worker = new AudioWorker({
      providers: new Map<ProviderId, Provider>([['dashscope', provider]]),
      cache,
      player: new TimelinePlayer({
        emit: (event) => events.push(event),
        createAudio: () => {
          const audio = fakeAudio();
          audios.push(audio);
          return audio;
        },
        createObjectUrl: () => 'blob:fake',
        revokeObjectUrl: () => {},
      }),
      emit: (event) => events.push(event),
    });
  });

  it('serves the second synthesis from the cache', async () => {
    const first = worker.handleCommand(synthesize('s1'));
    await until(() => audios.length > 0);
    const audio = audios.at(0);
    if (!audio) throw new Error('no audio was created');
    audio.duration = 1.5;
    audio.onloadedmetadata?.();
    expect(await first).toEqual({ durationMs: 1500, hasTimings: true });

    const second = worker.handleCommand(synthesize('s2'));
    await until(() => audios.length > 1);
    const next = audios.at(1);
    if (!next) throw new Error('no audio was created');
    next.duration = 1.5;
    next.onloadedmetadata?.();

    expect(await second).toEqual({ durationMs: 1500, hasTimings: true });
    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it('serves a sentence the prefetcher already warmed', async () => {
    await worker.handleCommand({
      type: 'prefetch',
      items: [{ text: 'next sentence', voiceId: 'v1' }],
      config: CONFIG,
    });
    await until(() => cache.stats().l2Entries > 0);

    const pending = worker.handleCommand(synthesize('s2', { text: 'next sentence' }));
    await until(() => audios.length > 0);
    const audio = audios.at(0);
    if (!audio) throw new Error('no audio was created');
    audio.duration = 1.5;
    audio.onloadedmetadata?.();
    await pending;

    expect(provider.synthesize).toHaveBeenCalledTimes(1);
  });

  it('reports the words the player reaches', async () => {
    const pending = worker.handleCommand(synthesize('s1'));
    await until(() => audios.length > 0);
    const audio = audios.at(0);
    if (!audio) throw new Error('no audio was created');
    audio.duration = 1.5;
    audio.onloadedmetadata?.();
    await pending;

    await worker.handleCommand({ type: 'play', id: 's1', startTimeMs: 0 });

    expect(events).toContainEqual({ type: 'word', id: 's1', charStart: 0, charEnd: 5 });
  });
});
