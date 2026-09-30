/**
 * The on-device model's two questions, as hooks both tabs can ask.
 *
 * The Reading tab wants to know two things about the machine — is the model
 * downloaded, and will it have a GPU — and the Models tab wants the same
 * device answer to pick a recommended tier. Answering them here keeps the two
 * tabs from drifting into two different ideas of "ready".
 *
 * Neither hook touches ONNX Runtime. They read Cache Storage and
 * `navigator.gpu`, both of which exist in a side panel, and the model tab's
 * whole job is to move bytes around — the engine itself only ever runs in the
 * offscreen document's worker.
 */
import { useCallback, useEffect, useRef, useState } from 'preact/hooks';
import type { Device, DevicePreference, DeviceProbe } from '~/lib/models/device';
import { resolveDevice } from '~/lib/models/device';
import { fileBytes, isCancellation } from '~/lib/models/downloader';
import { MODELS, type ModelTier, type OnDeviceModel } from '~/lib/models/registry';
import type { ModelStore, ModelUsage } from '~/lib/models/store';
import { isProviderError } from '~/lib/providers/errors';
import type { AdapterProviderId } from '~/lib/providers/registry';
import type { LocalConfig, Provider, ProviderConfig } from '~/lib/providers/types';

/**
 * The model manager as a tab needs it.
 *
 * Built in the panel's entry point, like the cache admin: the components take
 * narrow interfaces so they stay callable with plain fakes, and nothing here
 * has to know that `chrome.storage` is where the source choice lives.
 */
export interface ModelAdmin {
  readonly store: ModelStore;
  /** What this machine can do. Never rejects: no GPU is an answer too. */
  probe(): Promise<DeviceProbe>;
}

/** What the machine can do, and which device that means for a preference. */
export interface DeviceState {
  readonly probe: DeviceProbe;
  /**
   * The device the engine will use, or null when the user asked for one this
   * machine does not have. Null is a real state, not a failure: it is the one
   * case where the device line has something to tell the user to change.
   */
  readonly device: Device | null;
}

/**
 * Probe the machine once, and resolve the preference against it.
 *
 * Probing is cheap but not free — it asks the GPU for an adapter — so it runs
 * once per preference rather than on every render.
 */
export function useDevice(
  models: ModelAdmin | undefined,
  preference: DevicePreference
): DeviceState | null {
  const [state, setState] = useState<DeviceState | null>(null);

  useEffect(() => {
    if (!models) {
      setState(null);
      return;
    }

    let active = true;
    models
      .probe()
      .then((probe) => {
        if (!active) return;
        setState({ probe, device: deviceFor(preference, probe) });
      })
      .catch((error: unknown) => {
        // `probeDevice` answers "no GPU" rather than throwing, so this is a
        // wiring bug; the device line falls back to "Not loaded".
        console.error('[SayLoud] cannot probe the device', error);
      });

    return () => {
      active = false;
    };
  }, [models, preference]);

  return state;
}

/** The device for a preference, or null when the machine cannot honour it. */
function deviceFor(preference: DevicePreference, probe: DeviceProbe): Device | null {
  try {
    return resolveDevice(preference, probe.caps);
  } catch {
    // Only `webgpu` on a machine without it throws. That is worth showing
    // rather than papering over: the setting is the only thing that can change.
    return null;
  }
}

/** Whether the on-device configuration could speak right now. */
export type LocalReadiness =
  /** The chosen tier's files are all in Cache Storage. */
  | 'ready'
  /** The tier has not been downloaded. The one case with an obvious fix. */
  | 'missing'
  /** Anything else: an unreadable store, or a model this build does not have. */
  | 'unknown';

/**
 * Ask the provider the same question playback will ask.
 *
 * Deliberately not a second implementation of "is it downloaded": the local
 * provider's `validate` is the check the engine runs before it synthesizes, so
 * the panel and the engine cannot end up disagreeing about whether the user is
 * about to wait for a model or get an error.
 *
 * Re-checked on every visit to the tab, because a tab switch remounts the page
 * component: coming back from the Models tab after a download is what makes the
 * notice go away.
 */
