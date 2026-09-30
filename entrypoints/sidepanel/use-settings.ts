/**
 * The saved preferences, as a component's copy of them.
 *
 * The store is the single source of truth — this hook holds no second one, it
 * reads once, follows `storage.onChanged`, and writes back through the store.
 * `update` applies the patch locally first because in tests there is no
 * `onChanged` to come back through, and in the browser the round trip is a tick
 * longer than the user's finger.
 *
 * A patch is merged the same way the store merges it (shallowly, then
 * normalized), so a caller that changes `cache` passes the whole cache object.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type Settings,
  type SettingsStore,
} from '~/lib/settings-store';

export interface SettingsControls {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
}

export function useSettings(store?: SettingsStore): SettingsControls {
  const [settings, setSettings] = useState<Settings>(DEFAULT_SETTINGS);

  useEffect(() => {
    if (!store) return;
    let active = true;

    store
      .load()
      .then((loaded) => {
        if (active) setSettings(loaded);
      })
      .catch((error: unknown) => {
        console.error('[SayLoud] cannot read the saved settings', error);
      });

    const unsubscribe = store.subscribe(setSettings);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [store]);

  const update = useCallback(
    (patch: Partial<Settings>) => {
      setSettings((current) => normalizeSettings({ ...current, ...patch }));
      void store?.update(patch).catch((error: unknown) => {
        console.error('[SayLoud] cannot save the settings', error);
      });
    },
    [store]
  );

  return { settings, update };
}
