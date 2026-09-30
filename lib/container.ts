import { ConfigStore, type LocalStorageArea } from './config-store';
import { type OffscreenApi, OffscreenManager, type RuntimeApi } from './offscreen-manager';
import { OffscreenSpeaker, type RuntimeEventSource } from './offscreen-speaker';
import { PlaybackEngine } from './playback-engine';
import { SessionRouter } from './router';
import { type SessionStorageArea, SnapshotStore } from './snapshot-store';
import { BrowserSpeaker, type TtsApi } from './speaker';
import { SpeakerRouter } from './speaker-router';
import { VoiceCache } from './voice-cache';

/**
 * The offscreen document, as the service worker sees it.
 *
 * Absent when the app is built without it — which is what keeps `createApp`
 * callable from tests with two fakes and no browser APIs at all.
 */
export interface OffscreenDeps {
  offscreen: OffscreenApi;
  runtime: RuntimeApi;
  /** `chrome.runtime.onMessage`, where the document's events arrive. */
  events: RuntimeEventSource;
}

/**
 * External dependencies the app needs from the browser.
 *
 * These are the narrow interfaces the services already depend on rather than
 * `typeof chrome.tts` / `typeof chrome.storage`: the extension bundles for
 * several browsers, and a narrow slice keeps `createApp` callable from tests
 * with plain fakes.
 */
export interface AppDeps {
  tts: TtsApi;
  storage: { session: SessionStorageArea; local: LocalStorageArea };
  offscreen?: OffscreenDeps;
}

/** The application container holding all core services. */
export interface AppContainer {
  router: SessionRouter;
  voices: VoiceCache;
  engine: PlaybackEngine;
  snapshots: SnapshotStore;
  speakers: SpeakerRouter;
  /**
   * Resolves once the saved provider configuration has been read.
   *
   * Reading it is asynchronous while `createApp` is not, and the engine
   * resolves a voice synchronously. Whoever starts a session waits for this
   * first, so the first sentence is not spoken in the wrong voice.
   */
  ready: Promise<void>;
}

/**
 * Creates the application container with all dependencies injected.
 *
 * This factory is the single place where concrete implementations are
 * instantiated, so tests can build the whole graph over fakes and the service
 * worker only wires events.
 */
export function createApp(deps: AppDeps): AppContainer {
  const voices = new VoiceCache(deps.tts);
  const snapshots = new SnapshotStore(deps.storage.session);
  const config = new ConfigStore(deps.storage.local);

  // Two separate browser speakers: one is the router's fallback delegate, the
  // other is the engine's last resort when the cloud service fails. Sharing one
  // would mean the engine's fallback is disposed along with the router.
  const browserSpeaker = new BrowserSpeaker(deps.tts);
  const fallbackSpeaker = new BrowserSpeaker(deps.tts);

  const speakers = new SpeakerRouter({
    browser: browserSpeaker,
    config,
    resolveBrowserVoice: (lang) => voices.resolve(lang),
    createCloud: (providerConfig) => {
      if (!deps.offscreen) return null;
      return new OffscreenSpeaker({
        manager: new OffscreenManager({
          offscreen: deps.offscreen.offscreen,
          runtime: deps.offscreen.runtime,
        }),
        config: providerConfig,
        events: deps.offscreen.events,
      });
    },
  });

  const engine = new PlaybackEngine({
    speaker: speakers,
    // A cloud service that fails — a bad key, an exhausted quota, a network
    // that dropped — degrades to the browser voice rather than stopping.
    fallbackSpeaker,
    resolveVoice: (lang) => speakers.resolveVoice(lang),
    // The router answers with a cloud voice id while a provider is selected,
    // which the browser speaker cannot use.
    resolveFallbackVoice: (lang) => voices.resolve(lang),
  });

  const router = new SessionRouter({ engine, snapshots, voices });

  return { router, voices, engine, snapshots, speakers, ready: speakers.refresh() };
}
