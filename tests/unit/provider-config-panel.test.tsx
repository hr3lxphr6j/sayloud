import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import {
  ProviderConfigPanel,
  type ProviderConfigPanelProps,
} from '~/entrypoints/sidepanel/ProviderConfig';
import { ConfigStore, type LocalStorageArea } from '~/lib/config-store';
import type { AdapterProviderId } from '~/lib/providers/registry';
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

/**
 * An area whose writes wait to be released, so a save can be held in flight.
 *
 * A save is a storage write the test cannot otherwise observe half-done.
 */
function gatedArea(): { area: LocalStorageArea; release: () => void } {
  const data = new Map<string, unknown>();
  let open = false;
  const pending: Array<() => void> = [];
  return {
    area: {
      async get(keys) {
        const result: Record<string, unknown> = {};
        for (const key of Array.isArray(keys) ? keys : [keys]) result[key] = data.get(key);
        return result;
      },
      set(items) {
        return new Promise<void>((resolve) => {
          const commit = () => {
            for (const [key, value] of Object.entries(items)) data.set(key, structuredClone(value));
            resolve();
          };
          // Releasing before the write arrives still releases it: a save spends
          // a few microtasks reading the other configs first.
          if (open) commit();
          else pending.push(commit);
        });
      },
    },
    release: () => {
      open = true;
      for (const write of pending.splice(0)) write();
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
  local: fakeProvider(),
} as Record<AdapterProviderId, Provider>;

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
async function renderPanel(store: ConfigStore, extra: Partial<ProviderConfigPanelProps> = {}) {
  const onChanged = vi.fn();
  const props = async () => ({
    store,
    providers,
    saved: await store.getConfig(),
    savedConfigs: await store.getSavedConfigs(),
    ...extra,
  });
  const view = render(<ProviderConfigPanel {...(await props())} onChanged={onChanged} />);
  onChanged.mockImplementation(async () => {
    view.rerender(<ProviderConfigPanel {...(await props())} onChanged={onChanged} />);
  });
  return onChanged;
}

/**
 * The list entry for one provider. `data-provider` is on the entry, which holds
 * two controls: the circle that activates it and the button that opens it.
 */
function providerEntry(id: string): HTMLElement {
  const entry = document.querySelector(`[data-provider="${id}"]`);
  if (!entry) throw new Error(`no row for ${id}`);
  return entry as HTMLElement;
}

/** The button that opens and closes a provider's form. */
function providerToggle(id: string): HTMLElement {
  const toggle = providerEntry(id).querySelector('.provider-toggle');
  if (!toggle) throw new Error(`no expand button for ${id}`);
  return toggle as HTMLElement;
}

/** The circle that decides which provider SayLoud reads with. */
function providerDot(id: string): HTMLInputElement {
  const dot = providerEntry(id).querySelector('.provider-radio');
  if (!dot) throw new Error(`no activation control for ${id}`);
  return dot as HTMLInputElement;
}

/**
 * Opens a provider's form the way a user does.
 *
 * The row's own button toggles it, and the row for the active provider is open
 * to begin with — so a test that wants it open has to look first.
 */
function open(id: string): void {
  if (providerToggle(id).getAttribute('aria-expanded') === 'false') {
    fireEvent.click(providerToggle(id));
  }
}

function apiKeyField(): HTMLInputElement {
  return screen.getByLabelText(/API key/) as HTMLInputElement;
}

/**
 * Take the focus away from a field, the way tabbing to the next one does.
 *
 * `focusout`, not `blur`: the form listens on its container, and `blur` does
 * not bubble, so a container handler never sees it.
 */
function leave(element: HTMLElement): void {
  fireEvent.focusOut(element);
}

describe('ProviderConfigPanel', () => {
  it('shows a key saved in this panel after switching away and back', async () => {
    const store = new ConfigStore(memoryArea());
    await renderPanel(store);

    open('dashscope');
    fireEvent.input(apiKeyField(), { target: { value: 'sk-typed' } });
    leave(apiKeyField());
    // Not the provider in use, so "Saved." alone would leave the user thinking
    // nothing had happened.
    await screen.findByText(
      'Saved, but not in use. Use the circle beside the name to switch to it.'
    );
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
    leave(screen.getByLabelText(/Base URL/));
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
    await store.setActiveConfig('volcengine');
    await renderPanel(store);

    // Volcengine is active, so it is open first.
    expect(apiKeyField().value).toBe('volc-key');

    open('dashscope');
    expect(apiKeyField().value).toBe('sk-dash');

    open('volcengine');
    expect(apiKeyField().value).toBe('volc-key');
    expect((screen.getByLabelText(/Resource id/) as HTMLSelectElement).value).toBe('seed-tts-2.0');
  });

  it('says a saved key is not in use, and which control puts it in use', async () => {
    const store = new ConfigStore(memoryArea());
    await renderPanel(store);

    open('dashscope');
    fireEvent.input(apiKeyField(), { target: { value: 'sk-typed' } });
    leave(apiKeyField());

    expect(
      await screen.findByText(
        'Saved, but not in use. Use the circle beside the name to switch to it.'
      )
    ).toBeTruthy();
    await waitFor(async () =>
      expect((await store.getSavedConfigs()).dashscope).toMatchObject({ apiKey: 'sk-typed' })
    );
    // The hint would be a lie otherwise: Save must not have chosen it.
    expect(await store.getConfig()).toBeNull();
  });

  it('re-points the active config at an edit of the provider already in use', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.setActiveConfig('dashscope');
    await renderPanel(store);

    open('dashscope');
    fireEvent.input(apiKeyField(), { target: { value: 'sk-2' } });
    leave(apiKeyField());

    await screen.findByText('Saved.');
    // An edit is not a switch: the row stays in use, with what was just saved.
    await waitFor(async () => expect(await store.getConfig()).toMatchObject({ apiKey: 'sk-2' }));
    expect(providerEntry('dashscope').getAttribute('data-active')).toBe('true');
  });

  it('keeps the saved keys when the browser voice is chosen', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.setActiveConfig('dashscope');
    await renderPanel(store);

    open('browser');
    // Nothing to save and nothing to delete for a voice that is not
    // configured; its circle is the only control it has, so any button here
    // would be one that does nothing.
    expect(screen.queryByRole('button', { name: 'Test Connection' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete saved key' })).toBeNull();

    fireEvent.click(providerDot('browser'));

    await waitFor(async () => expect(await store.getConfig()).toEqual({ provider: 'browser' }));
    expect((await store.getSavedConfigs()).dashscope).toEqual(DASHSCOPE);
  });

  it('deletes a saved key from the form link and clears the form', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.setActiveConfig('dashscope');
    const onChanged = await renderPanel(store);

    fireEvent.click(screen.getByRole('button', { name: 'Delete saved key' }));

    await waitFor(async () => expect(await store.getSavedConfigs()).toEqual({}));
    expect(await store.getConfig()).toEqual({ provider: 'browser' });
    expect(onChanged).toHaveBeenCalled();
    await waitFor(() => expect(apiKeyField().value).toBe(''));
  });

  it('offers no delete link for a provider with nothing saved', async () => {
    const store = new ConfigStore(memoryArea());
    await renderPanel(store);

    open('dashscope');

    expect(screen.queryByRole('button', { name: 'Delete saved key' })).toBeNull();
  });

  it('offers the delete link once a key has been saved', async () => {
    const store = new ConfigStore(memoryArea());
    await renderPanel(store);

    open('dashscope');
    fireEvent.input(apiKeyField(), { target: { value: 'sk-typed' } });
    leave(apiKeyField());
    await screen.findByText(
      'Saved, but not in use. Use the circle beside the name to switch to it.'
    );

    expect(await screen.findByRole('button', { name: 'Delete saved key' })).toBeTruthy();
  });

  it('keeps the saved key when a blur leaves the form as it was', async () => {
    const area = memoryArea();
    const written = vi.spyOn(area, 'set');
    await renderPanel(new ConfigStore(area));

    open('dashscope');
    // Tabbing through an untouched form is not an edit, and writing the same
    // values back would only make storage churn.
    leave(apiKeyField());

    expect(written).not.toHaveBeenCalled();
  });

  it('writes nothing, and says so, when a blurred form does not validate', async () => {
    const area = memoryArea();
    const written = vi.spyOn(area, 'set');
    await renderPanel(new ConfigStore(area));

    open('dashscope');
    leave(apiKeyField());

    // The half-typed key is still in the field, so the line has to say that it
    // was not stored — otherwise the user believes it was.
    expect(screen.getByText('Not saved: fix the highlighted fields.')).toBeTruthy();
    expect(screen.getByText('API key is required.')).toBeTruthy();
    expect(written).not.toHaveBeenCalled();
  });

  it('keeps the rest of the form usable while a save is in flight', async () => {
    const { area, release } = gatedArea();
    await renderPanel(new ConfigStore(area));

    open('dashscope');
    fireEvent.input(apiKeyField(), { target: { value: 'sk-typed' } });
    leave(apiKeyField());

    // The blur that starts a save is the first half of the click that focuses
    // the next control, so disabling anything until the write lands would
    // swallow that click — a checkbox would never toggle.
    await waitFor(() => expect(screen.getByText('Saving…')).toBeTruthy());
    expect(apiKeyField().disabled).toBe(false);
    expect((screen.getByLabelText(/Region/) as HTMLSelectElement).disabled).toBe(false);

    release();
    await screen.findByText(
      'Saved, but not in use. Use the circle beside the name to switch to it.'
    );
  });

  it('offers Grant access when a save needs a host grant, and retries on the click', async () => {
    const store = new ConfigStore(memoryArea());
    const request = vi.fn(() => Promise.resolve(true));
    const onChanged = await renderPanel(store, { permissions: { request } });

    open('volcengine');
    fireEvent.input(apiKeyField(), { target: { value: 'volc-key' } });
    fireEvent.change(screen.getByLabelText(/Resource id/), {
      target: { value: 'seed-tts-1.0' },
    });
    leave(apiKeyField());

    expect(
      await screen.findByText('Not saved: Access to this host is not granted yet.')
    ).toBeTruthy();
    expect(await store.getSavedConfigs()).toEqual({});
    // A blur carries no gesture, and a prompt-less request never comes back at
    // all, so the save must not raise one: the button is where the asking goes.
    expect(request).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Grant access' }));

    await screen.findByText(
      'Saved, but not in use. Use the circle beside the name to switch to it.'
    );
    await waitFor(async () =>
      expect((await store.getSavedConfigs()).volcengine).toMatchObject({ apiKey: 'volc-key' })
    );
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith({ origins: ['https://openspeech.bytedance.com/*'] });
    expect(onChanged).toHaveBeenCalled();
  });

  it('saves a host that was granted earlier without prompting again', async () => {
    const store = new ConfigStore(memoryArea());
    const request = vi.fn(() => Promise.resolve(true));
    const contains = vi.fn(() => Promise.resolve(true));
    await renderPanel(store, { permissions: { request, contains } });

    open('volcengine');
    fireEvent.input(apiKeyField(), { target: { value: 'volc-key' } });
    fireEvent.change(screen.getByLabelText(/Resource id/), {
      target: { value: 'seed-tts-1.0' },
    });
    leave(apiKeyField());

    await screen.findByText(
      'Saved, but not in use. Use the circle beside the name to switch to it.'
    );
    expect(contains).toHaveBeenCalledWith({ origins: ['https://openspeech.bytedance.com/*'] });
    expect(request).not.toHaveBeenCalled();
  });
});

describe('the provider list', () => {
  it('lists every provider as a row, in the schema order', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    expect(
      [...document.querySelectorAll('[data-provider]')].map((row) =>
        row.getAttribute('data-provider')
      )
    ).toEqual([
      'browser',
      'local',
      'dashscope',
      'volcengine',
      'openai-compat',
      'elevenlabs',
      'azure',
    ]);
  });

  it('keeps one row open at a time', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    open('dashscope');
    expect(providerToggle('dashscope').getAttribute('aria-expanded')).toBe('true');
    expect(providerToggle('browser').getAttribute('aria-expanded')).toBe('false');

    open('azure');
    expect(providerToggle('azure').getAttribute('aria-expanded')).toBe('true');
    expect(providerToggle('dashscope').getAttribute('aria-expanded')).toBe('false');
  });

  it('closes the open row when its own button is pressed again', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    fireEvent.click(providerToggle('browser'));

    expect(providerToggle('browser').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByText('Save')).toBeNull();
  });

  it('draws nothing for the on-device provider, and says where its settings are', async () => {
    // Every field it has is hidden: the model, the tier and the device belong
    // to the Models tab, which can show download state next to them. A form
    // here would be a second control for one setting.
    await renderPanel(new ConfigStore(memoryArea()));

    open('local');

    expect(document.querySelectorAll('.form .field')).toHaveLength(0);
    expect(
      screen.getByText(
        'The model, its tier and the device it runs on are chosen in the Models tab.'
      )
    ).toBeTruthy();
    // The browser voice's notice is about reading with the browser voice, and
    // would be wrong here.
    expect(screen.queryByText(/reads with the browser voice/)).toBeNull();
  });

  it('points the open row at its form', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    open('dashscope');

    const controls = providerToggle('dashscope').getAttribute('aria-controls');
    expect(controls).toBe('provider-form-dashscope');
    expect(document.getElementById(controls as string)).toBeTruthy();
  });

  it('marks the provider in use and says what it is configured with', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.setActiveConfig('dashscope');
    await store.saveSelectedVoice('dashscope', 'longxiaochun');
    await renderPanel(store);

    expect(providerEntry('dashscope').getAttribute('data-active')).toBe('true');
    expect(providerEntry('browser').getAttribute('data-active')).toBe('false');
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

  it('writes a voice the way the list did, and its id when there is no name', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.saveConfig(VOLCENGINE);
    render(
      <ProviderConfigPanel
        store={store}
        providers={providers}
        saved={await store.getConfig()}
        savedConfigs={await store.getSavedConfigs()}
        voices={{ dashscope: 'longxiaochun_v2', volcengine: 'seed-voice' }}
        voiceNames={{ dashscope: { longxiaochun_v2: '龙小春 2.0' } }}
        onChanged={() => {}}
      />
    );

    expect(screen.getByText('Configured · 龙小春 2.0')).toBeTruthy();
    // Typed in by id, so it was never listed under a name: the id is all there
    // is, and showing it beats showing nothing.
    expect(screen.getByText('Configured · seed-voice')).toBeTruthy();
  });

  it('shows the schema summary for a provider that is not configured', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    expect(
      screen.getByText('Uses the voices Chrome already has installed. Nothing to configure.')
    ).toBeTruthy();
    expect(screen.getByText(/Word timings come from the with-timestamps endpoint/)).toBeTruthy();
  });
});

