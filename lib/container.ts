import { ConfigStore, type LocalStorageArea } from './config-store';
import { type OffscreenApi, OffscreenManager, type RuntimeApi } from './offscreen-manager';
import { OffscreenSpeaker, type RuntimeEventSource } from './offscreen-speaker';
import { PlaybackEngine } from './playback-engine';
import { SessionRouter } from './router';
import { SettingsStore, type StorageChangeApi } from './settings-store';
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
  storage: {
    session: SessionStorageArea;
    local: LocalStorageArea & { remove(key: string): Promise<void> };
    /** Where the settings store hears about changes; absent in tests. */
    onChanged?: StorageChangeApi;
  };
  offscreen?: OffscreenDeps;
}

/** The application container holding all core services. */
export interface AppContainer {
  router: SessionRouter;
  voices: VoiceCache;
  engine: PlaybackEngine;
  snapshots: SnapshotStore;
  speakers: SpeakerRouter;
  settings: SettingsStore;
  /**
   * Resolves once the saved settings and provider configuration have been read.
   *
   * Reading them is asynchronous while `createApp` is not, and the engine
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
  const snapshots = new SnapshotStore(deps.storage.session, deps.storage.local);
  const config = new ConfigStore(deps.storage.local);
  const settings = new SettingsStore(deps.storage.local, deps.storage.onChanged);

  const browserSpeaker = new BrowserSpeaker(deps.tts);
  const offscreenManager = deps.offscreen
    ? new OffscreenManager({ offscreen: deps.offscreen.offscreen, runtime: deps.offscreen.runtime })
    : null;

  const speakers = new SpeakerRouter({
    browser: browserSpeaker,
    config,
    resolveBrowserVoice: (lang) => voices.resolve(lang),
    createCloud: (providerConfig) => {
      if (!deps.offscreen || !offscreenManager) return null;
      return new OffscreenSpeaker({
        manager: offscreenManager,
        config: providerConfig,
        events: deps.offscreen.events,
      });
    },
  });

  const engine = new PlaybackEngine({
    speaker: speakers,
    resolveVoice: (lang) => speakers.resolveVoice(lang),
  });

  const router = new SessionRouter({ engine, snapshots, voices });

  // Both are storage reads that the first sentence waits on. A settings read
  // that fails must not be able to stop the reader from starting, so it leaves
  // the defaults in place instead.
  const ready = Promise.all([
    settings.load().catch((error: unknown) => {
      console.error('[SayLoud] cannot read the saved settings', error);
    }),
    speakers
      .refresh()
      .then(() => engine.clearConfigurationError())
      .catch((error: unknown) => {
        // If the provider has no voice selected, fail the engine immediately.
        console.error('[SayLoud] speaker refresh failed:', error);
        engine.reportError(error instanceof Error ? error.message : String(error));
      }),
  ]).then(() => undefined);

  return { router, voices, engine, snapshots, speakers, settings, ready };
}
