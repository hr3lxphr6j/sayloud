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

/** The active config: the one the service worker speaks with. */
export const CONFIG_KEY = `${NAMESPACE}provider-config`;
/** The last config saved for each cloud provider, active or not. */
export const PROVIDER_CONFIGS_KEY = `${NAMESPACE}provider-configs`;
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

/** Saved configs by provider; the browser voice has nothing to save. */
export type SavedConfigs = Partial<Record<ProviderId, ProviderConfig>>;

/** The provider configuration and the voice chosen for each provider. */
export class ConfigStore {
  constructor(private readonly area: LocalStorageArea) {}

  /** The active config, or null when none is saved or the saved one is unusable. */
  async getConfig(): Promise<ProviderConfig | null> {
    const stored = await this.area.get(CONFIG_KEY);
    return parseStoredConfig(stored[CONFIG_KEY]);
  }

  /**
   * Make `config` the active one, and remember it for its provider.
   *
   * Every provider keeps its own last-saved config, key included, so switching
   * to another provider and back does not mean typing the key in again. A key
   * is dropped with `forgetConfig`, not by switching away.
   */
  async saveConfig(config: ProviderConfig): Promise<void> {
    const saved = await this.getSavedConfigs();
    if (config.provider !== 'browser') saved[config.provider] = config;
    await this.area.set({ [CONFIG_KEY]: config, [PROVIDER_CONFIGS_KEY]: saved });
  }

  /**
   * The last config saved for each provider, valid entries only.
   *
   * A config saved before configs were kept per provider is counted too, so
   * upgrading does not hide the key the user already entered.
   */
  async getSavedConfigs(): Promise<SavedConfigs> {
    const stored = await this.area.get([CONFIG_KEY, PROVIDER_CONFIGS_KEY]);
    const saved: SavedConfigs = {};

    const raw = stored[PROVIDER_CONFIGS_KEY];
    if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
      for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
        const config = parseStoredConfig(value);
        // Filed under the wrong provider is as unusable as malformed.
        if (config && config.provider === provider && provider !== 'browser') {
          saved[config.provider] = config;
        }
      }
    }

    const active = parseStoredConfig(stored[CONFIG_KEY]);
    if (active && active.provider !== 'browser' && !saved[active.provider]) {
      saved[active.provider] = active;
    }
    return saved;
  }

  /**
   * Delete the saved config (and key) for one provider.
   *
   * If it is the active one, the browser voice takes over: an active config
   * whose key the user just deleted must not keep being used.
   */
  async forgetConfig(provider: ProviderId): Promise<void> {
    const saved = await this.getSavedConfigs();
    delete saved[provider];

    const items: Record<string, unknown> = { [PROVIDER_CONFIGS_KEY]: saved };
    const active = await this.getConfig();
    if (active?.provider === provider) items[CONFIG_KEY] = { provider: 'browser' };
    await this.area.set(items);
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
