import { describe, expect, it, vi } from 'vitest';
import type { LocalStorageArea } from '~/lib/config-store';
import {
  DEFAULT_SETTINGS,
  MAX_BYTES_CHOICES,
  SETTINGS_KEY,
  SettingsStore,
  type StorageChangeApi,
} from '~/lib/settings-store';

function fakeArea(initial: Record<string, unknown> = {}) {
  const data = new Map<string, unknown>(Object.entries(initial));
  const area: LocalStorageArea = {
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const result: Record<string, unknown> = {};
      for (const key of wanted) result[key] = data.get(key);
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
  };
  return { area, data };
}

/** A `storage.onChanged` that records its listeners so a test can fire them. */
function fakeChanges() {
  const listeners = new Set<(changes: Record<string, unknown>, areaName: string) => void>();
  const api: StorageChangeApi = {
    addListener: (listener) => {
      listeners.add(listener);
    },
    removeListener: (listener) => {
      listeners.delete(listener);
    },
  };
  return {
    api,
    fire: (changes: Record<string, unknown>, areaName = 'local'): void => {
      for (const listener of [...listeners]) listener(changes, areaName);
    },
    count: (): number => listeners.size,
  };
}

describe('SettingsStore.load', () => {
  it('returns the defaults before anything is saved', async () => {
    const { area } = fakeArea();

    expect(await new SettingsStore(area).load()).toEqual(DEFAULT_SETTINGS);
  });

  it('drops keys it does not know', async () => {
    const { area } = fakeArea({
      [SETTINGS_KEY]: { volume: 0.5, somethingElse: 'x' },
    });

    const settings = await new SettingsStore(area).load();

    expect(settings).toEqual({ ...DEFAULT_SETTINGS, volume: 0.5 });
    expect('somethingElse' in settings).toBe(false);
  });

  it('clamps the volume into the allowed range', async () => {
    const { area } = fakeArea({
      [SETTINGS_KEY]: { volume: 4 },
    });
    const store = new SettingsStore(area);

    expect((await store.load()).volume).toBe(1.5);

    await area.set({ [SETTINGS_KEY]: { volume: -2 } });
    expect((await store.load()).volume).toBe(0);
  });

  it('defaults the volume when it is not a number', async () => {
    const { area } = fakeArea({ [SETTINGS_KEY]: { volume: 'loud' } });

    expect((await new SettingsStore(area).load()).volume).toBe(1);

    await area.set({ [SETTINGS_KEY]: { volume: Number.NaN } });
    expect((await new SettingsStore(area).load()).volume).toBe(1);
  });

  it('clamps the rate into the allowed range', async () => {
    const { area } = fakeArea({ [SETTINGS_KEY]: { rate: 10 } });
    const store = new SettingsStore(area);

    expect((await store.load()).rate).toBe(3);

    await area.set({ [SETTINGS_KEY]: { rate: 0.1 } });
    expect((await store.load()).rate).toBe(0.5);
  });

  it('accepts each of the size choices', async () => {
    const { area } = fakeArea();
    const store = new SettingsStore(area);

    for (const maxBytes of MAX_BYTES_CHOICES) {
      await area.set({ [SETTINGS_KEY]: { cache: { maxBytes } } });
      expect((await store.load()).cache.maxBytes).toBe(maxBytes);
    }
  });

  it('defaults a size that is not one of the choices', async () => {
    const { area } = fakeArea({ [SETTINGS_KEY]: { cache: { maxBytes: 12345 } } });

    expect((await new SettingsStore(area).load()).cache.maxBytes).toBe(
      DEFAULT_SETTINGS.cache.maxBytes
    );
  });

  it('defaults an unknown interface language', async () => {
    const { area } = fakeArea({ [SETTINGS_KEY]: { uiLang: 'fr' } });
    const store = new SettingsStore(area);

    expect((await store.load()).uiLang).toBe('auto');

    await area.set({ [SETTINGS_KEY]: { uiLang: 'zh-CN' } });
    expect((await store.load()).uiLang).toBe('zh-CN');
  });

  it('defaults a boolean that is not a real boolean', async () => {
    const { area } = fakeArea({
      [SETTINGS_KEY]: { keepPlayingInBackground: 'true', captionWindow: 1 },
    });

    const settings = await new SettingsStore(area).load();

    expect(settings.keepPlayingInBackground).toBe(true);
    expect(settings.captionWindow).toBe(false);
  });

  it('fills in a missing or malformed cache object', async () => {
    const { area } = fakeArea({ [SETTINGS_KEY]: { cache: 'nope' } });
    const store = new SettingsStore(area);

    expect((await store.load()).cache).toEqual(DEFAULT_SETTINGS.cache);

    await area.set({
      [SETTINGS_KEY]: { cache: { persist: 'yes', maxBytes: MAX_BYTES_CHOICES[0] } },
    });
    expect((await store.load()).cache).toEqual({ persist: true, maxBytes: MAX_BYTES_CHOICES[0] });
  });
});

describe('SettingsStore.update', () => {
  it('merges a patch into what is stored', async () => {
    const { area, data } = fakeArea({ [SETTINGS_KEY]: { rate: 1.5, captionWindow: true } });
    const store = new SettingsStore(area);

    const settings = await store.update({ volume: 0.5 });

    expect(settings).toEqual({ ...DEFAULT_SETTINGS, rate: 1.5, captionWindow: true, volume: 0.5 });
    expect(data.get(SETTINGS_KEY)).toEqual(settings);
  });

  it('stores a normalized patch, not the raw one', async () => {
    const { area, data } = fakeArea();
    const store = new SettingsStore(area);

    const settings = await store.update({ volume: 9, rate: -1 });

    expect(settings.volume).toBe(1.5);
    expect(settings.rate).toBe(0.5);
    expect(data.get(SETTINGS_KEY)).toEqual(settings);
  });
});

describe('SettingsStore.subscribe', () => {
  it('delivers the settings when its own key changes', async () => {
    const { area } = fakeArea();
    const changes = fakeChanges();
    const store = new SettingsStore(area, changes.api);
    const listener = vi.fn();
    store.subscribe(listener);

    changes.fire({ [SETTINGS_KEY]: { newValue: { volume: 0.25 } } });

    expect(listener).toHaveBeenCalledWith({ ...DEFAULT_SETTINGS, volume: 0.25 });
  });

  it('ignores changes to other keys and other areas', () => {
    const changes = fakeChanges();
    const store = new SettingsStore(fakeArea().area, changes.api);
    const listener = vi.fn();
    store.subscribe(listener);

    changes.fire({ 'sayloud:provider-config': { newValue: {} } });
    changes.fire({ [SETTINGS_KEY]: { newValue: {} } }, 'session');

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops delivering after the unsubscribe', () => {
    const changes = fakeChanges();
    const store = new SettingsStore(fakeArea().area, changes.api);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    unsubscribe();
    changes.fire({ [SETTINGS_KEY]: { newValue: {} } });

    expect(listener).not.toHaveBeenCalled();
    expect(changes.count()).toBe(0);
  });

  it('is a no-op without a change source', () => {
    const store = new SettingsStore(fakeArea().area);

    expect(() => store.subscribe(vi.fn())()).not.toThrow();
  });
});
