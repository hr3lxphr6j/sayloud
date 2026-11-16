/**
 * The Models tab, over a real `ModelStore` and a fake cache.
 *
 * The store is the real one on purpose. The three states a tier can be in are
 * *derived* from Cache Storage rather than from a flag the tab keeps, and that
 * derivation is most of what can go wrong here: a row that says "downloaded"
 * for a tier whose ONNX never arrived is the bug worth catching, and a fake
 * store would have to reimplement the question to let it through.
 *
 * Only the outside world is faked — `chrome.storage.local`, Cache Storage and
 * `fetch` — all of which are constructor arguments precisely so this can work.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { describe, expect, it, vi } from 'vitest';
import { ModelsTab } from '~/entrypoints/sidepanel/ModelsTab';
import { type ModelAdmin, useModelStore } from '~/entrypoints/sidepanel/use-models';
import { ConfigStore, type SavedConfigs } from '~/lib/config-store';
import { fileBytes } from '~/lib/models/downloader';
import { KOKORO_82M, type ModelTier, type OnDeviceModel } from '~/lib/models/registry';
import { MODEL_HOST_LAST_GOOD_KEY, MODEL_SOURCE_KEY, ModelStore } from '~/lib/models/store';
import { canonicalModelUrl, type ModelSource, resolveUrl } from '~/lib/models/urls';
import type { ProviderConfig } from '~/lib/providers/types';
import {
  bytesOf,
  FakeCaches,
  type FakeRoute,
  fakeArea,
  fakeFetch,
  requireTier,
} from './models/fakes';

const fp32 = requireTier(KOKORO_82M, 'fp32');

const HUGGINGFACE: ModelSource = { host: 'huggingface' };

/** The real URL each file of a tier is fetched from, with a tiny body. */
function routesFor(model: OnDeviceModel, tiers: readonly ModelTier[]): Record<string, FakeRoute> {
  const routes: Record<string, FakeRoute> = {};
  for (const tier of tiers) {
    for (const file of tier.files) {
      const url = resolveUrl(canonicalModelUrl(model.repo, file), HUGGINGFACE);
      // Four bytes whatever the file claims to be: the downloader trusts the
      // registry's measured size for progress, so a 325 MB allocation would
      // slow the suite down and prove nothing.
      routes[url] = { bytes: bytesOf(4) };
    }
  }
  return routes;
}

interface Harness {
  readonly models: ModelAdmin;
  readonly store: ConfigStore;
  readonly caches: FakeCaches;
  /** The storage area and its contents, so a test can read what was written. */
  readonly storage: ReturnType<typeof fakeArea>;
  readonly fetch: ReturnType<typeof fakeFetch>;
}

function harness(
  options: {
    saved?: Partial<Record<string, ProviderConfig>>;
    routes?: Record<string, FakeRoute>;
  } = {}
): Harness {
  const storage = fakeArea({
    // A remembered source, so the download starts without the `auto` probe:
    // what is under test here is the tab, not the probe (that has its own
    // suite in `tests/unit/models/store.test.ts`).
    [MODEL_HOST_LAST_GOOD_KEY]: 'huggingface',
  });
  if (options.saved !== undefined) {
    void storage.area.set({ 'sayloud:provider-configs': options.saved });
  }

  const caches = new FakeCaches();
  const fetch = fakeFetch(options.routes ?? routesFor(KOKORO_82M, [fp32]));
  const models: ModelAdmin = {
    store: new ModelStore({ storage: storage.area, cacheStorage: caches, fetch }),
    probe: () => Promise.resolve({ caps: { webgpu: false } }),
  };
  return { models, store: new ConfigStore(storage.area), caches, storage, fetch };
}

/**
 * The tab as the shell renders it.
 *
 * Downloads are owned one level up in the real panel — that is what keeps a
 * tab switch from cancelling one — so the harness runs the same hook the shell
 * does rather than fabricating its state.
 */
function Harness({
  models,
  store,
  config,
  savedConfigs,
  onChanged,
}: {
  models: ModelAdmin;
  store: ConfigStore;
  config: ProviderConfig | null;
  savedConfigs: SavedConfigs;
  onChanged: () => void;
}) {
  const downloads = useModelStore(models);
  return (
    <ModelsTab
      store={store}
      models={models}
      downloads={downloads}
      config={config}
      savedConfigs={savedConfigs}
      onChanged={onChanged}
    />
  );
}

