import { type Browser, browser } from 'wxt/browser';
import { CONFIG_KEY, SELECTED_VOICES_KEY } from '~/lib/config-store';
import { createApp } from '~/lib/container';
import { PORT_NAME } from '~/lib/port';
import type { RouterPort } from '~/lib/router';

/** Emitted by WXT from `entrypoints/reader.content.tsx`. */
const CONTENT_SCRIPT = '/content-scripts/reader.js';

declare global {
  /** Test hook, only defined in `--mode e2e` builds. See `tests/e2e/fixtures.ts`. */
  var sayloudActivate: ((tabId?: number) => Promise<void>) | undefined;
}

export default defineBackground(() => {
  const app = createApp({
    tts: browser.tts,
    storage: browser.storage,
    offscreen: {
      offscreen: browser.offscreen,
      runtime: browser.runtime,
      events: browser.runtime.onMessage,
    },
  });

  // Track which tabs have active content scripts via their port connections.
  const activeTabs = new Set<number>();

  // The engine resolves a voice synchronously per sentence, so the cache has to
  // be refreshed out of band whenever Chrome's voice list changes.
  browser.tts.onVoicesChanged.addListener(() => {
    void app.voices.refresh();
  });

  // The provider and the chosen voice decide which speaker is speaking, so a
  // save in the settings panel has to reach the router without a reload.
  browser.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local') return;
    if (!(CONFIG_KEY in changes) && !(SELECTED_VOICES_KEY in changes)) return;
    void app.speakers.refresh();
  });

  // Restores a session left behind by a recycled service worker. The router
  // refreshes the voice cache itself, so a restart picks up new voices too.
  app.router.start().catch((error: unknown) => {
    console.error('[SayLoud] failed to start the session router', error);
  });

  browser.action.onClicked.addListener((tab) => {
    void activate(tab.id);
  });

  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== PORT_NAME) return;
    const tabId = port.sender?.tab?.id;
    if (tabId !== undefined) activeTabs.add(tabId);

    app.router.handlePort(toRouterPort(port));

    port.onDisconnect.addListener(() => {
      if (tabId !== undefined) activeTabs.delete(tabId);
    });
  });

  browser.tabs.onRemoved.addListener((tabId) => {
    app.router.handleTabRemoved(tabId);
    activeTabs.delete(tabId);
  });

  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.url) {
      app.router.handleTabUpdated(tabId, changeInfo);
      // Navigation resets the content script, so treat it as gone.
      activeTabs.delete(tabId);
    }
  });

  // Only one tab reads at a time, so switching tabs pauses the running session.
  browser.tabs.onActivated.addListener(({ tabId }) => {
    app.router.handleTabActivated(tabId);
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
   *
   * Clicking the icon again when the reader is already mounted is a no-op,
   * not a replay from the beginning.
   */
  async function activate(tabId?: number): Promise<void> {
    const id = tabId ?? (await activeTabId());
    if (id === undefined) return;

    // If the tab already has an active port, the content script is running.
    if (activeTabs.has(id)) {
      console.log('[SayLoud] content script already active in tab', id);
      return;
    }

    // The reader starts speaking as soon as it connects, and the voice it gets
    // depends on the saved provider: reading that is asynchronous, so wait for
    // it before there is anything to read with.
    await app.ready;

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