describe('the activation circle', () => {
  it('is one radio group, with one radio per provider', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await store.setActiveConfig('dashscope');
    await renderPanel(store);

    expect(screen.getByRole('radiogroup')).toBeTruthy();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios).toHaveLength(7);
    expect(radios.filter((radio) => radio.checked)).toHaveLength(1);
    expect(providerDot('dashscope').checked).toBe(true);
  });

  it('is named after the service it switches to', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    expect(screen.getByRole('radio', { name: 'Use Browser voice' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Use DashScope (阿里云百炼)' })).toBeTruthy();
  });

  it('activates a provider without opening its form', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    const onChanged = await renderPanel(store);

    fireEvent.click(providerDot('dashscope'));

    await waitFor(async () => expect(await store.getConfig()).toEqual(DASHSCOPE));
    expect(onChanged).toHaveBeenCalled();
    // Two controls, two jobs: choosing a service must not open its form.
    expect(providerToggle('dashscope').getAttribute('aria-expanded')).toBe('false');
  });

  it('creates a default on-device config without choosing a tier', async () => {
    const store = new ConfigStore(memoryArea());
    const onChanged = await renderPanel(store);

    fireEvent.click(providerDot('local'));

    await waitFor(async () => expect(await store.getConfig()).not.toBeNull());
    const config = await store.getConfig();
    expect(config).toMatchObject({ provider: 'local', modelId: 'kokoro-82m', device: 'auto' });
    // Absent, not merely falsy: an explicit `tier` sends `tierFor` down the
    // "the user chose this" path, where the device is never consulted. That is
    // how a GPU without `shader-f16` ended up running fp16 and producing
    // distorted audio that stopped part-way through the sentence.
    expect(config).not.toHaveProperty('tier');

    expect(onChanged).toHaveBeenCalled();
  });

  it('cannot be pressed for a provider with nothing saved', async () => {
    const store = new ConfigStore(memoryArea());
    await store.saveConfig(DASHSCOPE);
    await renderPanel(store);

    // Disabled in the DOM, not only announced: there is no config to switch to.
    expect(providerDot('elevenlabs').disabled).toBe(true);
    expect(
      providerEntry('elevenlabs').querySelector('.status-dot')?.getAttribute('data-state')
    ).toBe('empty');
    expect(providerDot('dashscope').disabled).toBe(false);
  });

  it('offers the browser voice even before anything is saved', async () => {
    await renderPanel(new ConfigStore(memoryArea()));

    expect(providerDot('browser').disabled).toBe(false);
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
    leave(apiKeyField());
    await screen.findByText(
      'Saved, but not in use. Use the circle beside the name to switch to it.'
    );

    // The Settings panel remounts when its tab comes back.
    fireEvent.click(screen.getByRole('tab', { name: 'Reading' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Settings' }));
    await screen.findByLabelText('Interface language');
    open('browser');
    open('dashscope');

    expect(apiKeyField().value).toBe('sk-new');
  });
});
