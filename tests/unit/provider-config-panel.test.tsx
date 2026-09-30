import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { ProviderConfigPanel } from '~/entrypoints/sidepanel/ProviderConfig';
import { ConfigStore, type LocalStorageArea } from '~/lib/config-store';
import type { CloudProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig } from '~/lib/providers/types';

function memoryArea(): LocalStorageArea {
  const data = new Map<string, unknown>();
  return {
    async get(keys) {
      const result: Record<string, unknown> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = data.get(key);
      return result;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
    },
  };
}

function fakeProvider(): Provider {
  return {
    capabilities: () => ({ timings: 'none', maxChars: 100, concurrency: 1 }),
    validate: vi.fn(() => Promise.resolve()),
    listVoices: vi.fn(() => Promise.resolve([])),
  } as unknown as Provider;
}

const providers = {
  dashscope: fakeProvider(),
  volcengine: fakeProvider(),
  'openai-compat': fakeProvider(),
  elevenlabs: fakeProvider(),
  azure: fakeProvider(),
} as Record<CloudProviderId, Provider>;

const DASHSCOPE: ProviderConfig = { provider: 'dashscope', apiKey: 'sk-dash' };
const VOLCENGINE: ProviderConfig = {
  provider: 'volcengine',
  apiKey: 'volc-key',
  resourceId: 'seed-tts-2.0',
};

async function renderPanel(store: ConfigStore, onSaved = vi.fn()) {
  render(
    <ProviderConfigPanel
      store={store}
      providers={providers}
      saved={await store.getConfig()}
      savedConfigs={await store.getSavedConfigs()}
      onSaved={onSaved}
    />
  );
  return onSaved;
}

function pick(provider: string): void {
  fireEvent.change(screen.getByLabelText('Provider'), { target: { value: provider } });
}

function apiKeyField(): HTMLInputElement {
  return screen.getByLabelText(/API key/) as HTMLInputElement;
}

describe('ProviderConfigPanel', () => {
  it('fills in each provider from its own saved config when switching', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.saveConfig(VOLCENGINE);
    await renderPanel(store);

    // Volcengine is active, so it is shown first.
    expect(apiKeyField().value).toBe('volc-key');

    pick('dashscope');
    expect(apiKeyField().value).toBe('sk-dash');

    pick('volcengine');
    expect(apiKeyField().value).toBe('volc-key');
    expect((screen.getByLabelText(/Resource id/) as HTMLSelectElement).value).toBe('seed-tts-2.0');
  });

  it('keeps the other keys when the browser voice is saved', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await renderPanel(store);

    pick('browser');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect(await store.getConfig()).toEqual({ provider: 'browser' }));
    expect((await store.getSavedConfigs()).dashscope).toEqual(DASHSCOPE);
  });

  it('forgets a saved key on request and clears the form', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    const onSaved = await renderPanel(store);

    fireEvent.click(screen.getByRole('button', { name: 'Forget saved key' }));

    await waitFor(async () => expect(await store.getSavedConfigs()).toEqual({}));
    expect(await store.getConfig()).toEqual({ provider: 'browser' });
    expect(onSaved).toHaveBeenCalledWith({ provider: 'browser' });
    await waitFor(() => expect(apiKeyField().value).toBe(''));
  });

  it('offers no forget button for a provider with nothing saved', async () => {
    const store = new ConfigStore(memoryArea());
    await renderPanel(store);

    pick('dashscope');

    expect(screen.queryByRole('button', { name: 'Forget saved key' })).toBeNull();
  });
});
