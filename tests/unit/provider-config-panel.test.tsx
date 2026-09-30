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

/**
 * The panel the way SidePanel mounts it: re-rendered from the store whenever
 * it reports a change.
 */
async function renderPanel(store: ConfigStore) {
  const onChanged = vi.fn();
  const props = async () => ({
    store,
    providers,
    saved: await store.getConfig(),
    savedConfigs: await store.getSavedConfigs(),
  });
  const view = render(<ProviderConfigPanel {...(await props())} onChanged={onChanged} />);
  onChanged.mockImplementation(async () => {
    view.rerender(<ProviderConfigPanel {...(await props())} onChanged={onChanged} />);
  });
  return onChanged;
}

/** The row for one provider. `data-provider` is what the smoke script clicks. */
function providerRow(id: string): HTMLElement {
  const row = document.querySelector(`[data-provider="${id}"]`);
  if (!row) throw new Error(`no row for ${id}`);
  return row as HTMLElement;
}

/**
 * Opens a provider's form the way a user does.
 *
 * Clicking a row toggles it, and the row for the active provider is open to
 * begin with — so a test that wants it open has to look before it clicks.
 */
function open(id: string): void {
  if (providerRow(id).getAttribute('aria-expanded') === 'false') fireEvent.click(providerRow(id));
}

function apiKeyField(): HTMLInputElement {
  return screen.getByLabelText(/API key/) as HTMLInputElement;
}

describe('ProviderConfigPanel', () => {
  it('shows a key saved in this panel after switching away and back', async () => {
    const store = new ConfigStore(memoryArea());
    await renderPanel(store);

    open('dashscope');
    fireEvent.input(apiKeyField(), { target: { value: 'sk-typed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');
    await waitFor(async () =>
      expect((await store.getSavedConfigs()).dashscope).toMatchObject({ apiKey: 'sk-typed' })
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    open('browser');
    open('dashscope');
    expect(apiKeyField().value).toBe('sk-typed');
  });

  it('updates the form on every keystroke, not only when the field loses focus', async () => {
    const store = new ConfigStore(memoryArea());
    await renderPanel(store);

    open('openai-compat');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(screen.getByText('Base URL is required.')).toBeTruthy();

    // Typing fires `input`; `change` on a text field waits for blur in the
    // DOM, and Preact does not paper over that the way React does.
    fireEvent.input(screen.getByLabelText(/Base URL/), {
      target: { value: 'http://127.0.0.1:8880/v1' },
    });

    expect(screen.queryByText('Base URL is required.')).toBeNull();
  });

  it('fills in each provider from its own saved config when switching', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.saveConfig(VOLCENGINE);
    await renderPanel(store);

    // Volcengine is active, so it is open first.
    expect(apiKeyField().value).toBe('volc-key');

    open('dashscope');
    expect(apiKeyField().value).toBe('sk-dash');

    open('volcengine');
    expect(apiKeyField().value).toBe('volc-key');
    expect((screen.getByLabelText(/Resource id/) as HTMLSelectElement).value).toBe('seed-tts-2.0');
  });

  it('keeps the other keys when the browser voice is saved', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await renderPanel(store);

    open('browser');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(async () => expect(await store.getConfig()).toEqual({ provider: 'browser' }));
    expect((await store.getSavedConfigs()).dashscope).toEqual(DASHSCOPE);
  });

  it('forgets a saved key on request and clears the form', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    const onChanged = await renderPanel(store);

    fireEvent.click(screen.getByRole('button', { name: 'Forget saved key' }));

    await waitFor(async () => expect(await store.getSavedConfigs()).toEqual({}));
    expect(await store.getConfig()).toEqual({ provider: 'browser' });
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(apiKeyField().value).toBe(''));
  });

  it('offers no forget button for a provider with nothing saved', async () => {
    const store = new ConfigStore(memoryArea());
    await renderPanel(store);

    open('dashscope');

    expect(screen.queryByRole('button', { name: 'Forget saved key' })).toBeNull();
  });
});

describe('the provider list', () => {
  it('lists every provider as a row, in the schema order', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    expect(
      [...document.querySelectorAll('[data-provider]')].map((row) =>
        row.getAttribute('data-provider')
      )
    ).toEqual(['browser', 'dashscope', 'volcengine', 'openai-compat', 'elevenlabs', 'azure']);
  });

  it('keeps one row open at a time', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    open('dashscope');
    expect(providerRow('dashscope').getAttribute('aria-expanded')).toBe('true');
    expect(providerRow('browser').getAttribute('aria-expanded')).toBe('false');

    open('azure');
    expect(providerRow('azure').getAttribute('aria-expanded')).toBe('true');
    expect(providerRow('dashscope').getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the open row when its own button is pressed again', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    fireEvent.click(providerRow('browser'));

    expect(providerRow('browser').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('points the open row at its form', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    open('dashscope');

    const controls = providerRow('dashscope').getAttribute('aria-controls');
    expect(controls).toBe('provider-form-dashscope');
    expect(document.getElementById(controls as string)).toBeTruthy();
  });

  it('marks the provider in use and says what it is configured with', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.saveSelectedVoice('dashscope', 'longxiaochun');
    await renderPanel(store);

    expect(providerRow('dashscope').getAttribute('data-active')).toBe('true');
    expect(providerRow('browser').getAttribute('data-active')).toBe('false');
    expect(screen.getByText('Active')).toBeTruthy();
  });

  it('shows the chosen voice for a provider that has one', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.saveSelectedVoice('dashscope', 'longxiaochun');
    const savedConfigs = await store.getSavedConfigs();
    render(
      <ProviderConfigPanel
        store={store}
        providers={providers}
        saved={await store.getConfig()}
        savedConfigs={savedConfigs}
        voices={{ dashscope: 'longxiaochun' }}
        onChanged={() => {}}
      />
    );

    expect(screen.getByText('Configured · longxiaochun')).toBeTruthy();
  });

  it('shows the schema summary for a provider that is not configured', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    expect(
      screen.getByText('Uses the voices Chrome already has installed. Nothing to configure.')
    ).toBeTruthy();
    expect(screen.getByText(/Word timings come from the with-timestamps endpoint/)).toBeTruthy();
  });
});

describe('SidePanel settings state', () => {
  it('shows a key saved earlier in the panel after leaving the Settings tab', async () => {
    const { SidePanel } = await import('~/entrypoints/sidepanel/SidePanel');
    const store = new ConfigStore(memoryArea());
    const session = { subscribe: () => () => {}, load: async () => null };

    render(
      <SidePanel
        store={store}
        providers={providers}
        session={session as unknown as import('~/lib/session-watch').SessionWatch}
      />
    );

    fireEvent.click(await screen.findByRole('tab', { name: 'Settings' }));
    await screen.findByLabelText('Interface language');
    open('dashscope');
    fireEvent.input(apiKeyField(), { target: { value: 'sk-new' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Saved.');

    // The Settings panel remounts when its tab comes back.
    fireEvent.click(screen.getByRole('tab', { name: 'Reading' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByLabelText('Interface language');
    open('browser');
    open('dashscope');

    expect(apiKeyField().value).toBe('sk-new');
  });
});
