/**
 * The Reading tab: the voice card, the two sliders and the caption switch.
 *
 * The sliders are the interesting part. A drag must move the number on screen
 * without writing anything, and only the release may reach storage — otherwise
 * one gesture would wake the service worker thirty times for a value the user
 * has not settled on.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { ReadingTab } from '~/entrypoints/sidepanel/ReadingTab';
import type { ModelAdmin } from '~/entrypoints/sidepanel/use-models';
import type { LocalStorageArea } from '~/lib/config-store';
import { ProviderError } from '~/lib/providers/errors';
import type { AdapterProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig } from '~/lib/providers/types';
import type { SessionWatch } from '~/lib/session-watch';
import { SETTINGS_KEY, type Settings, SettingsStore } from '~/lib/settings-store';

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

function fakeProvider(timings: 'exact' | 'none' = 'exact'): Provider {
  return {
    capabilities: () => ({ timings, maxChars: 100, concurrency: 1 }),
    validate: vi.fn(() => Promise.resolve()),
    listVoices: vi.fn(() => Promise.resolve([])),
  } as unknown as Provider;
}

const providers = {
  dashscope: fakeProvider('exact'),
  volcengine: fakeProvider(),
  'openai-compat': fakeProvider(),
  elevenlabs: fakeProvider(),
  azure: fakeProvider(),
  local: fakeProvider(),
} as Record<AdapterProviderId, Provider>;

/** No session: the tab renders its "nothing is being read" line. */
const IDLE_SESSION = {
  subscribe: () => () => {},
  load: async () => null,
} as unknown as SessionWatch;

const DASHSCOPE: ProviderConfig = { provider: 'dashscope', apiKey: 'sk-1' };

interface RenderOptions {
  config?: ProviderConfig | null;
  voice?: string | null;
  /** Remembered voice names, by provider then voice id. */
  voiceNames?: Record<string, Record<string, string>>;
  stored?: Partial<Settings>;
  session?: SessionWatch;
  /** Overridden when the provider's own answer is what is under test. */
  providers?: Record<AdapterProviderId, Provider>;
  models?: ModelAdmin;
  onOpenModels?: () => void;
}

async function renderTab({
  config = null,
  voice = null,
  voiceNames = {},
  stored = {},
  session = IDLE_SESSION,
  providers: registry = providers,
  models,
  onOpenModels,
}: RenderOptions = {}) {
  const { area } = fakeArea({ [SETTINGS_KEY]: stored });
  const store = new SettingsStore(area);
  const onOpenSettings = vi.fn();
  const onChangeVoice = vi.fn();
  render(
    <ReadingTab
      config={config}
      voice={voice}
      voiceNames={voiceNames}
      providers={registry}
      session={session}
      settings={store}
      onOpenSettings={onOpenSettings}
      onChangeVoice={onChangeVoice}
      {...(models === undefined ? {} : { models })}
      {...(onOpenModels === undefined ? {} : { onOpenModels })}
    />
  );
  // The settings read lands a tick later; waiting for it keeps the slider
  // assertions below from racing the defaults.
  await waitFor(() => expect(screen.getByLabelText('Volume')).toBeTruthy());
  return { store, onOpenSettings, onChangeVoice };
}

