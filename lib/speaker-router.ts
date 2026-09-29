/**
 * Decides which voice actually speaks (spec §6).
 *
 * The engine holds one speaker for its whole life, so the choice between the
 * browser voice and a cloud provider cannot be made by swapping the object the
 * engine points at. This router is that one object: it re-reads the saved
 * configuration when it changes and delegates every call to whichever speaker
 * the configuration selects, forwarding events so the engine cannot tell the
 * difference.
 *
 * It also answers the engine's "which voice for this sentence" question, which
 * has to come from the same place: a cloud voice is a provider voice id chosen
 * in the settings, and a browser voice is a name from `chrome.tts.getVoices()`.
 * Keeping both in one object is what keeps the speaker and the voice in step.
 *
 * A cloud provider with no voice selected falls back to the browser voice: the
 * configuration says where the audio should come from, but with no voice there
 * is nothing to ask for, and refusing to read at all would be worse than
 * reading in the browser's voice.
 */
import type { ProviderConfig, ProviderId } from './providers/types';
import type { Speaker, SpeakerEvents, SpeakRequest } from './speaker';

type Handler = (payload: never) => void;

/** The saved configuration, as the router needs it. `ConfigStore` fits. */
export interface ConfigSource {
  getConfig(): Promise<ProviderConfig | null>;
  getSelectedVoice(provider: ProviderId): Promise<string | null>;
}

export interface SpeakerRouterDeps {
  /** The P1 browser voice, used whenever no cloud provider is ready. */
  browser: Speaker;
  config: ConfigSource;
  /** Builds the cloud speaker for a config, or null when this build has none. */
  createCloud: (config: ProviderConfig) => Speaker | null;
  /** Resolves a browser voice name for a language, from the voice cache. */
  resolveBrowserVoice: (lang: string) => string | undefined;
}

interface CloudSelection {
  config: ProviderConfig;
  speaker: Speaker;
  voice: string;
}

export class SpeakerRouter implements Speaker {
  private readonly browser: Speaker;
  private readonly config: ConfigSource;
  private readonly createCloud: (config: ProviderConfig) => Speaker | null;
  private readonly resolveBrowserVoice: (lang: string) => string | undefined;
  private readonly listeners = new Map<keyof SpeakerEvents, Set<Handler>>();

  private cloud: CloudSelection | null = null;
  private active: Speaker;
  private unbind: (() => void) | null = null;
  /** True between the active speaker's `start` and its `end`. */
  private speaking = false;

  constructor(deps: SpeakerRouterDeps) {
    this.browser = deps.browser;
    this.config = deps.config;
    this.createCloud = deps.createCloud;
    this.resolveBrowserVoice = deps.resolveBrowserVoice;
    this.active = deps.browser;
    this.bind();
  }

  /** The provider that is speaking: a cloud id, or `browser`. */
  get provider(): ProviderId {
    return this.cloud?.config.provider ?? 'browser';
  }

  /** True when a cloud provider is the one speaking. */
  get isCloud(): boolean {
    return this.cloud !== null;
  }

  /**
   * Re-read the saved configuration and switch speakers if it changed.
   *
   * Never rejects: the router is what the service worker awaits before it can
   * read anything, so an unreadable configuration, or a cloud provider with no
   * voice chosen, has to leave the browser voice in place rather than break
   * playback.
   */
  async refresh(): Promise<void> {
    try {
      const config = await this.config.getConfig();
      const provider = config?.provider ?? 'browser';

      if (!config || provider === 'browser') {
        this.useBrowser();
        return;
      }

      const voice = await this.config.getSelectedVoice(provider);
      if (!voice) {
        // Only worth saying once per provider: this runs on every save.
        if (!this.isCloud || this.provider !== provider) {
          console.warn(`[SayLoud] no voice is selected for ${provider}; using the browser voice`);
        }
        this.useBrowser();
        return;
      }

      if (this.unchanged(config, voice)) return;

      const speaker = this.createCloud(config);
      if (!speaker) {
        console.warn(`[SayLoud] the ${provider} provider is unavailable; using the browser voice`);
        this.useBrowser();
        return;
      }

      const replaced = this.cloud;
      // The selection is published before the switch: switching can hand the
      // engine its next sentence, and that sentence has to be resolved with the
      // voice that is about to speak it.
      this.cloud = { config, speaker, voice };
      this.switchTo(speaker);
      // The replaced speaker has no caller left, so its runtime listener has to
      // go with it. A speaker that is still the active one is not disposed: the
      // factory is free to hand back the same object.
      if (replaced && replaced.speaker !== speaker) replaced.speaker.dispose();
    } catch (error) {
      // The service worker awaits this before it will read anything, so it must
      // not reject: a configuration that cannot be read, or a speaker that
      // cannot be built, leaves the browser voice in place.
      console.error('[SayLoud] cannot apply the saved provider configuration', error);
      this.useBrowser();
    }
  }

