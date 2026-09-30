/**
 * The side panel shell: a header, a segmented control of tabs, and one page
 * below it.
 *
 * The saved configuration is read once here and passed down, so the Reading tab
 * and the Settings tab cannot disagree about what is configured — a save in one
 * is visible in the other immediately, without a second storage read.
 *
 * This is also the language boundary. The saved language is read here, once,
 * and everything below renders in it.
 */
import type { ComponentType } from 'preact';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { CacheUsage } from '~/lib/cache-admin';
import type { ConfigStore, SavedConfigs, VoiceNames } from '~/lib/config-store';
import { I18nProvider, type MessageKey, useT, useUiLanguage } from '~/lib/i18n';
import type { PermissionsApi } from '~/lib/provider-origins';
import type { AdapterProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig } from '~/lib/providers/types';
import type { SessionWatch } from '~/lib/session-watch';
import type { SettingsStore, UiLang } from '~/lib/settings-store';
import { ReadingTab } from './ReadingTab';
import { SettingsTab } from './SettingsTab';
import { ChevronLeft } from './ui/icons';
import { VoicePickerPage } from './VoicePicker';

export type TabId = 'reading' | 'settings';

/** Tab order, left to right. Reading leads: it is the everyday view. */
const TABS: readonly { id: TabId; labelKey: MessageKey }[] = [
  { id: 'reading', labelKey: 'panel.tab.reading' },
  { id: 'settings', labelKey: 'panel.tab.settings' },
];

/**
 * Which page each tab renders.
 *
 * Keyed by `TabId`, so a tab without a page is a typecheck failure, and the
 * render below is one line whichever tab is selected. The model tab in P4 is a
 * row in `TABS` plus a component here; there is no `if` to add it to.
 */
const TAB_PAGES: Record<TabId, ComponentType<TabPageProps>> = {
  reading: ReadingTab,
  settings: SettingsTab,
};

/** What the shell hands to a tab page. Each page takes the part it needs. */
export interface TabPageProps {
  store: ConfigStore;
  providers: Record<AdapterProviderId, Provider>;
  session: SessionWatch;
  /** Absent in tests, which then render the defaults and save nowhere. */
  settings?: SettingsStore;
  permissions?: PermissionsApi;
  /** Reading the cache's usage and emptying it; absent in tests. */
  cache?: CacheAdmin;
  /** For the about line; absent in tests. */
  version?: string;
  config: ProviderConfig | null;
  savedConfigs: SavedConfigs;
  /** The voice chosen for each provider, for the summary lines. */
  voices: Record<string, string>;
  /** What those voices were listed as, so a summary can show a name. */
  voiceNames: VoiceNames;
  /** The chosen voice for the active provider, if there is one. */
  voice: string | null;
  uiLang: UiLang;
  onUiLang: (next: UiLang) => void;
  /** Something was written; re-read the store. */
  onChanged: () => void;
  /** The Reading tab's shortcut into the settings. */
  onOpenSettings: () => void;
  /** The Reading tab's voice card: switch to the voice picker page. */
  onChangeVoice: () => void;
}

/** The cache, as the settings tab needs it. Built over `lib/cache-admin`. */
export interface CacheAdmin {
  readUsage(): Promise<CacheUsage>;
  clear(): Promise<void>;
}

export interface SidePanelProps {
  store: ConfigStore;
  providers: Record<AdapterProviderId, Provider>;
  session: SessionWatch;
  settings?: SettingsStore;
  /** `chrome.permissions`, for providers that need a host grant. */
  permissions?: PermissionsApi;
  cache?: CacheAdmin;
  version?: string;
}

/**
 * The language boundary.
 *
 * Split from the view below on purpose: a hook reads the context its own
 * component provides, not the value it hands down, so the panel's own copy has
 * to be rendered by a child of the provider it creates.
 */
export function SidePanel({
  store,
  providers,
  session,
  permissions,
  settings,
  cache,
  version,
}: SidePanelProps) {
  const { uiLang, lang, setUiLang } = useUiLanguage(settings);

  return (
    <I18nProvider lang={lang}>
      <SidePanelView
        store={store}
        providers={providers}
        session={session}
        permissions={permissions}
        settings={settings}
        cache={cache}
        version={version}
        uiLang={uiLang}
        onUiLang={setUiLang}
      />
    </I18nProvider>
  );
}

interface SidePanelViewProps extends SidePanelProps {
  uiLang: UiLang;
  onUiLang: (next: UiLang) => void;
}

function SidePanelView({
  store,
  providers,
  session,
  permissions,
  settings,
  cache,
  version,
  uiLang,
  onUiLang,
}: SidePanelViewProps) {
  const t = useT();
  const [tab, setTab] = useState<TabId>('reading');
  const [pickingVoice, setPickingVoice] = useState(false);
  const [config, setConfig] = useState<ProviderConfig | null>(null);
  const [savedConfigs, setSavedConfigs] = useState<SavedConfigs>({});
  const [voices, setVoices] = useState<Record<string, string>>({});
  const [voiceNames, setVoiceNames] = useState<VoiceNames>({});
  const [loading, setLoading] = useState(true);

  /** Re-read the store: the only copy of the saved configs is the store's. */
  const reload = useCallback(async () => {
    try {
      const [loaded, saved, chosen, names] = await Promise.all([
        store.getConfig(),
        store.getSavedConfigs(),
        store.getSelectedVoices(),
        store.getVoiceNames(),
      ]);
      setConfig(loaded);
      setSavedConfigs(saved);
      setVoices(chosen);
      setVoiceNames(names);
    } catch (error) {
      // An unreadable config reads as "not configured": the user can always
      // fill the form in again, and the console has the reason.
      console.error('[SayLoud] cannot read the provider configuration', error);
    }
  }, [store]);

  useEffect(() => {
    void reload().finally(() => setLoading(false));
  }, [reload]);

  if (pickingVoice) {
    return (
      <div class="sidepanel">
        <header class="page-header">
          <button
            type="button"
            class="icon-button"
            aria-label={t('panel.back')}
            onClick={() => setPickingVoice(false)}
          >
            <ChevronLeft />
          </button>
          <h1>{t('voice.section')}</h1>
        </header>
        <main class="panel">
          <VoicePickerPage
            store={store}
            providers={providers}
            config={config}
            onSaved={() => void reload()}
          />
        </main>
      </div>
    );
  }

  const Page = TAB_PAGES[tab];
  const page: TabPageProps = {
    store,
    providers,
    session,
    settings,
    permissions,
    cache,
    version,
    config,
    savedConfigs,
    voices,
    voiceNames,
    voice: config ? (voices[config.provider] ?? null) : null,
    uiLang,
    onUiLang,
    onChanged: () => void reload(),
    onOpenSettings: () => setTab('settings'),
    onChangeVoice: () => setPickingVoice(true),
  };

  return (
    <div class="sidepanel">
      <header class="header">
        <h1>SayLoud</h1>
        <div class="tabs" role="tablist" aria-label={t('panel.sections')}>
          {TABS.map(({ id, labelKey }) => (
            <button
              key={id}
              type="button"
              role="tab"
              id={`tab-${id}`}
              class="tab"
              aria-selected={tab === id}
              // Only the selected tab points at a panel: the others' panels are
              // not mounted, and `aria-controls` on a missing id is a lie.
              aria-controls={tab === id ? `panel-${id}` : undefined}
              onClick={() => setTab(id)}
            >
              {t(labelKey)}
            </button>
          ))}
        </div>
      </header>

      <main class="panel" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {loading ? <p class="muted">{t('panel.loading')}</p> : <Page {...page} />}
      </main>
    </div>
  );
}
