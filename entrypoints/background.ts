import { type Browser, browser } from 'wxt/browser';
import { cachePolicyChanged, cachePolicyMessage, pushCachePolicy } from '~/lib/cache-policy';
import { CONFIG_KEY, SELECTED_VOICES_KEY } from '~/lib/config-store';
import { createApp } from '~/lib/container';
import { KOKORO_82M } from '~/lib/models/registry';
import { modelSourceMessage } from '~/lib/models/source-channel';
import { ModelStore } from '~/lib/models/store';
import { isCachePolicyRequest, isModelSourceRequest } from '~/lib/offscreen-protocol';
import { isOpenSettingsMessage, openSettingsFor } from '~/lib/open-settings';
import { PORT_NAME } from '~/lib/port';
import type { RouterPort } from '~/lib/router';
import { applyPlaybackSettings } from '~/lib/settings-effects';
import { DEFAULT_SETTINGS, type Settings } from '~/lib/settings-store';

/** Emitted by WXT from `entrypoints/reader.content.tsx`. */
const CONTENT_SCRIPT = '/content-scripts/reader.js';

declare global {
  /** Test hook, only defined in `--mode e2e` builds. See `tests/e2e/fixtures.ts`. */
  var sayloudActivate: ((tabId?: number) => Promise<void>) | undefined;
}

export default defineBackground(() => {
  // Silence chrome.tts in E2E tests — the real system voice is noisy and
  // distracting. Wrap speak() to force volume to 0; everything else passes through.
  const tts =
    import.meta.env.MODE === 'e2e'
      ? {
          ...browser.tts,
          speak: (utterance: string, options?: Parameters<typeof browser.tts.speak>[1]) => {
            browser.tts.speak(utterance, { ...(options ?? {}), volume: 0 });
          },
        }
      : browser.tts;

  const app = createApp({
    tts,
    storage: browser.storage,
    offscreen: {
      offscreen: browser.offscreen,
      runtime: browser.runtime,
      events: browser.runtime.onMessage,
    },
  });

  // Track which tabs have active content scripts via their port connections.
  const activeTabs = new Set<number>();

  // The settings are read once and then kept in step through `onChanged`:
  // `tabs.onActivated` needs the current value synchronously, and a storage
  // read there could let a pause land after a newer session had started.
  // Until the first read lands, the defaults are what a tab switch sees.
  let settings: Settings = DEFAULT_SETTINGS;
  const applySettings = (next: Settings): void => {
    const previous = settings;
    settings = next;
    applyPlaybackSettings(app.engine, previous, next);
    // An offscreen document cannot read `storage`, so a cache change has to be
    // pushed to it. The same subscription carries every other preference, and
    // those are no reason to disturb a document that is playing audio.
    if (cachePolicyChanged(previous, next)) {
      void pushCachePolicy(browser.runtime, next.cache);
    }
  };
  app.settings.subscribe(applySettings);
  void app.settings
    .load()
    .then(applySettings)
    .catch((error: unknown) => {
      console.error('[SayLoud] cannot apply the saved settings', error);
    });

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
    void app.speakers
      .refresh()
      .then(() => app.engine.clearConfigurationError())
      .catch((error: unknown) => {
        console.error('[SayLoud] cannot apply the saved provider configuration', error);
      });
  });

  // Restores a session left behind by a recycled service worker. The router
  // refreshes the voice cache itself, so a restart picks up new voices too.
  app.router.start().catch((error: unknown) => {
    console.error('[SayLoud] failed to start the session router', error);
  });

  browser.action.onClicked.addListener((tab) => {
    void activate(tab.id);
  });

  // The reader's gear. `sidePanel.open()` is called before anything is awaited
  // so the click's transient activation is still live — see `open-settings.ts`.
  browser.runtime.onMessage.addListener((message, sender) => {
    if (!isOpenSettingsMessage(message)) return;
    const tabId = sender.tab?.id;
    if (tabId === undefined) return;
    openSettingsFor(tabId, { sidePanel: browser.sidePanel, options: browser.runtime });
  });

  // The cache policy for an offscreen document that is starting up.
  //
  // It cannot read the settings itself: Chrome exposes `runtime` and `offscreen`
  // to an offscreen document, and not `storage`. Answering the request means the
  // document has the policy before its first sentence, however many times Chrome
  // has closed it in between.
  browser.runtime.onMessage.addListener((message) => {
    if (!isCachePolicyRequest(message)) return;
    return Promise.resolve(cachePolicyMessage(settings.cache));
  });

  // Where the on-device engine downloads from. Same problem, same answer: the
  // choice is in `storage`, and the offscreen document cannot read it.
  //
  // The service worker resolves `auto` here rather than handing the setting
  // down, because resolving means probing both mirrors and remembering the
  // winner — and only this context has the storage that remembers.
  const models = new ModelStore({ storage: browser.storage.local });
  browser.runtime.onMessage.addListener((message) => {
    if (!isModelSourceRequest(message)) return;
    return resolveDownloadSource();
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

  // Switching tabs only pauses when the user asked it to; the router owns that
  // rule so it stays unit-tested.
  browser.tabs.onActivated.addListener(({ tabId }) => {
    app.router.handleTabActivated(tabId, settings.keepPlayingInBackground);
  });

  if (import.meta.env.MODE === 'e2e') {
    globalThis.sayloudActivate = activate;
  }

  /**
   * The download source the offscreen document should use.
   *
   * `resolveSource` may probe both mirrors, which is why it lives here: the
   * probe remembers its winner in storage, and the offscreen document has no
   * storage. A probe that fails entirely is not fatal — if the model is already
   * cached nothing is fetched at all — so it degrades to Hugging Face with the
   * retry allowed rather than refusing to answer.
   */
  async function resolveDownloadSource(): Promise<ReturnType<typeof modelSourceMessage>> {
    const setting = await models.getSource();
    try {
      return modelSourceMessage(await models.resolveSource(KOKORO_82M), setting.host === 'auto');
    } catch (error) {
      console.warn('[SayLoud] no download source answered; falling back', error);
      return modelSourceMessage({ host: 'huggingface' }, true);
    }
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