function renderTab(
  options: {
    saved?: Partial<Record<string, ProviderConfig>>;
    config?: ProviderConfig | null;
    routes?: Record<string, FakeRoute>;
    probe?: ModelAdmin['probe'];
  } = {}
) {
  const built = harness(options);
  const models =
    options.probe === undefined ? built.models : { ...built.models, probe: options.probe };
  const saved = options.saved ?? {};
  const onChanged = vi.fn();
  render(
    <Harness
      models={models}
      store={built.store}
      config={options.config ?? null}
      savedConfigs={saved}
      onChanged={onChanged}
    />
  );
  return { ...built, models, onChanged };
}

/** What the storage row says, which is not the same as a tier's own size. */
function storageUsed(): string {
  const label = [...document.querySelectorAll('.row-label')].find(
    (node) => node.textContent === 'Storage used'
  );
  return label?.parentElement?.querySelector('.row-value')?.textContent ?? '';
}

/** The row for a tier, found by the data attribute the list puts on it. */
function tierRow(tier: ModelTier): HTMLElement {
  const row = document.querySelector(`[data-tier="kokoro-82m:${tier.id}"]`);
  if (row === null) throw new Error(`no row for ${tier.id}`);
  return row as HTMLElement;
}

/** A body the test decides the contents of, so progress can be observed. */
function controllableBody() {
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const body = new ReadableStream<Uint8Array>({
    start(next) {
      controller = next;
    },
  });
  return {
    body,
    push: (size: number) => controller?.enqueue(bytesOf(size)),
    close: () => controller?.close(),
  };
}

describe('the model cards', () => {
  it('gives the model a row, with its size', async () => {
    renderTab();

    await screen.findByText('Kokoro 82M');

    // One set of weights, so one row: FP32 is all this build ships.
    expect(document.querySelectorAll('[data-tier]')).toHaveLength(1);
    // 325.5 MB is the ONNX plus the three files it shares with any other tier.
    expect(tierRow(fp32).textContent).toContain('FP32');
    expect(tierRow(fp32).textContent).toContain('325.5 MB');
  });

  it('describes the model, and links its licence', async () => {
    renderTab();
    await screen.findByText('Kokoro 82M');

    expect(screen.getByText(/en-US · en-GB · zh-CN · ja · 41 voices/)).toBeTruthy();
    const licence = screen.getByRole('link', { name: 'Licence: Apache-2.0' });
    expect(licence.getAttribute('href')).toBe('https://www.apache.org/licenses/LICENSE-2.0');
  });

  it('starts not downloaded, with a Download button', async () => {
    renderTab();
    await screen.findByText('Kokoro 82M');

    // The state is derived from Cache Storage, so it starts as "not read yet".
    await waitFor(() => expect(document.querySelectorAll('[data-state=absent]')).toHaveLength(1));
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
  });

  it('marks the tier in use only once its files are there', async () => {
    renderTab({ saved: { local: { provider: 'local', tier: 'fp32' } } });
    await screen.findByText('Kokoro 82M');

    // Chosen but not downloaded: the badge waits for files that are both named
    // and present.
    expect(tierRow(fp32).textContent).not.toContain('In use');
  });

  it('marks a downloaded tier in use', async () => {
    const built = harness({ saved: { local: { provider: 'local', tier: 'fp32' } } });
    for (const file of fp32.files) {
      built.caches.bucket('transformers-cache').seed(canonicalModelUrl(KOKORO_82M.repo, file));
    }
    render(
      <Harness
        models={built.models}
        store={built.store}
        config={{ provider: 'local', tier: 'fp32' }}
        savedConfigs={built.storage.data.get('sayloud:provider-configs') as SavedConfigs}
        onChanged={vi.fn()}
      />
    );

    await screen.findByText('Kokoro 82M');
    await waitFor(() => expect(tierRow(fp32).textContent).toContain('In use'));
    expect(tierRow(fp32).textContent).toContain('Delete');
    expect(tierRow(fp32).textContent).not.toContain('Set as active');
  });

  it('puts no recommendation badge on the only tier', async () => {
    renderTab({ probe: () => Promise.resolve({ caps: { webgpu: true } }) });
    await screen.findByText('Kokoro 82M');

    // There is nothing to recommend it over, and no smaller tier to warn
    // about: both the badge and the "distorts the audio" note retired with
    // q8 and fp16.
    expect(tierRow(fp32).textContent).not.toContain('Recommended');
    expect(tierRow(fp32).textContent).not.toContain('distort');
  });
});

