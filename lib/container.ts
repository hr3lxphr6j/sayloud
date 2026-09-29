import { PlaybackEngine } from './playback-engine';
import { SessionRouter } from './router';
import { type SessionStorageArea, SnapshotStore } from './snapshot-store';
import { BrowserSpeaker, type TtsApi } from './speaker';
import { VoiceCache } from './voice-cache';

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
  storage: { session: SessionStorageArea };
  // P2 will add: offscreen?: typeof browser.offscreen;
}

/** The application container holding all core services. */
export interface AppContainer {
  router: SessionRouter;
  voices: VoiceCache;
  engine: PlaybackEngine;
  snapshots: SnapshotStore;
}

/**
 * Creates the application container with all dependencies injected.
 *
 * This factory is the single place where concrete implementations are
 * instantiated, so tests can build the whole graph over fakes and P2 can swap
 * in cloud speakers without touching the service worker.
 */
export function createApp(deps: AppDeps): AppContainer {
  const voices = new VoiceCache(deps.tts);
  const snapshots = new SnapshotStore(deps.storage.session);
  const speaker = new BrowserSpeaker(deps.tts);

  const engine = new PlaybackEngine({
    speaker,
    // P1 has no fallback: the browser voice is the only speaker available.
    // P2 will pass `fallbackSpeaker: new BrowserSpeaker(deps.tts)` so a failing
    // cloud service degrades to the browser voice instead of stopping.
    resolveVoice: (lang) => voices.resolve(lang),
  });

  const router = new SessionRouter({ engine, snapshots, voices });

  return { router, voices, engine, snapshots };
}
