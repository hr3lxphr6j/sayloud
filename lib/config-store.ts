/**
 * Persistence for the provider configuration and the chosen voice.
 *
 * Everything read back is treated as untrusted: `storage.local` is shared with
 * other versions of the extension, so a value that fails validation is reported
 * as "not configured" rather than handed to an adapter. Keys are namespaced so
 * the area stays legible when a user inspects it.
 */
import { parseStoredConfig } from './providers/config-schema';
import type { ProviderConfig, ProviderId } from './providers/types';

/** Every key this module owns. */
const NAMESPACE = 'sayloud:';

export const CONFIG_KEY = `${NAMESPACE}provider-config`;
export const SELECTED_VOICES_KEY = `${NAMESPACE}selected-voices`;

/**
 * The slice of `chrome.storage.local` this module needs.
 *
 * A narrow interface rather than `typeof chrome.storage.local`, so tests can
 * pass a plain object and the module stays free of browser globals — the same
 * reason `SnapshotStore` takes `SessionStorageArea`.
 */
export interface LocalStorageArea {
  get(keys: string | string[]): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

/** The provider configuration and the voice chosen for each provider. */
export class ConfigStore {
  constructor(private readonly area: LocalStorageArea) {}

  /** The active config, or null when none is saved or the saved one is unusable. */
  async getConfig(): Promise<ProviderConfig | null> {
    const stored = await this.area.get(CONFIG_KEY);
    return parseStoredConfig(stored[CONFIG_KEY]);
  }

  /**
   * Replace the active config.
   *
   * There is one config, so saving the browser voice is also how a user drops a
   * stored API key: the whole record is overwritten.
   */
  async saveConfig(config: ProviderConfig): Promise<void> {
    await this.area.set({ [CONFIG_KEY]: config });
  }

  /**
   * The voice id chosen for `provider`, or null.
   *
   * Kept per provider so switching providers, or switching back, does not lose
   * the voice that was picked for each.
   */
  async getSelectedVoice(provider: ProviderId): Promise<string | null> {
    const voices = await this.readSelectedVoices();
    return voices[provider] ?? null;
  }

  /** Remember the voice for one provider, leaving the others alone. */
  async saveSelectedVoice(provider: ProviderId, voiceId: string): Promise<void> {
    const voices = await this.readSelectedVoices();
    voices[provider] = voiceId;
    await this.area.set({ [SELECTED_VOICES_KEY]: voices });
  }

  /** The voice map, with anything that is not a non-empty string discarded. */
  private async readSelectedVoices(): Promise<Record<string, string>> {
    const stored = await this.area.get(SELECTED_VOICES_KEY);
    const raw = stored[SELECTED_VOICES_KEY];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

    const voices: Record<string, string> = {};
    for (const [provider, voiceId] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof voiceId === 'string' && voiceId !== '') voices[provider] = voiceId;
    }
    return voices;
  }
}
