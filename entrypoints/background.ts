import { type Browser, browser } from 'wxt/browser';
import { PlaybackEngine } from '~/lib/playback-engine';
import { PORT_NAME } from '~/lib/port';
import { type RouterPort, SessionRouter } from '~/lib/router';
import { SnapshotStore } from '~/lib/snapshot-store';
import { BrowserSpeaker } from '~/lib/speaker';
import { VoiceCache } from '~/lib/voice-cache';

/** Emitted by WXT from `entrypoints/reader.content.tsx`. */
const CONTENT_SCRIPT = '/content-scripts/reader.js';

declare global {
  /** Test hook, only defined in `--mode e2e` builds. See `tests/e2e/fixtures.ts`. */
  var sayloudActivate: ((tabId?: number) => Promise<void>) | undefined;
}

export default defineBackground(() => {
  const voices = new VoiceCache(browser.tts);
  const engine = new PlaybackEngine({
    speaker: new BrowserSpeaker(browser.tts),
    resolveVoice: (lang) => voices.resolve(lang),
  });
  const router = new SessionRouter({
    engine,
    snapshots: new SnapshotStore(browser.storage.session),
    voices,
  });

  // The engine resolves a voice synchronously per sentence, so the cache has to
  // be refreshed out of band whenever Chrome's voice list changes.
  browser.tts.onVoicesChanged.addListener(() => {
    void voices.refresh();
  });

  // Restores a session left behind by a recycled service worker.
  router.start().catch((error: unknown) => {
    console.error('[SayLoud] failed to start the session router', error);
  });

  browser.action.onClicked.addListener((tab) => {
    void activate(tab.id);
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    router.handlePort(toRouterPort(port));
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    router.handleTabRemoved(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) router.handleTabUpdated(tabId, changeInfo);
  });

  // Only one tab reads at a time, so switching tabs pauses the running session.
  browser.tabs.onActivated.addListener(({ tabId }) => {
    router.handleTabActivated(tabId);
  });

  if (import.meta.env.MODE === 'e2e') {
    globalThis.sayloudActivate = activate;
  }

  /**
   * The content script is registered at runtime rather than declared in the
   * manifest, so nothing is injected until the reader asks for it. `activeTab`
   * grants access to the clicked tab only.
   *
   * Without a tab id this falls back to the active tab, which is what the e2e
   * hook uses: Playwright cannot click the toolbar icon, and it has no way to
   * learn Chrome's tab id for the page it is driving.
   */
  async function activate(tabId?: number): Promise<void> {
    const id = tabId ?? (await activeTabId());
    if (id === undefined) return;
    try {
      await browser.scripting.executeScript({
        target: { tabId: id },
        files: [CONTENT_SCRIPT],
      });
    } catch (error) {
      // Restricted pages (chrome://, the Web Store, PDF viewers) reject
      // injection; there is no reader to show a hint in, so just report it.
      console.warn('[SayLoud] cannot read this page', error);
    }
  }

  async function activeTabId(): Promise<number | undefined> {
    const [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.id;
  }
});

/** `SessionRouter` takes a narrow port interface so it stays testable. */
function toRouterPort(port: Browser.runtime.Port): RouterPort {
  return {
    senderTabId: port.sender?.tab?.id,
    postMessage: (message) => port.postMessage(message),
    onMessage: (handler) => port.onMessage.addListener(handler),
    onDisconnect: (handler) => port.onDisconnect.addListener(handler),
  };
}
