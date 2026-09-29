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
import { errorMessage, isAbortError, isProviderError, ProviderError } from './providers/errors';
import type { Provider, ProviderId, SynthesisResult } from './providers/types';
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
}

export interface AudioWorkerDeps {
  providers: ReadonlyMap<ProviderId, Provider>;
  cache: AudioCache;
  player: AudioTimeline;
  /** Sends an event to the service worker. */
  emit: (event: OffscreenEvent) => void;
  /** How long one synthesis may take before it is abandoned. */
  synthesizeTimeoutMs?: number;
}

/** Long enough for a slow provider on a slow connection. */
const DEFAULT_SYNTHESIZE_TIMEOUT_MS = 30_000;

export class AudioWorker {
  private readonly providers: ReadonlyMap<ProviderId, Provider>;
  private readonly cache: AudioCache;
  private readonly player: AudioTimeline;
  private readonly emit: (event: OffscreenEvent) => void;
  private readonly synthesizeTimeoutMs: number;

  /**
   * Bumped by every command that supersedes work in flight. A synthesis that
   * comes back to find a newer generation drops its result instead of playing
   * over it.
   */
  private generation = 0;
  private inFlight: AbortController | null = null;

  constructor(deps: AudioWorkerDeps) {
    this.providers = deps.providers;
    this.cache = deps.cache;
    this.player = deps.player;
    this.emit = deps.emit;
    this.synthesizeTimeoutMs = deps.synthesizeTimeoutMs ?? DEFAULT_SYNTHESIZE_TIMEOUT_MS;
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
      case 'play':
        await this.play(command.id, command.startTimeMs);
        return undefined;
      case 'pause':
        this.player.pause();
        return undefined;
      case 'setRate':
        this.player.setRate(command.rate);
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
    }, this.synthesizeTimeoutMs);

    const identity: CacheIdentity = {
      text: command.text,
      voiceId: command.voiceId,
      config: command.config,
    };

    try {
      const key = await this.cacheKey(identity);
      let result = key === null ? undefined : await this.readCache(key);

      if (!result) {
        result = await this.providerFor(command.config.provider).synthesize(
          { text: command.text, voiceId: command.voiceId, signal: controller.signal },
          command.config
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

  /** Abort the request in flight and return the new generation. */
  private supersede(): number {
    this.generation++;
    this.inFlight?.abort();
    this.inFlight = null;
    this.player.stop();
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
    this.emit({ type: 'error', id, code, message });
  }
}

/** The provider's own code when it has one; the audio errors never get here. */
function errorCode(error: unknown): OffscreenErrorCode {
  if (isProviderError(error)) return error.code;
  if (isAbortError(error)) return 'network-error';
  return 'unknown';
}