describe('downloading the model', () => {
  it('shows progress, then the files are there and the row says so', async () => {
    const onnxUrl = resolveUrl(canonicalModelUrl(KOKORO_82M.repo, 'onnx/model.onnx'), HUGGINGFACE);
    const body = controllableBody();
    const routes = routesFor(KOKORO_82M, [fp32]);
    routes[onnxUrl] = { body: body.body };
    // The shared files have to answer too.
    routes[resolveUrl(canonicalModelUrl(KOKORO_82M.repo, 'config.json'), HUGGINGFACE)] = {
      bytes: bytesOf(4),
    };

    const built = renderTab({ routes });
    await screen.findByText('Kokoro 82M');

    fireEvent.click(tierRow(fp32).querySelector('button') as HTMLElement);

    // Half of the ONNX is 50% of the tier's declared total.
    body.push(Math.round(fp32.bytes / 2));
    expect(await screen.findByText(/Downloading FP32 · 50%/)).toBeTruthy();

    body.close();
    await waitFor(() => expect(tierRow(fp32).getAttribute('data-state')).toBe('downloaded'));

    // Read from the cache rather than from a flag the tab could have set
    // optimistically: the canonical keys are what the engine will look up.
    const bucket = built.caches.bucket('transformers-cache');
    for (const file of fp32.files) {
      expect(bucket.has(canonicalModelUrl(KOKORO_82M.repo, file))).toBe(true);
    }
  });

  it('counts the bytes it stored as the space used', async () => {
    const built = renderTab({ saved: { local: { provider: 'local', tier: 'fp32' } } });
    await screen.findByText('Kokoro 82M');

    fireEvent.click(tierRow(fp32).querySelector('button') as HTMLElement);
    await waitFor(() => expect(tierRow(fp32).getAttribute('data-state')).toBe('downloaded'));
    await waitFor(() => expect(storageUsed()).toBe('325.5 MB'));

    expect(built.fetch.calls).toContain(
      resolveUrl(canonicalModelUrl(KOKORO_82M.repo, 'onnx/model.onnx'), HUGGINGFACE)
    );
  });

  it('goes back to not downloaded when the user cancels, and says so', async () => {
    const onnxUrl = resolveUrl(canonicalModelUrl(KOKORO_82M.repo, 'onnx/model.onnx'), HUGGINGFACE);
    const routes = routesFor(KOKORO_82M, [fp32]);
    // The source takes its time, so the cancellation lands mid-request — the
    // only moment an `AbortController` can actually stop anything.
    routes[onnxUrl] = { bytes: bytesOf(4), delayMs: 30_000 };

    renderTab({ routes });
    await screen.findByText('Kokoro 82M');

    fireEvent.click(tierRow(fp32).querySelector('button') as HTMLElement);
    await screen.findByText(/Downloading FP32/);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(tierRow(fp32).getAttribute('data-state')).toBe('absent'));
    expect(await screen.findByText('Download cancelled.')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Download' })).toHaveLength(1);
  });

  it('returns the row to not downloaded when the download fails', async () => {
    const onnxUrl = resolveUrl(canonicalModelUrl(KOKORO_82M.repo, 'onnx/model.onnx'), HUGGINGFACE);
    const routes = routesFor(KOKORO_82M, [fp32]);
    routes[onnxUrl] = { status: 500 };

    renderTab({ routes });
    await screen.findByText('Kokoro 82M');

    fireEvent.click(tierRow(fp32).querySelector('button') as HTMLElement);

    await waitFor(() => expect(tierRow(fp32).getAttribute('data-state')).toBe('failed'));
    expect(screen.getByText('Failed to download. Check your connection.')).toBeTruthy();
    // And it can be tried again.
    expect(tierRow(fp32).textContent).toContain('Download');
  });
});