export function useLocalReadiness(
  config: ProviderConfig | null,
  providers: Record<AdapterProviderId, Provider>
): LocalReadiness | null {
  const [readiness, setReadiness] = useState<LocalReadiness | null>(null);
  const provider = providers.local;

  useEffect(() => {
    if (config?.provider !== 'local' || typeof provider?.validate !== 'function') {
      setReadiness(null);
      return;
    }

    let active = true;
    const controller = new AbortController();
    provider.validate(config, controller.signal).then(
      () => {
        if (active) setReadiness('ready');
      },
      (error: unknown) => {
        if (!active) return;
        setReadiness(
          isProviderError(error) && error.code === 'model-missing' ? 'missing' : 'unknown'
        );
      }
    );

    return () => {
      active = false;
      // The provider ignores the signal today; aborting is what keeps a future
      // one that does not from leaving a request behind on every tab switch.
      controller.abort();
    };
  }, [config, provider]);

  return readiness;
}

/**
 * The saved on-device configuration, whichever way it is reachable.
 *
 * The active config when the local provider is the one in use, and otherwise
 * the last one saved for it: the Models tab changes the model and tier whether
 * or not the provider has been switched on yet, and it has to write to the same
 * place the provider will read.
 */
export function localConfigOf(
  config: ProviderConfig | null,
  savedConfigs: Partial<Record<string, ProviderConfig>>
): LocalConfig | null {
  const saved = savedConfigs.local;
  const candidate = config?.provider === 'local' ? config : saved;
  return candidate?.provider === 'local' ? candidate : null;
}

/** One tier of one model, as the panel addresses it. */
export function tierKey(model: OnDeviceModel, tier: ModelTier): string {
  return `${model.id}:${tier.id}`;
}

/** What is known about one tier. `unknown` until the cache has been read. */
export type TierStatus =
  | { readonly kind: 'unknown' }
  /** Not in Cache Storage. `cancelled` when the user is why. */
  | { readonly kind: 'absent'; readonly cancelled?: boolean }
  | { readonly kind: 'downloaded' }
  | { readonly kind: 'downloading'; readonly bytes: number; readonly totalBytes: number }
  | { readonly kind: 'failed'; readonly detail: string };

/** What the Models tab reads and does. */
export interface ModelStoreView {
  readonly statuses: Readonly<Record<string, TierStatus>>;
  readonly usage: ModelUsage | null;
  /** The store could not be read at all, which the tab says plainly. */
  readonly failed: boolean;
  start(model: OnDeviceModel, tier: ModelTier): void;
  cancel(model: OnDeviceModel, tier: ModelTier): void;
  remove(model: OnDeviceModel, tier: ModelTier): Promise<void>;
}

/**
 * Download state, owned by the panel shell rather than by the Models page.
 *
 * The page is unmounted whenever the user looks at another tab, and Chrome has
 * no way to keep a `fetch` alive across that — so the controllers live one
 * level up, where a tab switch cannot reach them. Cancelling is the panel
 * unmounting, which is what closing the side panel does; leaving the download
 * running after the user closed the panel is not possible, and pretending
 * otherwise would only hide the failure.
 */