  /**
   * The voice for a sentence.
   *
   * A cloud provider speaks one configured voice for every sentence; the
   * browser voice is picked per language.
   */
  resolveVoice(lang: string): string | undefined {
    if (this.cloud) return this.cloud.voice;
    return this.resolveBrowserVoice(lang);
  }

  speak(request: SpeakRequest): void {
    this.active.speak(request);
  }

  stop(): void {
    this.speaking = false;
    this.active.stop();
  }

  on<K extends keyof SpeakerEvents>(
    event: K,
    handler: (payload: SpeakerEvents[K]) => void
  ): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler as Handler);
    return () => {
      handlers.delete(handler as Handler);
    };
  }

  dispose(): void {
    this.speaking = false;
    this.active.stop();

    // The engine disposes the speaker it is leaving and then asks this router
    // to resolve the voice for the sentence it replays on the fallback. With
    // the cloud selection dropped, that answer is a browser voice name — which
    // is the only kind of name the browser speaker can use.
    const cloud = this.cloud;
    this.cloud = null;

    this.unbind?.();
    this.unbind = null;
    this.listeners.clear();

    cloud?.speaker.dispose();
    this.browser.dispose();
  }

  /** Whether the cloud selection already matches what was just read. */
  private unchanged(config: ProviderConfig, voice: string): boolean {
    const current = this.cloud;
    if (!current || current.voice !== voice) return false;
    // Both configs come from the same parser, which builds its fields in a
    // fixed order, so comparing their JSON compares their values.
    return JSON.stringify(current.config) === JSON.stringify(config);
  }

  private useBrowser(): void {
    const previous = this.cloud;
    if (!previous) return;

    this.cloud = null;
    this.switchTo(this.browser);
    previous.speaker.dispose();
  }

  /**
   * Make `next` the speaker.
   *
   * The outgoing speaker is stopped first: a provider change mid-sentence would
   * otherwise leave its audio playing with nothing able to stop it, because the
   * router is the only handle the engine has on it.
   *
   * A sentence that was cut off will never end on its own, and the engine waits
   * for that end before it moves on — so the router reports it, and playback
   * continues with the next sentence on the new voice. Nothing is reported when
   * the engine is not mid-sentence, which is what keeps a paused session paused.
   */
  private switchTo(next: Speaker): void {
    const wasSpeaking = this.speaking;
    this.speaking = false;

    this.active.stop();
    this.unbind?.();
    this.active = next;
    this.bind();

    if (wasSpeaking) this.emit('end', undefined);
  }

  private bind(): void {
    const subscriptions = [
      this.active.on('start', (payload) => {
        this.speaking = true;
        this.emit('start', payload);
      }),
      this.active.on('word', (payload) => this.emit('word', payload)),
      this.active.on('end', () => {
        this.speaking = false;
        this.emit('end', undefined);
      }),
      this.active.on('error', (payload) => {
        this.speaking = false;
        this.emit('error', payload);
      }),
    ];
    this.unbind = () => {
      for (const unsubscribe of subscriptions) unsubscribe();
    };
  }

  private emit<K extends keyof SpeakerEvents>(event: K, payload: SpeakerEvents[K]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      (handler as (value: SpeakerEvents[K]) => void)(payload);
    }
  }
}
