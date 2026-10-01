/**
 * The offscreen document's whole behaviour: turn commands into audio (spec §3.1).
 *
 * It holds no session state. The service worker decides which sentence plays
 * next; this decides how to get the bytes and hands them to the timeline
 * player. Everything it does know — the cache, the player's current sentence,
 * the in-flight request — is disposable: if Chrome reclaims the document, the
 * worker is rebuilt and the service worker's next command rebuilds the context.
 *
 * Two behaviours are worth stating because they are not obvious from the
 * command list:
 *
 * - A new `synthesize` supersedes the one before it. The in-flight request is
 *   aborted and its result dropped, so a seek does not leave the previous
 *   sentence's audio to start playing a moment later.
 * - A `prefetch` warms the cache and touches nothing else. It has its own
 *   abort controllers and its own queue precisely so that it can never abort a
 *   synthesis, silence the player, or report a failure as a playback error.
 * - Failures are reported as events, not rejections. The service worker's
 *   speaker would otherwise have to handle the same failure twice, once as a
 *   message event and once as a rejected `sendMessage`.
 */
import type { CacheIdentity } from './cache-manager';
import type {
  OffscreenCommand,
  OffscreenErrorCode,
  OffscreenEvent,
  SynthesizeReply,
} from './offscreen-protocol';
import {
  abortError,
  errorMessage,
  isAbortError,
  isProviderError,
  ProviderError,
} from './providers/errors';
import type { Provider, ProviderConfig, ProviderId, SynthesisResult } from './providers/types';
import type { LoadedAudioInfo } from './timeline-player';

/** The cache operations the worker needs. `CacheManager` satisfies this. */
export interface AudioCache {
  computeKey(identity: CacheIdentity): Promise<string>;
  get(key: string): Promise<SynthesisResult | undefined>;
  put(key: string, result: SynthesisResult): Promise<void>;
}

/** The player operations the worker needs. `TimelinePlayer` satisfies this. */
export interface AudioTimeline {
  load(id: string, result: SynthesisResult): Promise<LoadedAudioInfo>;
  play(id: string, startTimeMs?: number): Promise<void>;
  pause(): void;
  stop(): void;
  setRate(rate: number): void;
  setVolume(volume: number): void;
}

export interface AudioWorkerDeps {
  providers: ReadonlyMap<ProviderId, Provider>;
  cache: AudioCache;
  player: AudioTimeline;
  /** Sends an event to the service worker. */
  emit: (event: OffscreenEvent) => void;
  /** How long one synthesis may take before it is abandoned. */
  synthesizeTimeoutMs?: number;
  /**
   * The same, for on-device models.
   *
   * Separate because the cost profile is nothing like a cloud call's: there is
   * no network, but the first sentence of a session also builds the inference
   * session.
   */
  localSynthesizeTimeoutMs?: number;
}

/** Long enough for a slow provider on a slow connection. */
const DEFAULT_SYNTHESIZE_TIMEOUT_MS = 30_000;

/**
 * The on-device engine gets far longer, and for a reason no cloud provider has:
 * the first sentence of a session also builds an inference session. Measured at
 * 12–13 seconds for a tier already on disk, before the audio decode that shares
 * the same machine — and a tier that is *not* yet downloaded would be worse
 * still. Thirty seconds is not a budget this work fits in.
 */
const LOCAL_SYNTHESIZE_TIMEOUT_MS = 180_000;

/**
 * How many sentences may be queued for prefetching.
 *
 * The engine only ever asks for a few seconds ahead, so this is a guard rather
 * than a working limit: it stops a document with thousands of sentences from
 * pinning the whole article's worth of text and audio in memory.
 */
const MAX_PREFETCH_QUEUE = 8;

/** A cloud provider takes two prefetches at a time. */
const CLOUD_PREFETCH_CONCURRENCY = 2;
/** A local server gets one: it is a single process on the user's machine. */
const LOCAL_PREFETCH_CONCURRENCY = 1;

/** One sentence waiting to be warmed in the cache. */
interface PrefetchItem {
  text: string;
  voiceId: string;
}

