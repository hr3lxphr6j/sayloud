/**
 * The Settings tab: the cache card, which is the part of it that talks to a
 * store of its own.
 *
 * The provider list has its own file, and the language row is covered through
 * `SidePanel`. What is left is the cache: what it reports, how it is emptied,
 * and that the two switches write the settings they claim to.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { SettingsTab } from '~/entrypoints/sidepanel/SettingsTab';
import type { CacheUsage } from '~/lib/cache-admin';
import { ConfigStore, type LocalStorageArea } from '~/lib/config-store';
import type { CloudProviderId } from '~/lib/providers/registry';
import type { Provider } from '~/lib/providers/types';
import { SETTINGS_KEY, SettingsStore } from '~/lib/settings-store';

function memoryArea(initial: Record<string, unknown> = {}): LocalStorageArea {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
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
}

const providers = {
  dashscope: {},
  volcengine: {},
  'openai-compat': {},
  elevenlabs: {},
  azure: {},
} as unknown as Record<CloudProviderId, Provider>;

/** A cache of a known size that records what was asked of it. */
function fakeCache(usage: CacheUsage = { bytes: 13 * 1024 * 1024, entries: 86 }) {
  const state = { usage };
  const clear = vi.fn(async () => {
    state.usage = { bytes: 0, entries: 0 };
  });
  return {
    clear,
    admin: {
      readUsage: vi.fn(async () => state.usage),
      clear,
    },
  };
}

function renderTab({
  cache,
  initial = {},
  version,
}: {
  cache?: ReturnType<typeof fakeCache>['admin'];
  initial?: Record<string, unknown>;
  version?: string;
} = {}) {
  const area = memoryArea(initial);
  const store = new SettingsStore(area);
  render(
    <SettingsTab
      store={new ConfigStore(area)}
      providers={providers}
      config={null}
      savedConfigs={{}}
      voices={{}}
      voiceNames={{}}
      settings={store}
      uiLang="auto"
      onUiLang={() => {}}
      onChanged={() => {}}
      {...(cache ? { cache } : {})}
      {...(version ? { version } : {})}
    />
  );
  return { store };
}

describe('the cache card', () => {
  it('reports what the store holds, in the units the limit is written in', async () => {
    const { admin } = fakeCache({ bytes: 12.4 * 1024 * 1024, entries: 86 });
    renderTab({ cache: admin });

    expect(await screen.findByText('Used 12.4 MB · 86 clips')).toBeTruthy();
    expect(admin.readUsage).toHaveBeenCalled();
  });

  it('says so when the store cannot be read', async () => {
    renderTab({
      cache: {
        readUsage: vi.fn(() => Promise.reject(new Error('blocked'))),
        clear: vi.fn(),
      },
    });

    expect(await screen.findByText('The cache could not be read.')).toBeTruthy();
  });

  it('says that it is the audio cache and not the on-device models', async () => {
    renderTab({ cache: fakeCache().admin });

    expect(screen.getByText('Audio only. On-device models are stored separately.')).toBeTruthy();
  });

  it('asks inside the card before emptying anything', async () => {
    const { admin } = fakeCache();
    renderTab({ cache: admin });

    fireEvent.click(screen.getByRole('button', { name: 'Clear cache' }));

    // No `window.confirm`: the confirmation is a pair of buttons in the card,
    // so nothing has cleared yet.
    expect(screen.getByRole('button', { name: 'Clear' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy();
    expect(admin.clear).not.toHaveBeenCalled();
  });

  it('empties the cache when the confirmation is answered', async () => {
    const { admin } = fakeCache();
    renderTab({ cache: admin });

    fireEvent.click(screen.getByRole('button', { name: 'Clear cache' }));
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));

    await waitFor(() => expect(admin.clear).toHaveBeenCalled());
    expect(await screen.findByText('Cache cleared.')).toBeTruthy();
    // Re-read rather than assumed: the store belongs to another document too.
    expect(await screen.findByText('Used 0 B · 0 clips')).toBeTruthy();
  });

  it('leaves the cache alone when the confirmation is cancelled', async () => {
    const { admin } = fakeCache();
    renderTab({ cache: admin });

    fireEvent.click(screen.getByRole('button', { name: 'Clear cache' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(admin.clear).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });
});

describe('the cache settings', () => {
  it('turns persistence off and on', async () => {
    const { store } = renderTab({ cache: fakeCache().admin });
    await screen.findByText(/Used /);

    const control = screen.getByRole('switch', { name: 'Keep synthesized audio' });
    expect(control.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(control);

    await waitFor(async () => expect((await store.load()).cache.persist).toBe(false));
    // The limit is part of the same object, and turning persistence off must
    // not quietly reset it to the default.
    expect((await store.load()).cache.maxBytes).toBe(200 * 1024 * 1024);
  });

  it('explains what turning persistence off does', async () => {
    renderTab({
      cache: fakeCache().admin,
      initial: { [SETTINGS_KEY]: { cache: { persist: false } } },
    });

    expect(
      await screen.findByText('Off deletes the saved audio and stops new audio from being written.')
    ).toBeTruthy();
  });

  it('offers the four sizes and saves the one chosen', async () => {
    const { store } = renderTab({ cache: fakeCache().admin });
    await screen.findByText(/Used /);

    const limit = screen.getByLabelText('Limit') as HTMLSelectElement;
    expect([...limit.options].map((option) => option.textContent)).toEqual([
      '50 MB',
      '100 MB',
      '200 MB',
      '500 MB',
    ]);

    fireEvent.change(limit, { target: { value: String(500 * 1024 * 1024) } });

    await waitFor(async () => expect((await store.load()).cache.maxBytes).toBe(500 * 1024 * 1024));
  });
});

describe('the about line', () => {
  it('names the version when it has one', () => {
    renderTab({ version: '0.3.0' });

    expect(
      screen.getByText('SayLoud 0.3.0 · MIT · Audio goes only to the service you configure.')
    ).toBeTruthy();
  });

  it('does without a version in the tests that have no manifest', () => {
    renderTab();

    expect(
      screen.getByText('SayLoud · MIT · Audio goes only to the service you configure.')
    ).toBeTruthy();
  });
});