describe('deleting the model', () => {
  it('deletes files that are not in use without asking', async () => {
    const built = harness();
    for (const file of fp32.files) {
      built.caches.bucket('transformers-cache').seed(canonicalModelUrl(KOKORO_82M.repo, file));
    }
    render(
      <Harness
        models={built.models}
        store={built.store}
        config={null}
        savedConfigs={{}}
        onChanged={vi.fn()}
      />
    );

    await waitFor(() => expect(tierRow(fp32).getAttribute('data-state')).toBe('downloaded'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    await waitFor(() => expect(tierRow(fp32).getAttribute('data-state')).toBe('absent'));
  });

  it('warns before deleting the files in use', async () => {
    const built = harness({ saved: { local: { provider: 'local', tier: 'fp32' } } });
    for (const file of fp32.files) {
      built.caches.bucket('transformers-cache').seed(canonicalModelUrl(KOKORO_82M.repo, file));
    }
    const config: ProviderConfig = { provider: 'local', tier: 'fp32' };
    render(
      <Harness
        models={built.models}
        store={built.store}
        config={config}
        savedConfigs={{ local: config }}
        onChanged={vi.fn()}
      />
    );

    await waitFor(() => expect(tierRow(fp32).getAttribute('data-state')).toBe('downloaded'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(
      screen.getByText("After deleting, you'll need to download again to read aloud.")
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Delete anyway' }));

    await waitFor(() => expect(tierRow(fp32).getAttribute('data-state')).toBe('absent'));
    // The config still names the model's only tier: there is nowhere else to
    // point it, so deleting does not rewrite the choice.
    expect(built.storage.data.get('sayloud:provider-configs')).toMatchObject({
      local: { provider: 'local', tier: fp32.id },
    });
  });

  it('leaves everything alone when the warning is dismissed', async () => {
    const built = harness({ saved: { local: { provider: 'local', tier: 'fp32' } } });
    for (const file of fp32.files) {
      built.caches.bucket('transformers-cache').seed(canonicalModelUrl(KOKORO_82M.repo, file));
    }
    render(
      <Harness
        models={built.models}
        store={built.store}
        config={{ provider: 'local', tier: 'fp32' }}
        savedConfigs={{ local: { provider: 'local', tier: 'fp32' } }}
        onChanged={vi.fn()}
      />
    );

    await waitFor(() => expect(tierRow(fp32).textContent).toContain('In use'));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    expect(screen.queryByText(/need to download again/)).toBeNull();
    expect(tierRow(fp32).getAttribute('data-state')).toBe('downloaded');
  });
});

describe('choosing the tier to run', () => {
  it('writes the tier into the saved on-device config', async () => {
    // A config that does not name a tier, which is what activating the local
    // provider writes: the provider falls back to the model's only tier, but the
    // tab has to be able to make that explicit.
    const built = harness();
    for (const file of fp32.files) {
      built.caches.bucket('transformers-cache').seed(canonicalModelUrl(KOKORO_82M.repo, file));
    }
    const onChanged = vi.fn();
    render(
      <Harness
        models={built.models}
        store={built.store}
        config={{ provider: 'local' }}
        savedConfigs={{ local: { provider: 'local' } }}
        onChanged={onChanged}
      />
    );

    await waitFor(() => expect(tierRow(fp32).getAttribute('data-state')).toBe('downloaded'));
    fireEvent.click(screen.getByRole('button', { name: 'Set as active' }));

    await waitFor(() =>
      expect(built.storage.data.get('sayloud:provider-configs')).toMatchObject({
        local: { tier: fp32.id },
      })
    );
    // The panel re-reads the store rather than keeping a copy of the config.
    expect(onChanged).toHaveBeenCalled();
  });
});

describe('the download source', () => {
  it('offers the sources in order, with auto first', async () => {
    renderTab();

    const select = (await screen.findByLabelText('Download source')) as HTMLSelectElement;
    expect([...select.options].map((option) => option.value)).toEqual([
      'auto',
      'huggingface',
      'modelscope',
      'custom',
    ]);
    expect(select.value).toBe('auto');
  });

  it('shows a URL box only for a custom mirror, and rejects anything not http(s)', async () => {
    const built = renderTab();
    const select = (await screen.findByLabelText('Download source')) as HTMLSelectElement;

    fireEvent.change(select, { target: { value: 'custom' } });

    const input = (await screen.findByLabelText('Mirror URL')) as HTMLInputElement;
    expect(input.placeholder).toBe('https://example.com/models');
    // Nothing is stored for a custom source with no URL: it would only fail
    // later, at fetch time, with nothing to explain it.
    expect(screen.getByText('Enter a complete http:// or https:// URL.')).toBeTruthy();
    expect(built.storage.data.get(MODEL_SOURCE_KEY)).toBeUndefined();

    fireEvent.input(input, { target: { value: 'ftp://mirror.test/models' } });
    fireEvent.change(input, { target: { value: 'ftp://mirror.test/models' } });
    expect(screen.getByText('Enter a complete http:// or https:// URL.')).toBeTruthy();
    expect(built.storage.data.get(MODEL_SOURCE_KEY)).toBeUndefined();

    // A self-hosted mirror on this machine has no certificate to offer.
    fireEvent.input(input, { target: { value: 'http://localhost:8080/models' } });
    fireEvent.change(input, { target: { value: 'http://localhost:8080/models' } });
    await waitFor(() =>
      expect(built.storage.data.get(MODEL_SOURCE_KEY)).toEqual({
        host: 'custom',
        customHostUrl: 'http://localhost:8080/models',
      })
    );
  });

  it('keeps a choice made before the saved source has been read', async () => {
    // The read is asynchronous, so a click that lands first would otherwise be
    // undone by it resolving a moment later: the control would snap back to
    // what was saved before the user touched it.
    const storage = fakeArea();
    const pending: Array<() => void> = [];
    const gated = {
      get: (keys: string | string[]) =>
        new Promise<Record<string, unknown>>((resolve) => {
          pending.push(() => void storage.area.get(keys).then(resolve));
        }),
      set: (items: Record<string, unknown>) => storage.area.set(items),
    };
    const models: ModelAdmin = {
      store: new ModelStore({
        storage: gated,
        cacheStorage: new FakeCaches(),
        fetch: fakeFetch(routesFor(KOKORO_82M, [fp32])),
      }),
      probe: () => Promise.resolve({ caps: { webgpu: false } }),
    };
    render(
      <Harness
        models={models}
        store={new ConfigStore(storage.area)}
        config={null}
        savedConfigs={{}}
        onChanged={vi.fn()}
      />
    );

    const select = screen.getByLabelText('Download source') as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'custom' } });
    expect(screen.getByLabelText('Mirror URL')).toBeTruthy();

    // Now let the read finish: it must not put the control back.
    for (const release of pending.splice(0)) release();
    await waitFor(() => expect(select.value).toBe('custom'));
    expect(screen.getByLabelText('Mirror URL')).toBeTruthy();
  });

  it('stores a usable custom mirror and confirms it', async () => {
    const built = renderTab();
    const select = (await screen.findByLabelText('Download source')) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: 'custom' } });

    const input = (await screen.findByLabelText('Mirror URL')) as HTMLInputElement;
    fireEvent.input(input, { target: { value: 'https://mirror.test/models' } });
    fireEvent.change(input, { target: { value: 'https://mirror.test/models' } });

    expect(await screen.findByText('Source saved.')).toBeTruthy();
    expect(built.storage.data.get(MODEL_SOURCE_KEY)).toEqual({
      host: 'custom',
      customHostUrl: 'https://mirror.test/models',
    });
  });
});