/**
 * How many prefetches may run at once for a config.
 *
 * Cloud services accept two in parallel; an `openai-compat` endpoint on
 * loopback is one local process, and saturating it would slow down the sentence
 * that is actually being played.
 */
export function prefetchConcurrency(config: ProviderConfig): number {
  if (config.provider === 'openai-compat' && isLoopback(config.baseUrl)) {
    return LOCAL_PREFETCH_CONCURRENCY;
  }
  return CLOUD_PREFETCH_CONCURRENCY;
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

export class AudioWorker {
  private readonly providers: ReadonlyMap<ProviderId, Provider>;
  private readonly cache: AudioCache;
  private readonly player: AudioTimeline;
  private readonly emit: (event: OffscreenEvent) => void;
  private readonly synthesizeTimeoutMs: number;
  private readonly localSynthesizeTimeoutMs: number;

  /**
   * Bumped by every command that supersedes work in flight. A synthesis that
   * comes back to find a newer generation drops its result instead of playing
   * over it.
   */
  private generation = 0;
  private inFlight: AbortController | null = null;

  /**
   * The prefetch queue, deliberately separate from the playback request.
   *
   * Prefetching must never touch the generation counter, the in-flight
   * controller, or the player: a background sentence that is slow, or that
   * fails, must not silence or fail the sentence the user is listening to.
   */
  private prefetchQueue: PrefetchItem[] = [];
  private prefetchConfig: ProviderConfig | null = null;
  /** Bumped whenever the queue is replaced or cancelled; stale work bails out. */
  private prefetchBatch = 0;
  /**
   * Prefetches in flight. Doubles as the concurrency counter, so an aborted
   * request still counts until its promise settles.
   */
  private readonly prefetchInFlight = new Set<AbortController>();

  constructor(deps: AudioWorkerDeps) {
    this.providers = deps.providers;
    this.cache = deps.cache;
    this.player = deps.player;
    this.emit = deps.emit;
    this.synthesizeTimeoutMs = deps.synthesizeTimeoutMs ?? DEFAULT_SYNTHESIZE_TIMEOUT_MS;
    this.localSynthesizeTimeoutMs = deps.localSynthesizeTimeoutMs ?? LOCAL_SYNTHESIZE_TIMEOUT_MS;
  }

  /**
   * Run one command.
   *
   * Resolves with the reply to a `synthesize`, or undefined for every other
   * command and for a synthesis that failed (which was reported as an `error`
   * event).
   */
  async handleCommand(command: OffscreenCommand): Promise<SynthesizeReply | undefined> {
    switch (command.type) {
      case 'synthesize':
        return this.synthesize(command);
      case 'prefetch':
        this.prefetch(command);
        return undefined;
      case 'play':
        await this.play(command.id, command.startTimeMs);
        return undefined;
      case 'pause':
        this.player.pause();
        return undefined;
      case 'setRate':
        this.player.setRate(command.rate);
        return undefined;
      case 'setVolume':
        this.player.setVolume(command.volume);
        return undefined;
      case 'stop':
        this.stop();
        return undefined;
      default: {
        const unhandled: never = command;
        return unhandled;
      }
    }
  }

  /** Abandon whatever is in flight and silence the player. */
  stop(): void {
    this.generation++;
    this.inFlight?.abort();
    this.inFlight = null;
    this.player.stop();
    this.cancelPrefetches();
  }

  private async synthesize(
    command: Extract<OffscreenCommand, { type: 'synthesize' }>
  ): Promise<SynthesizeReply | undefined> {
    const generation = this.supersede();
    const controller = new AbortController();
    this.inFlight = controller;

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutFor(command.config.provider));

    const identity: CacheIdentity = {
      text: command.text,
      voiceId: command.voiceId,
      config: command.config,
    };

    try {
      const key = await this.cacheKey(identity);
      let result = key === null ? undefined : await this.readCache(key);

      if (!result) {
        result = await this.raceAbort(
          this.providerFor(command.config.provider).synthesize(
            { text: command.text, voiceId: command.voiceId, signal: controller.signal },
            command.config
          ),
          controller.signal
        );
        if (this.stale(generation)) return undefined;
        if (key !== null) await this.writeCache(key, result);
      }

      if (this.stale(generation)) return undefined;

      const info = await this.load(command.id, result);
      if (!info) return undefined;
      if (this.stale(generation)) return undefined;

      const reply: SynthesizeReply = {
        durationMs: info.durationMs,
        hasTimings: info.hasTimings,
      };
      this.emit({ type: 'ready', id: command.id, ...reply });
      return reply;
    } catch (error) {
      // A superseded request fails with an abort; that is the point of
      // superseding it, not something to report.
      if (this.stale(generation)) return undefined;
      if (timedOut) {
        this.emitError(command.id, 'network-error', 'the provider did not answer in time');
        return undefined;
      }
      this.emitError(command.id, errorCode(error), errorMessage(error));
      return undefined;
    } finally {
      clearTimeout(timer);
      if (this.inFlight === controller) this.inFlight = null;
    }
  }

  private async play(id: string, startTimeMs: number): Promise<void> {
    try {
      await this.player.play(id, startTimeMs);
    } catch (error) {
      this.emitError(id, 'audio-error', errorMessage(error));
    }
  }

  /**
   * Warm the cache for the sentences the engine expects to play soon.
   *
   * Fire and forget: there is no reply, no `ready`, and — most importantly — no
   * `error` event. The service worker reads a speaker error as "this sentence
   * failed" and degrades to the browser voice, so a background prefetch that
   * fails is only logged.
   */
  private prefetch(command: Extract<OffscreenCommand, { type: 'prefetch' }>): void {
    this.cancelPrefetches();
    this.prefetchConfig = command.config;
    // A newer command replaces the earlier queue. The nearest sentences are the
    // ones about to be needed, so the cap keeps the head and drops the tail.
    this.prefetchQueue = command.items
      .slice(0, MAX_PREFETCH_QUEUE)
      .map((item) => ({ text: item.text, voiceId: item.voiceId }));
    this.pumpPrefetch();
  }

  /**
   * Drop the queue and abort everything in flight.
   *
   * Called by `supersede()` and `stop()`: a seek, a stop, a rate change or a
   * voice change invalidates every prefetch, and a new `prefetch` command
   * replaces the previous queue outright. The controllers are left in the
   * in-flight set so the concurrency count stays honest until they settle.
   */
  private cancelPrefetches(): void {
    this.prefetchBatch++;
    this.prefetchQueue = [];
    this.prefetchConfig = null;
    for (const controller of this.prefetchInFlight) controller.abort();
  }

  /** Start as many queued prefetches as the provider's concurrency allows. */
  private pumpPrefetch(): void {
    const config = this.prefetchConfig;
    if (!config) return;

    const concurrency = prefetchConcurrency(config);
    while (this.prefetchInFlight.size < concurrency) {
      const item = this.prefetchQueue.shift();
      if (!item) return;

      const batch = this.prefetchBatch;
      const controller = new AbortController();
      this.prefetchInFlight.add(controller);
      void this.runPrefetch(batch, controller, item, config).finally(() => {
        this.prefetchInFlight.delete(controller);
        this.pumpPrefetch();
      });
    }
  }

  /** Synthesize one queued sentence into the cache, and nothing else. */
  private async runPrefetch(
    batch: number,
    controller: AbortController,
    item: PrefetchItem,
    config: ProviderConfig
  ): Promise<void> {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutFor(config.provider));

    try {
      const identity: CacheIdentity = { text: item.text, voiceId: item.voiceId, config };
      const key = await this.cacheKey(identity);
      if (key === null || this.prefetchStale(batch)) return;

      // Already warm: synthesizing again would spend a provider call to store
      // the same bytes, which is what makes a second read of an article cheap.
      if (await this.readCache(key)) return;
      if (this.prefetchStale(batch)) return;

      const result = await this.raceAbort(
        this.providerFor(config.provider).synthesize(
          { text: item.text, voiceId: item.voiceId, signal: controller.signal },
          config
        ),
        controller.signal
      );
      if (this.prefetchStale(batch)) return;

      await this.writeCache(key, result);
    } catch (error) {
      // A cancelled prefetch is the point of cancelling it, and a failure is
      // silent: this must never surface as a playback error.
      if (this.prefetchStale(batch)) return;
      if (timedOut) console.warn('[SayLoud] a prefetch did not answer in time');
      else if (!isAbortError(error)) console.warn('[SayLoud] a prefetch failed', error);
    } finally {
      clearTimeout(timer);
    }
  }

  private prefetchStale(batch: number): boolean {
    return batch !== this.prefetchBatch;
  }

  /** How long a synthesis from this provider gets before it is abandoned. */
  private timeoutFor(provider: ProviderId): number {
    return provider === 'local' ? this.localSynthesizeTimeoutMs : this.synthesizeTimeoutMs;
  }

  /**
   * Settle when the signal aborts, even if the work does not.
   *
   * Every cloud adapter honours its signal, because `fetch` does. The on-device
   * engine cannot: `load()` has no signal to honour, so a stop or a seek that
   * arrives while a session is being built would leave this worker awaiting a
   * promise nothing will ever settle. The playback is gone either way, but the
   * request would stay counted as in flight and the next sentence would queue
   * behind a sentence nobody is listening to.
   */
  private raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => reject(abortError());
      // `once` removes it when it fires; the settling paths below remove it.
      signal.addEventListener('abort', onAbort, { once: true });
      work.then(
        (value) => {
          signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        (error: unknown) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        }
      );
    });
  }

  /** Abort the request in flight and return the new generation. */
  private supersede(): number {
    this.generation++;
    this.inFlight?.abort();
    this.inFlight = null;
    this.player.stop();
    // A prefetch is for audio that is about to be needed; once the engine has
    // moved on, every outstanding one is for the wrong sentence.
    this.cancelPrefetches();
    return this.generation;
  }

  private stale(generation: number): boolean {
    return generation !== this.generation;
  }

  /** Decode the audio, reporting a decode failure as an audio error. */
  private async load(id: string, result: SynthesisResult): Promise<LoadedAudioInfo | null> {
    try {
      return await this.player.load(id, result);
    } catch (error) {
      this.emitError(id, 'audio-error', errorMessage(error));
      return null;
    }
  }

  private providerFor(id: ProviderId): Provider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new ProviderError('unknown', `no adapter is registered for the ${id} provider`);
    }
    return provider;
  }

  /**
   * The cache key, or null when it cannot be computed.
   *
   * Caching is an optimisation: a browser without `crypto.subtle`, or a
   * corrupted store, must still be able to play the sentence.
   */
  private async cacheKey(identity: CacheIdentity): Promise<string | null> {
    try {
      return await this.cache.computeKey(identity);
    } catch (error) {
      console.warn('[SayLoud] audio caching is unavailable', error);
      return null;
    }
  }

  private async readCache(key: string): Promise<SynthesisResult | undefined> {
    try {
      return await this.cache.get(key);
    } catch (error) {
      console.warn('[SayLoud] cannot read the audio cache', error);
      return undefined;
    }
  }

  private async writeCache(key: string, result: SynthesisResult): Promise<void> {
    try {
      await this.cache.put(key, result);
    } catch (error) {
      console.warn('[SayLoud] cannot write the audio cache', error);
    }
  }

  private emitError(id: string, code: OffscreenErrorCode, message: string): void {
    // Logged here as well as reported. This document is where the failure
    // happened and its console is the only one a stack can still reach; what
    // the service worker receives is a code and a message, which is enough to
    // act on but not enough to debug with.
    console.error(`[SayLoud] synthesis failed (${code}): ${message}`);
    this.emit({ type: 'error', id, code, message });
  }
}

/** The provider's own code when it has one; the audio errors never get here. */
function errorCode(error: unknown): OffscreenErrorCode {
  if (isProviderError(error)) return error.code;
  if (isAbortError(error)) return 'network-error';
  return 'unknown';
}
