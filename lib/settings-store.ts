/**
 * The extension's behaviour preferences, as opposed to the provider
 * configuration `ConfigStore` holds.
 *
 * Everything read back is treated as untrusted, and for a stronger reason than
 * elsewhere: this store is the only place a user's own choice is written, and
 * `storage.local` is shared with other versions of the extension. So `load()`
 * normalizes rather than validates: a missing or malformed field falls back to
 * its default, and a numeric one is clamped instead of rejected. A preference
 * that cannot be read must never break playback.
 *
 * Each context (the service worker, the side panel, the content script) builds
 * its own store over the same area and keeps in step through `storage.onChanged`
 * rather than by sharing an object.
 */
import type { LocalStorageArea } from './config-store';

export const SETTINGS_KEY = 'sayloud:settings';

export type UiLang = 'auto' | 'en' | 'zh-CN';

export interface CacheSettings {
  /** Off means memory only: saved audio is cleared and nothing new is written. */
  persist: boolean;
  maxBytes: number;
}

export interface Settings {
  /** `'auto'` follows the browser's language. */
  uiLang: UiLang;
  /** Keep reading when the user switches to another tab. */
  keepPlayingInBackground: boolean;
  /** Whether the bar shows a button that opens the caption window. */
  captionWindow: boolean;
  /** 0–1.5. 1 is the original loudness. */
  volume: number;
  /** The default rate for a new session, 0.5–3. */
  rate: number;
  cache: CacheSettings;
}

/** The storage sizes the settings panel offers, in bytes. */
export const MAX_BYTES_CHOICES: readonly number[] = [50, 100, 200, 500].map(
  (megabytes) => megabytes * 1024 * 1024
);

export const MIN_VOLUME = 0;
export const MAX_VOLUME = 1.5;
export const MIN_RATE = 0.5;
export const MAX_RATE = 3;

export const DEFAULT_SETTINGS: Settings = {
  uiLang: 'auto',
  keepPlayingInBackground: true,
  captionWindow: false,
  volume: 1,
  rate: 1,
  cache: { persist: true, maxBytes: 200 * 1024 * 1024 },
};

/**
 * The slice of `chrome.storage.onChanged` this module needs.
 *
 * Declared locally rather than imported from `SessionWatch`, which needs the
 * same shape: neither module should depend on the other's reason for listening.
 */
export interface StorageChangeApi {
  addListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
  removeListener(listener: (changes: Record<string, unknown>, areaName: string) => void): void;
}

export class SettingsStore {
  constructor(
    private readonly area: LocalStorageArea,
    private readonly changes?: StorageChangeApi
  ) {}

  /** The saved settings, normalized, or the defaults when nothing is saved. */
  async load(): Promise<Settings> {
    const stored = await this.area.get(SETTINGS_KEY);
    return normalizeSettings(stored[SETTINGS_KEY]);
  }

  /**
   * Merge `patch` into the saved settings and store the result.
   *
   * The patch is merged over what is already stored, so a caller that changes
   * one preference does not have to know the others, and what is written is the
   * normalized result rather than the raw patch.
   */
  async update(patch: Partial<Settings>): Promise<Settings> {
    const current = await this.load();
    const settings = normalizeSettings({ ...current, ...patch });
    await this.area.set({ [SETTINGS_KEY]: settings });
    return settings;
  }

  /** Calls `listener` whenever the settings change. Returns an unsubscribe. */
  subscribe(listener: (settings: Settings) => void): () => void {
    const changes = this.changes;
    if (!changes) return () => {};

    const handler = (all: Record<string, unknown>, areaName: string): void => {
      if (areaName !== 'local') return;
      const change = all[SETTINGS_KEY];
      if (change === undefined) return;
      // A deleted key reads as "no settings", which is the defaults.
      listener(normalizeSettings((change as { newValue?: unknown })?.newValue));
    };

    changes.addListener(handler);
    return () => changes.removeListener(handler);
  }
}

/**
 * A stored value read as settings.
 *
 * Unknown keys are dropped, numbers are clamped to their range, and anything
 * that is not the right shape falls back to its default. `maxBytes` is matched
 * against the offered choices instead of clamped: a size the UI cannot show
 * would leave the panel unable to represent what is stored.
 */
export function normalizeSettings(value: unknown): Settings {
  const raw = asRecord(value);
  const cache = asRecord(raw.cache);

  return {
    uiLang: isUiLang(raw.uiLang) ? raw.uiLang : DEFAULT_SETTINGS.uiLang,
    keepPlayingInBackground: booleanOr(
      raw.keepPlayingInBackground,
      DEFAULT_SETTINGS.keepPlayingInBackground
    ),
    captionWindow: booleanOr(raw.captionWindow, DEFAULT_SETTINGS.captionWindow),
    volume: clampOr(raw.volume, MIN_VOLUME, MAX_VOLUME, DEFAULT_SETTINGS.volume),
    rate: clampOr(raw.rate, MIN_RATE, MAX_RATE, DEFAULT_SETTINGS.rate),
    cache: {
      persist: booleanOr(cache.persist, DEFAULT_SETTINGS.cache.persist),
      maxBytes: isMaxBytes(cache.maxBytes) ? cache.maxBytes : DEFAULT_SETTINGS.cache.maxBytes,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function isUiLang(value: unknown): value is UiLang {
  return value === 'auto' || value === 'en' || value === 'zh-CN';
}

function booleanOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/** A finite number clamped to `[min, max]`; anything else is the fallback. */
function clampOr(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function isMaxBytes(value: unknown): value is number {
  return typeof value === 'number' && MAX_BYTES_CHOICES.includes(value);
}
