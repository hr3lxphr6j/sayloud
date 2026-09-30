/**
 * The side panel shell: two tabs over one shared config.
 *
 * The saved configuration is read once here and passed down, so the Reading tab
 * and the Settings tab cannot disagree about what is configured — a save in one
 * is visible in the other immediately, without a second storage read.
 *
 * This is also the language boundary. The saved language is read here, once,
 * and everything below renders in it.
 */
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { ConfigStore, SavedConfigs } from '~/lib/config-store';
import { I18nProvider, type MessageKey, useT, useUiLanguage } from '~/lib/i18n';
import type { PermissionsApi } from '~/lib/provider-origins';
import type { CloudProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig } from '~/lib/providers/types';
import type { SessionWatch } from '~/lib/session-watch';
import type { SettingsStore, UiLang } from '~/lib/settings-store';
import { ProviderConfigPanel } from './ProviderConfig';
import { ReadingTab } from './ReadingTab';

export type TabId = 'reading' | 'settings';

/** Tab order, left to right. Reading leads: it is the everyday view. */
const TABS: readonly { id: TabId; labelKey: MessageKey }[] = [
  { id: 'reading', labelKey: 'panel.tab.reading' },
  { id: 'settings', labelKey: 'panel.tab.settings' },
];

export interface SidePanelProps {
  store: ConfigStore;
  providers: Record<CloudProviderId, Provider>;
  session: SessionWatch;
  /** Absent in tests, which then render in English. */
  settings?: SettingsStore;
  /** `chrome.permissions`, for providers that need a host grant. */
  permissions?: PermissionsApi;
}

/**
 * The language boundary.
 *
 * Split from the view below on purpose: a hook reads the context its own
 * component provides, not the value it hands down, so the panel's own copy has
 * to be rendered by a child of the provider it creates.
 */
export function SidePanel({ store, providers, session, permissions, settings }: SidePanelProps) {
  const { uiLang, lang, setUiLang } = useUiLanguage(settings);

  return (
    <I18nProvider lang={lang}>
      <SidePanelView
        store={store}
        providers={providers}
        session={session}
        permissions={permissions}
        uiLang={uiLang}
        onUiLang={setUiLang}
      />
    </I18nProvider>
  );
}

interface SidePanelViewProps extends Omit<SidePanelProps, 'settings'> {
  uiLang: UiLang;
  onUiLang: (next: UiLang) => void;
}

function SidePanelView({
  store,
  providers,
  session,
  permissions,
  uiLang,
  onUiLang,
}: SidePanelViewProps) {
  const t = useT();
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

      <div class="tabs" role="tablist" aria-label={t('panel.sections')}>
        {TABS.map(({ id, labelKey }) => (
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
            {t(labelKey)}
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
            <div class="stack">
              <LanguageRow uiLang={uiLang} onChange={onUiLang} />
              <ProviderConfigPanel
                store={store}
                providers={providers}
                saved={config}
                savedConfigs={savedConfigs}
                // The voice effect above follows the active provider.
                onChanged={() => void reload()}
                {...(permissions ? { permissions } : {})}
              />
            </div>
          )
        )}
      </main>
    </div>
  );
}

/**
 * The interface language.
 *
 * A plain select for now: the settings tab is being redesigned separately, and
 * this only has to be usable in the meantime. `auto` is the default, and the
 * browser decides what it means.
 */
function LanguageRow({ uiLang, onChange }: { uiLang: UiLang; onChange: (next: UiLang) => void }) {
  const t = useT();

  return (
    <section class="section">
      <h2>{t('settings.language.label')}</h2>
      <select
        id="ui-lang"
        aria-label={t('settings.language.label')}
        value={uiLang}
        onChange={(event) => onChange(event.currentTarget.value as UiLang)}
      >
        <option value="auto">{t('settings.language.auto')}</option>
        <option value="en">{t('settings.language.en')}</option>
        <option value="zh-CN">{t('settings.language.zh')}</option>
      </select>
    </section>
  );
}
