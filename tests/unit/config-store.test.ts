import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONFIG_KEY,
  ConfigStore,
  type LocalStorageArea,
  PROVIDER_CONFIGS_KEY,
  SELECTED_VOICES_KEY,
  VOICE_NAMES_KEY,
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

const DASHSCOPE: ProviderConfig = {
  provider: 'dashscope',
  apiKey: 'sk-1',
  region: 'ap-southeast-1',
};

const VOLCENGINE: ProviderConfig = {
  provider: 'volcengine',
  apiKey: 'volc-1',
  resourceId: 'seed-tts-2.0',
};

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

  it('saves a config without activating it', async () => {
    await store.saveConfig(DASHSCOPE);

    expect(await store.getSavedConfigs()).toEqual({ dashscope: DASHSCOPE });
    expect(fake.data.get(PROVIDER_CONFIGS_KEY)).toEqual({ dashscope: DASHSCOPE });
    // Saving credentials is not choosing which service to read with: the dot
    // in the provider list is, and it is the only thing that writes this key.
    expect(await store.getConfig()).toBeNull();
    expect(fake.data.has(CONFIG_KEY)).toBe(false);
  });

  it('activates a provider from the config it was saved with', async () => {
    await store.saveConfig(DASHSCOPE);

    expect(await store.setActiveConfig('dashscope')).toBe(true);
    expect(await store.getConfig()).toEqual(DASHSCOPE);
  });

  it('refuses to activate a provider that has nothing saved', async () => {
    expect(await store.setActiveConfig('dashscope')).toBe(false);

    // Refused, not invented: an empty config would only fail later, mid-read.
    expect(await store.getConfig()).toBeNull();
    expect(fake.data.has(CONFIG_KEY)).toBe(false);
  });

  it('activates the browser voice, which has nothing to save', async () => {
    await store.saveConfig(DASHSCOPE);

    expect(await store.setActiveConfig('browser')).toBe(true);
    expect(await store.getConfig()).toEqual({ provider: 'browser' });
    expect((await store.getSavedConfigs()).dashscope).toEqual(DASHSCOPE);
  });

  it('activates what was saved last, not what was saved first', async () => {
    await store.saveConfig(DASHSCOPE);
    await store.saveConfig({ ...DASHSCOPE, apiKey: 'sk-2' });

    await store.setActiveConfig('dashscope');

    expect(await store.getConfig()).toMatchObject({ apiKey: 'sk-2' });
  });

  it('switches the active provider without dropping the previous one', async () => {
    await store.saveConfig(DASHSCOPE);
    await store.saveConfig(VOLCENGINE);

    await store.setActiveConfig('dashscope');
    expect(await store.getConfig()).toEqual(DASHSCOPE);

    await store.setActiveConfig('volcengine');
    expect(await store.getConfig()).toEqual(VOLCENGINE);

    // Switching back must not mean typing the key in again.
    await store.setActiveConfig('dashscope');
    expect(await store.getConfig()).toEqual(DASHSCOPE);
    expect(await store.getSavedConfigs()).toEqual({
      dashscope: DASHSCOPE,
      volcengine: VOLCENGINE,
    });
  });

  it('keeps the latest config per provider', async () => {
    await store.saveConfig(DASHSCOPE);
    await store.saveConfig({ ...DASHSCOPE, apiKey: 'sk-2' });

    expect((await store.getSavedConfigs()).dashscope).toMatchObject({ apiKey: 'sk-2' });
  });

  it('counts a config saved before per-provider storage as saved', async () => {
    fake.data.set(CONFIG_KEY, DASHSCOPE);

    expect(await store.getSavedConfigs()).toEqual({ dashscope: DASHSCOPE });
  });

  it('drops a saved entry that is invalid or filed under another provider', async () => {
    fake.data.set(PROVIDER_CONFIGS_KEY, {
      dashscope: { provider: 'dashscope' },
      elevenlabs: DASHSCOPE,
      volcengine: VOLCENGINE,
    });

    expect(await store.getSavedConfigs()).toEqual({ volcengine: VOLCENGINE });
  });

  it('forgets one provider and leaves the others', async () => {
    await store.saveConfig(DASHSCOPE);
    await store.saveConfig(VOLCENGINE);
    await store.setActiveConfig('volcengine');

    await store.forgetConfig('dashscope');

    expect(await store.getSavedConfigs()).toEqual({ volcengine: VOLCENGINE });
    expect(await store.getConfig()).toEqual(VOLCENGINE);
  });

  it('falls back to the browser voice when the active provider is forgotten', async () => {
    await store.saveConfig(DASHSCOPE);
    await store.setActiveConfig('dashscope');

    await store.forgetConfig('dashscope');

    expect(await store.getConfig()).toEqual({ provider: 'browser' });
    expect(await store.getSavedConfigs()).toEqual({});
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

  it('reads every chosen voice in one pass, for a list that needs all of them', async () => {
    await store.saveSelectedVoice('dashscope', 'longxiaochun');
    await store.saveSelectedVoice('azure', 'zh-CN-XiaoxiaoNeural');

    expect(await store.getSelectedVoices()).toEqual({
      dashscope: 'longxiaochun',
      azure: 'zh-CN-XiaoxiaoNeural',
    });
  });

  it('reports no remembered voice names before any voice was picked from a list', async () => {
    expect(await store.getVoiceNames()).toEqual({});
  });

  it('remembers the name a voice was listed under', async () => {
    await store.saveVoiceName('dashscope', 'longxiaochun_v2', '龙小春 2.0');

    expect(await store.getVoiceNames()).toEqual({ dashscope: { longxiaochun_v2: '龙小春 2.0' } });
    expect(fake.data.get(VOICE_NAMES_KEY)).toEqual({
      dashscope: { longxiaochun_v2: '龙小春 2.0' },
    });
  });

  it('keeps a name per voice, so picking another does not lose the first', async () => {
    await store.saveVoiceName('dashscope', 'a', 'A');
    await store.saveVoiceName('dashscope', 'b', 'B');
    await store.saveVoiceName('elevenlabs', 'c', 'C');

    expect(await store.getVoiceNames()).toEqual({
      dashscope: { a: 'A', b: 'B' },
      elevenlabs: { c: 'C' },
    });
  });

  it('overwrites a name the catalogue has since changed', async () => {
    await store.saveVoiceName('dashscope', 'a', 'Old');
    await store.saveVoiceName('dashscope', 'a', 'New');

    expect((await store.getVoiceNames()).dashscope).toEqual({ a: 'New' });
  });

  it('stores nothing for a voice with a blank id or a blank name', async () => {
    await store.saveVoiceName('dashscope', '', 'Named');
    await store.saveVoiceName('dashscope', 'a', '');

    expect(await store.getVoiceNames()).toEqual({});
    expect(fake.data.has(VOICE_NAMES_KEY)).toBe(false);
  });

  it('ignores stored voice names that are not usable strings', async () => {
    fake.data.set(VOICE_NAMES_KEY, {
      dashscope: { a: 42, b: 'Kept' },
      volcengine: 'not a map',
      azure: ['not a map either'],
    });

    expect(await store.getVoiceNames()).toEqual({ dashscope: { b: 'Kept' } });
  });
});
