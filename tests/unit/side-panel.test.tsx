import { act, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it } from 'vitest';
import { SidePanel } from '~/entrypoints/sidepanel/SidePanel';
import { CONFIG_KEY, ConfigStore, type LocalStorageArea } from '~/lib/config-store';
import type { AdapterProviderId } from '~/lib/providers/registry';
import type { Provider } from '~/lib/providers/types';
import type { SessionWatch } from '~/lib/session-watch';
import { SETTINGS_KEY, SettingsStore, type StorageChangeApi } from '~/lib/settings-store';

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
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
  };
  return { area, data };
}

/** A `storage.onChanged` a test can fire, standing in for the worker's write. */
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
    fire: (settings: unknown): void => {
      for (const listener of [...listeners]) {
        listener({ [SETTINGS_KEY]: { newValue: settings } }, 'local');
      }
    },
  };
}

const providers = {
  dashscope: {},
  volcengine: {},
  'openai-compat': {},
  elevenlabs: {},
  azure: {},
  local: {},
} as unknown as Record<AdapterProviderId, Provider>;

function renderPanel(settings?: SettingsStore) {
  const { area } = fakeArea();
  const session = { subscribe: () => () => {}, load: async () => null };
  render(
    <SidePanel
      store={new ConfigStore(area)}
      providers={providers}
      session={session as unknown as SessionWatch}
      {...(settings ? { settings } : {})}
    />
  );
}

function languageSelect(): HTMLSelectElement {
  return screen.getByLabelText('Interface language') as HTMLSelectElement;
}

/**
 * Opens the settings tab, where the language row lives.
 *
 * The select is not mounted before that: the panel opens on the Reading tab.
 */
async function openSettings(tabName = 'Settings'): Promise<void> {
  fireEvent.click(screen.getByRole('tab', { name: tabName }));
  await screen.findByLabelText('Interface language');
}

describe('SidePanel', () => {
  it('renders in English by default', async () => {
    renderPanel();

    expect(screen.getByRole('tab', { name: 'Reading' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Settings' })).toBeTruthy();

    await openSettings();
    expect(languageSelect().value).toBe('auto');
  });

  it('renders in Chinese when the saved language says so', async () => {
    const { area } = fakeArea({ [SETTINGS_KEY]: { uiLang: 'zh-CN' } });
    const session = { subscribe: () => () => {}, load: async () => null };
    render(
      <SidePanel
        store={new ConfigStore(area)}
        providers={providers}
        session={session as unknown as SessionWatch}
        settings={new SettingsStore(area)}
      />
    );

    expect(await screen.findByRole('tab', { name: '朗读' })).toBeTruthy();
    expect(screen.getByRole('tab', { name: '设置' })).toBeTruthy();
    expect(screen.getByText('尚未配置任何服务。打开「设置」选择一项。')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: '设置' }));
    expect(await screen.findByLabelText('界面语言')).toBeTruthy();
    expect(screen.getByText('跟随浏览器')).toBeTruthy();
    // The document tag follows from an effect, which lands a tick after the
    // storage read that changed the language.
    await waitFor(() => expect(document.documentElement.lang).toBe('zh-CN'));
    document.documentElement.lang = 'en';
  });

  it('switches the whole panel when the language row changes', async () => {
    const { area } = fakeArea();
    const store = new SettingsStore(area);
    renderPanel(store);
    await openSettings();

    fireEvent.change(languageSelect(), { target: { value: 'zh-CN' } });

    expect(await screen.findByRole('tab', { name: '朗读' })).toBeTruthy();
    await waitFor(async () => expect((await store.load()).uiLang).toBe('zh-CN'));
  });

  it('follows a language change made in another context', async () => {
    const changes = fakeChanges();
    const store = new SettingsStore(fakeArea().area, changes.api);
    renderPanel(store);
    await openSettings();

    act(() => changes.fire({ uiLang: 'zh-CN' }));

    expect(await screen.findByRole('tab', { name: '朗读' })).toBeTruthy();
  });

  it('offers the languages the settings store understands', async () => {
    renderPanel();
    await openSettings();

    const options = [...languageSelect().options].map((option) => option.value);
    expect(options).toEqual(['auto', 'en', 'zh-CN']);
  });

  it('shows the chosen voice the way the list named it, not by its id', async () => {
    const { area } = fakeArea({
      [CONFIG_KEY]: { provider: 'dashscope', apiKey: 'sk-1' },
      'sayloud:selected-voices': { dashscope: 'longxiaochun_v2' },
      'sayloud:voice-names': { dashscope: { longxiaochun_v2: '龙小春 2.0' } },
    });
    const session = { subscribe: () => () => {}, load: async () => null };
    render(
      <SidePanel
        store={new ConfigStore(area)}
        providers={providers}
        session={session as unknown as SessionWatch}
      />
    );

    expect(await screen.findByText('龙小春 2.0')).toBeTruthy();
    // The id is what is stored; the name is only how it was listed.
    expect(screen.queryByText('longxiaochun_v2')).toBeNull();
  });
});

describe('the tab list', () => {
  it('renders a tab per entry, in order', async () => {
    renderPanel();

    // The order is the contract, and the models tab is last because it is the
    // one nobody needs until the on-device provider is chosen.
    expect(screen.getAllByRole('tab').map((tab) => tab.id)).toEqual([
      'tab-reading',
      'tab-settings',
      'tab-models',
    ]);
  });

  it('drives one panel per tab, whatever the list holds', async () => {
    // The whole list, not the two names: P4 adds a model tab, and neither this
    // loop nor the render behind it should have to change for that.
    renderPanel();

    for (const tab of screen.getAllByRole('tab')) {
      fireEvent.click(tab);

      expect(tab.getAttribute('aria-selected')).toBe('true');
      const panelId = tab.getAttribute('aria-controls');
      expect(panelId).toBe(`panel-${tab.id.replace('tab-', '')}`);
      const panel = document.getElementById(panelId as string);
      expect(panel?.getAttribute('role')).toBe('tabpanel');
      expect(panel?.getAttribute('aria-labelledby')).toBe(tab.id);
    }
  });

  it('opens the voice picker as a page of its own, and comes back', async () => {
    const { area } = fakeArea({ [CONFIG_KEY]: { provider: 'dashscope', apiKey: 'sk-1' } });
    const session = { subscribe: () => () => {}, load: async () => null };
    render(
      <SidePanel
        store={new ConfigStore(area)}
        providers={providers}
        session={session as unknown as SessionWatch}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: /DashScope/ }));

    // A page, not a tab: the tab list is gone while it is up.
    expect(screen.queryAllByRole('tab')).toHaveLength(0);
    expect(screen.getByRole('heading', { name: 'Voice' })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    expect(await screen.findByRole('tab', { name: 'Reading' })).toBeTruthy();
  });
});

describe('the settings tab', () => {
  it('keeps the provider form working next to the language row', async () => {
    // The language row is rendered around `ProviderConfigPanel`; it must not
    // take over the settings tab.
    const { area } = fakeArea();
    const store = new ConfigStore(area);
    const session = { subscribe: () => () => {}, load: async () => null };
    render(
      <SidePanel store={store} providers={providers} session={session as unknown as SessionWatch} />
    );

    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByLabelText('Interface language');
    expect(languageSelect()).toBeTruthy();

    // The browser row opens first, and has no fields of its own to save.
    fireEvent.click(
      document.querySelector('[data-provider="dashscope"] .provider-toggle') as HTMLElement
    );
    expect(screen.getByLabelText(/API key/)).toBeTruthy();
  });
});