describe('the voice card', () => {
  it('shows the service and how it highlights', async () => {
    await renderTab({ config: DASHSCOPE, voice: 'longxiaochun' });

    expect(screen.getByText('longxiaochun')).toBeTruthy();
    expect(screen.getByText('DashScope (阿里云百炼) · Word by word')).toBeTruthy();
  });

  it('falls back to the default voice before one is chosen', async () => {
    await renderTab({ config: DASHSCOPE });

    expect(screen.getByText('Default voice')).toBeTruthy();
  });

  it('shows the name a voice was listed under', async () => {
    await renderTab({
      config: DASHSCOPE,
      voice: 'longxiaochun_v2',
      voiceNames: { dashscope: { longxiaochun_v2: '龙小春 2.0' } },
    });

    expect(screen.getByText('龙小春 2.0')).toBeTruthy();
    expect(screen.queryByText('longxiaochun_v2')).toBeNull();
  });

  it('falls back to the voice id when it was never picked from a list', async () => {
    await renderTab({ config: DASHSCOPE, voice: 'S_cloned_voice' });

    expect(screen.getByText('S_cloned_voice')).toBeTruthy();
  });

  it('opens the voice picker when pressed', async () => {
    const { onChangeVoice } = await renderTab({ config: DASHSCOPE, voice: 'longxiaochun' });

    fireEvent.click(screen.getByRole('button', { name: /longxiaochun/ }));

    expect(onChangeVoice).toHaveBeenCalled();
  });

  it('offers to configure a service when there is none, and opens the settings', async () => {
    const { onOpenSettings } = await renderTab();

    expect(
      screen.getByText('No provider is configured. Open Settings to choose one.')
    ).toBeTruthy();
    expect(screen.queryByText('Volume')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Configure a service' }));

    expect(onOpenSettings).toHaveBeenCalled();
  });

  it('treats the browser voice as unconfigured, and says what its ceiling is', async () => {
    await renderTab({ config: { provider: 'browser' } });

    expect(screen.getByText('The browser voice tops out at 100%.')).toBeTruthy();
  });

  it('says it is reading with the browser voice when that is the deliberate choice', async () => {
    await renderTab({ config: { provider: 'browser' } });

    // Choosing the browser voice is an action, so the notice must not read as
    // if nothing was configured — but there is still a service to configure,
    // which is why the button stays.
    expect(
      screen.getByText('No cloud service is configured. SayLoud is reading with the browser voice.')
    ).toBeTruthy();
    expect(
      screen.queryByText('No provider is configured. Open Settings to choose one.')
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Configure a service' })).toBeTruthy();
  });
});

describe('the volume slider', () => {
  it('shows the stored value as a percentage', async () => {
    await renderTab({ config: DASHSCOPE, stored: { volume: 0.5 } });

    const slider = screen.getByLabelText('Volume');
    expect((slider as HTMLInputElement).value).toBe('0.5');
    // The readable value is what a screen reader announces, so `0.5` never
    // reaches the user.
    expect(slider.getAttribute('aria-valuetext')).toBe('50%');
  });

  it('moves the display on every step without saving anything', async () => {
    const { store } = await renderTab({ config: DASHSCOPE, stored: { volume: 1 } });

    fireEvent.input(screen.getByLabelText('Volume'), { target: { value: '1.5' } });

    expect(screen.getByText('150%')).toBeTruthy();
    expect((await store.load()).volume).toBe(1);
  });

  it('saves the value the handle was released on', async () => {
    const { store } = await renderTab({ config: DASHSCOPE, stored: { volume: 1 } });

    fireEvent.input(screen.getByLabelText('Volume'), { target: { value: '1.5' } });
    fireEvent.change(screen.getByLabelText('Volume'), { target: { value: '0' } });

    expect(screen.getByText('0%')).toBeTruthy();
    await waitFor(async () => expect((await store.load()).volume).toBe(0));
  });

  it('reaches the top of its range', async () => {
    await renderTab({ config: DASHSCOPE });

    expect(screen.getByLabelText('Volume').getAttribute('max')).toBe('1.5');
    expect(screen.getByLabelText('Volume').getAttribute('min')).toBe('0');
  });
});

describe('the rate slider', () => {
  it('shows the rate the way the player writes it', async () => {
    await renderTab({ config: DASHSCOPE, stored: { rate: 1.5 } });

    expect(screen.getByLabelText('Speed').getAttribute('aria-valuetext')).toBe('1.5×');
  });

  it('only saves on release', async () => {
    const { store } = await renderTab({ config: DASHSCOPE, stored: { rate: 1 } });

    fireEvent.input(screen.getByLabelText('Speed'), { target: { value: '2' } });
    expect(screen.getByText('2×')).toBeTruthy();
    expect((await store.load()).rate).toBe(1);

    fireEvent.change(screen.getByLabelText('Speed'), { target: { value: '2' } });
    await waitFor(async () => expect((await store.load()).rate).toBe(2));
  });

  it('spans the range the settings store accepts', async () => {
    await renderTab({ config: DASHSCOPE });

    const slider = screen.getByLabelText('Speed');
    expect(slider.getAttribute('min')).toBe('0.5');
    expect(slider.getAttribute('max')).toBe('3');
  });
});

describe('the caption switch', () => {
  it('starts off and saves what it is set to', async () => {
    const { store } = await renderTab({ config: DASHSCOPE });

    const control = screen.getByRole('switch', { name: 'Caption window' });
    expect(control.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(control);

    expect(control.getAttribute('aria-checked')).toBe('true');
    await waitFor(async () => expect((await store.load()).captionWindow).toBe(true));
  });
});

/**
 * The on-device provider's two notices.
 *
 * Both are driven by a question the provider answers, not by a copy of its
 * logic: `validate()` is the check the engine runs before it synthesizes, so
 * the panel cannot end up disagreeing with playback about whether the model is
 * ready.
 */
describe('the on-device notices', () => {
  const LOCAL: ProviderConfig = { provider: 'local', tier: 'q8' };

  function providerThat(validate: () => Promise<void>): Record<AdapterProviderId, Provider> {
    return { ...providers, local: { ...fakeProvider(), validate: vi.fn(validate) } as Provider };
  }

  it('offers the Models tab when the tier has not been downloaded', async () => {
    const onOpenModels = vi.fn();
    await renderTab({
      config: LOCAL,
      providers: providerThat(() => Promise.reject(new ProviderError('model-missing', 'absent'))),
      onOpenModels,
    });

    expect(await screen.findByText('Model not downloaded yet')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Go to model settings ›' }));

    expect(onOpenModels).toHaveBeenCalledTimes(1);
  });

  it('says nothing once the model is there', async () => {
    await renderTab({
      config: LOCAL,
      providers: providerThat(() => Promise.resolve()),
    });

    await waitFor(() => expect(screen.getByLabelText('Volume')).toBeTruthy());
    expect(screen.queryByText('Model not downloaded yet')).toBeNull();
  });

  it('stays quiet for a provider that is not the on-device one', async () => {
    await renderTab({
      config: DASHSCOPE,
      providers: providerThat(() => Promise.reject(new ProviderError('model-missing', 'absent'))),
    });

    expect(providers.local.validate).not.toHaveBeenCalled();
    expect(screen.queryByText('Model not downloaded yet')).toBeNull();
  });

  it('warns that a machine without a GPU will be slower', async () => {
    // `probeDevice` reads `navigator.gpu`, which happy-dom does not implement,
    // so the probe honestly reports the WASM-only machine this test wants.
    await renderTab({
      config: LOCAL,
      providers: providerThat(() => Promise.resolve()),
      models: {
        store: {} as never,
        probe: () => Promise.resolve({ caps: { webgpu: false, shaderF16: false } }),
      },
    });

    expect(await screen.findByText(/no GPU acceleration/)).toBeTruthy();
  });

  it('does not warn once WebGPU is available', async () => {
    await renderTab({
      config: LOCAL,
      providers: providerThat(() => Promise.resolve()),
      models: {
        store: {} as never,
        probe: () => Promise.resolve({ caps: { webgpu: true, shaderF16: true } }),
      },
    });

    await waitFor(() => expect(screen.getByLabelText('Volume')).toBeTruthy());
    expect(screen.queryByText(/no GPU acceleration/)).toBeNull();
  });
});