export function useModelStore(models: ModelAdmin | undefined): ModelStoreView {
  const store = models?.store;
  const [statuses, setStatuses] = useState<Record<string, TierStatus>>({});
  const [usage, setUsage] = useState<ModelUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const controllers = useRef(new Map<string, AbortController>());
  /** False once the shell is gone, so a late reply writes nothing. */
  const mounted = useRef(true);

  const readUsage = useCallback(async (): Promise<void> => {
    if (!store) return;
    try {
      const measured = await store.usage();
      if (mounted.current) setUsage(measured);
    } catch (error) {
      console.error('[SayLoud] cannot measure the model store', error);
      if (mounted.current) setFailed(true);
    }
  }, [store]);

  /**
   * Re-read which tiers are complete.
   *
   * A tier mid-download is left alone: its files arrive one at a time, so
   * reading the cache now would flip the row back to "not downloaded" while
   * the download it is describing is still running.
   */
  const refresh = useCallback(async (): Promise<void> => {
    if (!store) return;
    try {
      const [measured, ...perModel] = await Promise.all([
        store.usage(),
        ...MODELS.map((model) => store.downloadedTiers(model)),
      ]);
      if (!mounted.current) return;
      setUsage(measured);
      setFailed(false);
      setStatuses((current) => mergedTiers(current, perModel));
    } catch (error) {
      console.error('[SayLoud] cannot read the model store', error);
      if (mounted.current) setFailed(true);
    }
  }, [store]);

  useEffect(() => {
    mounted.current = true;
    void refresh();

    const inFlight = controllers.current;
    return () => {
      mounted.current = false;
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    };
  }, [refresh]);

  const start = useCallback(
    (model: OnDeviceModel, tier: ModelTier): void => {
      if (!store) return;
      const key = tierKey(model, tier);
      if (controllers.current.has(key)) return;

      const controller = new AbortController();
      controllers.current.set(key, controller);
      setStatuses((current) => ({
        ...current,
        [key]: { kind: 'downloading', bytes: 0, totalBytes: tierTotalBytes(tier) },
      }));

      store
        .downloadTier(model, tier, {
          signal: controller.signal,
          onProgress: (progress) => {
            if (!mounted.current) return;
            setStatuses((current) => ({
              ...current,
              [key]: {
                kind: 'downloading',
                bytes: progress.bytes,
                totalBytes: progress.totalBytes,
              },
            }));
          },
        })
        .then(
          () => {
            controllers.current.delete(key);
            if (!mounted.current) return;
            setStatuses((current) => ({ ...current, [key]: { kind: 'downloaded' } }));
            void readUsage();
          },
          (error: unknown) => {
            controllers.current.delete(key);
            if (!mounted.current) return;
            // Cancelling is the user's decision, not a failure: the row goes
            // back to where it started, with a line saying what happened.
            if (isCancellation(error)) {
              setStatuses((current) => ({
                ...current,
                [key]: { kind: 'absent', cancelled: true },
              }));
              return;
            }
            console.error('[SayLoud] the model download failed', error);
            setStatuses((current) => ({
              ...current,
              [key]: { kind: 'failed', detail: detailOf(error) },
            }));
          }
        );
    },
    [store, readUsage]
  );

  const cancel = useCallback((model: OnDeviceModel, tier: ModelTier): void => {
    controllers.current.get(tierKey(model, tier))?.abort();
  }, []);

  const remove = useCallback(
    async (model: OnDeviceModel, tier: ModelTier): Promise<void> => {
      if (!store) return;
      await store.deleteTier(model, tier);
      if (!mounted.current) return;
      setStatuses((current) => ({
        ...current,
        [tierKey(model, tier)]: { kind: 'absent' },
      }));
      void readUsage();
    },
    [store, readUsage]
  );

  return { statuses, usage, failed, start, cancel, remove };
}

/** The tiers that are completely present, merged over what was already known. */
function mergedTiers(
  current: Readonly<Record<string, TierStatus>>,
  perModel: readonly (readonly ModelTier[])[]
): Record<string, TierStatus> {
  const next: Record<string, TierStatus> = {};

  MODELS.forEach((model, index) => {
    const downloaded = new Set((perModel[index] ?? []).map((tier) => tier.id));
    for (const tier of model.tiers ?? []) {
      const key = tierKey(model, tier);
      const previous = current[key];
      if (previous?.kind === 'downloading') {
        next[key] = previous;
        continue;
      }
      if (!downloaded.has(tier.id)) {
        next[key] = previous?.kind === 'absent' ? previous : { kind: 'absent' };
        continue;
      }
      next[key] = { kind: 'downloaded' };
    }
  });

  return next;
}

/** The tier's own files plus the ones every tier shares, as the downloader counts them. */
function tierTotalBytes(tier: ModelTier): number {
  return tier.files.reduce((sum, file) => sum + fileBytes(tier, file), 0);
}

function detailOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