describe('device and space', () => {
  it('reports a WASM-only machine', async () => {
    renderTab();

    expect(await screen.findByText('WASM (no GPU)')).toBeTruthy();
    expect(screen.getByText('Used the next time the model loads.')).toBeTruthy();
  });

  it('names the adapter when the browser offers one', async () => {
    renderTab({
      probe: () =>
        Promise.resolve({
          caps: { webgpu: true },
          adapterName: 'apple metal-3',
        }),
    });

    expect(await screen.findByText('WebGPU · apple metal-3')).toBeTruthy();
  });

  it('says so when WebGPU was asked for and is not there', async () => {
    renderTab({ config: { provider: 'local', device: 'webgpu' } });

    expect(await screen.findByText(/no WebGPU/)).toBeTruthy();
  });

  it('counts what the downloaded models actually occupy', async () => {
    const built = harness();
    for (const file of fp32.files) {
      built.caches.bucket('transformers-cache').seed(canonicalModelUrl(KOKORO_82M.repo, file));
    }
    render(
      <Harness
        models={built.models}
        store={built.store}
        config={null}
        savedConfigs={{}}
        onChanged={vi.fn()}
      />
    );

    // The shared files are counted once, with the tier's own weights.
    const expected = fp32.files.reduce((sum, file) => sum + fileBytes(fp32, file), 0);
    await waitFor(() => expect(storageUsed()).toBe(`${(expected / 1_000_000).toFixed(1)} MB`));
    expect(
      screen.getByText('Models and voices. The audio cache is counted on the Settings tab.')
    ).toBeTruthy();
  });

  it('explains that voices are fetched on demand rather than shipping a dead button', async () => {
    renderTab();

    expect(await screen.findByText(/Voices are downloaded on demand/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /voice/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull();
  });
});
