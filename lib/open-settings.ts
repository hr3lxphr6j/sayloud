/**
 * The reader's "open the settings panel" request.
 *
 * The gear in the 28px bar cannot open the panel itself. `chrome.sidePanel` is
 * one of the APIs a content script is not given — it sees `runtime`, `i18n`,
 * `storage` and `dom` and nothing else — so the call has to happen in the
 * service worker. The reader sends this message and the worker opens the panel.
 *
 * Both hops must be synchronous. `sidePanel.open()` consumes the click's
 * transient activation, and Chrome's window for that is roughly five seconds:
 * A trusted click was measured working immediately and after 1.5s, and failing
 * after 6s, on page load, or when the worker called the API on its own. So the
 * click handler calls `sendMessage` without awaiting anything, and the listener
 * below calls `sidePanel.open()` before it awaits anything. An `await` on
 * either side spends the gesture and the panel silently does not open.
 */

/** The message type, namespaced so it cannot collide with engine traffic. */
export const OPEN_SETTINGS = 'sayloud:open-settings';

export interface OpenSettingsMessage {
  type: typeof OPEN_SETTINGS;
}

export function isOpenSettingsMessage(value: unknown): value is OpenSettingsMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === OPEN_SETTINGS
  );
}

/** `chrome.sidePanel`, narrowed to the one call this module makes. */
export interface SidePanelApi {
  open(options: { tabId: number }): Promise<void>;
}

/** `chrome.runtime`, narrowed to the fallback. */
export interface OptionsPageApi {
  openOptionsPage(): Promise<void>;
}

export interface OpenSettingsDeps {
  sidePanel: SidePanelApi;
  options: OptionsPageApi;
}

/**
 * Show the settings panel for `tabId`.
 *
 * Returns immediately: the caller is a message listener, and awaiting here
 * would be harmless for the gesture (the call below already happened) but would
 * keep the listener's response channel open for no reason.
 *
 * The panel is opened per tab rather than per window so it follows the tab the
 * reader is running in — clicking the gear on one tab must not replace the
 * panel showing another tab's settings.
 */
export function openSettingsFor(tabId: number, deps: OpenSettingsDeps): void {
  deps.sidePanel.open({ tabId }).catch((error: unknown) => {
    // The realistic failure is an expired gesture: the click was more than
    // ~5s ago, or something awaited before this ran. The settings are also
    // reachable as a full page, which needs no gesture, so send the user there
    // rather than leaving the click with no visible effect.
    console.warn(
      '[SayLoud] could not open the side panel, falling back to the options page',
      error
    );
    void deps.options.openOptionsPage().catch((fallbackError: unknown) => {
      console.error('[SayLoud] could not open the settings page either', fallbackError);
    });
  });
}
