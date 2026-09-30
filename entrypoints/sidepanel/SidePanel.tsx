/**
 * The side panel shell: two tabs over one shared config.
 *
 * The saved configuration is read once here and passed down, so the Reading tab
 * and the Settings tab cannot disagree about what is configured — a save in one
 * is visible in the other immediately, without a second storage read.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ConfigStore, SavedConfigs } from '~/lib/config-store';
import type { PermissionsApi } from '~/lib/provider-origins';
import type { CloudProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig } from '~/lib/providers/types';
import type { SessionWatch } from '~/lib/session-watch';
import { ProviderConfigPanel } from './ProviderConfig';
import { ReadingTab } from './ReadingTab';

export type TabId = 'reading' | 'settings';

/** Tab order, left to right. Reading leads: it is the everyday view. */
const TABS: readonly { id: TabId; label: string }[] = [
  { id: 'reading', label: 'Reading' },
  { id: 'settings', label: 'Settings' },
];

export interface SidePanelProps {
  store: ConfigStore;
  providers: Record<CloudProviderId, Provider>;
  session: SessionWatch;
  /** `chrome.permissions`, for providers that need a host grant. */
  permissions?: PermissionsApi;
}

export function SidePanel({ store, providers, session, permissions }: SidePanelProps) {
  const [tab, setTab] = useState<TabId>('reading');
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [savedConfigs, setSavedConfigs] = useState<SavedConfigs>({});
  const [voice, setVoice] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  /** Re-read the store: the only copy of the saved configs is the store's. */
  const reload = useCallback(async () => {
    try {
      const [loaded, saved] = await Promise.all([store.getConfig(), store.getSavedConfigs()]);
      setConfig(loaded);
      setSavedConfigs(saved);
    } catch (error) {
      // An unreadable config reads as "not configured": the user can always
      // fill the form in again, and the console has the reason.
      console.error('[SayLoud] cannot read the provider configuration', error);
    }
  }, [store]);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  useEffect(() => {
    const provider = config?.provider;
    if (!provider) {
      setVoice(null);
      return;
    }

    let active = true;
    store
      .getSelectedVoice(provider)
      .then((voiceId) => {
        if (active) setVoice(voiceId);
      })
      .catch((error: unknown) => {
        console.error('[SayLoud] cannot read the selected voice', error);
      });
    return () => {
      active = false;
    };
  }, [store, config]);

  return (
    <div class="sidepanel">
      <header class="header">
        <h1>SayLoud</h1>
      </header>

      <div class="tabs" role="tablist" aria-label="SayLoud sections">
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="tab"
            id={`tab-${id}`}
            class="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      <main class="panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === 'reading' ? (
          <ReadingTab
            config={config}
            voice={voice}
            providers={providers}
            session={session}
            loading={loading}
          />
        ) : (
          !loading && (
            <ProviderConfigPanel
              store={store}
              providers={providers}
              saved={config}
              savedConfigs={savedConfigs}
              // The voice effect above follows the active provider.
              onChanged={() => void reload()}
              {...(permissions ? { permissions } : {})}
            />
          )
        )}
      </main>
    </div>
  );
}
