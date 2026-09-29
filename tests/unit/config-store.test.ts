import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_KEY,
  ConfigStore,
  type LocalStorageArea,
  SELECTED_VOICES_KEY,
} from '~/lib/config-store';
import type { ProviderConfig } from '~/lib/providers/types';

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

const DASHSCOPE: ProviderConfig = { provider: 'dashscope', apiKey: 'sk-1', region: 'intl' };

describe('ConfigStore', () => {
  let fake: ReturnType<typeof fakeArea>;
  let store: ConfigStore;

  beforeEach(() => {
    fake = fakeArea();
    store = new ConfigStore(fake.area);
  });

  it('reports no config before one is saved', async () => {
    expect(await store.getConfig()).toBeNull();
  });

  it('round-trips a config', async () => {
    await store.saveConfig(DASHSCOPE);

    expect(await store.getConfig()).toEqual(DASHSCOPE);
    expect(fake.data.get(CONFIG_KEY)).toEqual(DASHSCOPE);
  });

  it('replaces the whole config, so the browser voice drops a stored key', async () => {
    await store.saveConfig(DASHSCOPE);
    await store.saveConfig({ provider: 'browser' });

    expect(await store.getConfig()).toEqual({ provider: 'browser' });
  });

  it('reports a config that fails validation as unconfigured', async () => {
    fake.data.set(CONFIG_KEY, { provider: 'dashscope' });
    expect(await store.getConfig()).toBeNull();

    fake.data.set(CONFIG_KEY, 'not a config');
    expect(await store.getConfig()).toBeNull();
  });

  it('drops a corrupt optional field but keeps the config', async () => {
    fake.data.set(CONFIG_KEY, { provider: 'dashscope', apiKey: 'sk-1', model: 42 });

    expect(await store.getConfig()).toEqual({ provider: 'dashscope', apiKey: 'sk-1' });
  });

  it('reports no voice before one is chosen', async () => {
    expect(await store.getSelectedVoice('dashscope')).toBeNull();
  });

  it('round-trips the voice chosen for a provider', async () => {
    await store.saveSelectedVoice('dashscope', 'longxiaochun');

    expect(await store.getSelectedVoice('dashscope')).toBe('longxiaochun');
    expect(fake.data.get(SELECTED_VOICES_KEY)).toEqual({ dashscope: 'longxiaochun' });
  });

  it('keeps a voice per provider, so switching back does not lose it', async () => {
    await store.saveSelectedVoice('dashscope', 'longxiaochun');
    await store.saveSelectedVoice('elevenlabs', '21m00Tcm4TlvDq8ikWAM');

    expect(await store.getSelectedVoice('dashscope')).toBe('longxiaochun');
    expect(await store.getSelectedVoice('elevenlabs')).toBe('21m00Tcm4TlvDq8ikWAM');
    expect(await store.getSelectedVoice('azure')).toBeNull();
  });

  it('overwrites the voice for the same provider', async () => {
    await store.saveSelectedVoice('dashscope', 'longxiaochun');
    await store.saveSelectedVoice('dashscope', 'longxiaoxia');

    expect(await store.getSelectedVoice('dashscope')).toBe('longxiaoxia');
  });

  it('ignores stored voices that are not usable strings', async () => {
    fake.data.set(SELECTED_VOICES_KEY, { dashscope: 42, elevenlabs: '', azure: 'ok' });

    expect(await store.getSelectedVoice('dashscope')).toBeNull();
    expect(await store.getSelectedVoice('elevenlabs')).toBeNull();
    expect(await store.getSelectedVoice('azure')).toBe('ok');
  });

  it('ignores a voice map of the wrong shape', async () => {
    fake.data.set(SELECTED_VOICES_KEY, ['dashscope']);

    expect(await store.getSelectedVoice('dashscope')).toBeNull();
  });
});
