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
 * The readable name of a voice the user has picked from a list, by provider.
 *
 * A separate key from `SELECTED_VOICES_KEY` on purpose: the id is the choice,
 * the name is decoration, and adding decoration must not need the stored choice
 * to be migrated.
 */
export const VOICE_NAMES_KEY = `${NAMESPACE}voice-names`;

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

/** Voices the user picked from a list, provider → voice id → the listed name. */
export type VoiceNames = Record<string, Record<string, string>>;

/** The provider configuration and the voice chosen for each provider. */
export class ConfigStore {
  constructor(private readonly area: LocalStorageArea) {}

  /** The active config, or null when none is saved or the saved one is unusable. */
  async getConfig(): Promise<ProviderConfig | null> {
    const stored = await this.area.get(CONFIG_KEY);
    return parseStoredConfig(stored[CONFIG_KEY]);
  }

  /**
   * Remember `config` for its provider, without changing what is in use.
   *
   * Every provider keeps its own last-saved config, key included, so switching
   * to another provider and back does not mean typing the key in again. A key
   * is dropped with `forgetConfig`, not by switching away. Which provider is
   * *used* is a separate choice (`setActiveConfig`), so pressing Save on a
   * provider the user is not reading with cannot change what they hear.
   */
  async saveConfig(config: ProviderConfig): Promise<void> {
    const saved = await this.getSavedConfigs();
    if (config.provider !== 'browser') saved[config.provider] = config;
    await this.area.set({ [PROVIDER_CONFIGS_KEY]: saved });
  }

  /**
   * Make one provider the active one, from the config it was last saved with.
   *
   * Returns false, and writes nothing, when that provider has nothing saved:
   * the browser voice is the only one that can be activated without a config,
   * and inventing an empty one for the others would only fail later, mid-read.
   */
  async setActiveConfig(provider: ProviderId): Promise<boolean> {
    if (provider === 'browser') {
      await this.area.set({ [CONFIG_KEY]: { provider: 'browser' } });
      return true;
    }

    const config = (await this.getSavedConfigs())[provider];
    if (!config) return false;

    await this.area.set({ [CONFIG_KEY]: config });
    return true;
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

  /**
   * Every chosen voice at once, by provider.
   *
   * The settings list shows a voice for each configured provider, and asking
   * per row would read the same storage key once per provider.
   */
  getSelectedVoices(): Promise<Record<string, string>> {
    return this.readSelectedVoices();
  }

  /** Remember the voice for one provider, leaving the others alone. */
  async saveSelectedVoice(provider: ProviderId, voiceId: string): Promise<void> {
    const voices = await this.readSelectedVoices();
    voices[provider] = voiceId;
    await this.area.set({ [SELECTED_VOICES_KEY]: voices });
  }

  /**
   * The names of voices the user has picked from a list, by provider.
   *
   * Picked, not looked up: a provider's catalogue costs a network call, and the
   * row summary and the voice card have to render without one. A voice typed in
   * by id was never listed, so it has no name here and shows its id instead.
   */
  async getVoiceNames(): Promise<VoiceNames> {
    const stored = await this.area.get(VOICE_NAMES_KEY);
    const raw = stored[VOICE_NAMES_KEY];
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {};

    const names: VoiceNames = {};
    for (const [provider, value] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) continue;
      const voices: Record<string, string> = {};
      for (const [voiceId, name] of Object.entries(value as Record<string, unknown>)) {
        if (typeof name === 'string' && name !== '') voices[voiceId] = name;
      }
      if (Object.keys(voices).length > 0) names[provider] = voices;
    }
    return names;
  }

  /** Remember what one voice was called in the list it was picked from. */
  async saveVoiceName(provider: ProviderId, voiceId: string, name: string): Promise<void> {
    if (voiceId === '' || name === '') return;

    const names = await this.getVoiceNames();
    names[provider] = { ...names[provider], [voiceId]: name };
    await this.area.set({ [VOICE_NAMES_KEY]: names });
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
