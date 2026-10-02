/**
 * The Settings tab: what is configured, and what is kept.
 *
 * Everything that survives a restart of the extension lives here — the service
 * credentials, the interface language, and the audio cache. The things that are
 * adjusted while reading (volume, rate, the caption switch) are on the Reading
 * tab, next to the voice they apply to.
 */
import { useEffect, useState } from 'preact/hooks';
import type { CacheUsage } from '~/lib/cache-admin';
import type { ConfigStore, SavedConfigs, VoiceNames } from '~/lib/config-store';
import { formatBytes } from '~/lib/format-bytes';
import { useT } from '~/lib/i18n';
import type { PermissionsApi } from '~/lib/provider-origins';
import type { AdapterProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig } from '~/lib/providers/types';
import {
  MAX_BYTES_CHOICES,
  type Settings,
  type SettingsStore,
  type UiLang,
} from '~/lib/settings-store';
import { ProviderConfigPanel } from './ProviderConfig';
import type { CacheAdmin } from './SidePanel';
import { Card } from './ui/Card';
import { Row } from './ui/Row';
import { Switch } from './ui/Switch';
import { useSettings } from './use-settings';

export interface SettingsTabProps {
  store: ConfigStore;
  providers: Record<AdapterProviderId, Provider>;
  /** The active config, which decides which row opens first. */
  config: ProviderConfig | null;
  savedConfigs: SavedConfigs;
  /** The voice chosen for each provider, for the summary lines. */
  voices: Record<string, string>;
  /** What those voices were listed as, so a summary can show a name. */
  voiceNames: VoiceNames;
  settings?: SettingsStore;
  uiLang: UiLang;
  onUiLang: (next: UiLang) => void;
  onChanged: () => void;
  permissions?: PermissionsApi;
  cache?: CacheAdmin;
  version?: string;
}

export function SettingsTab({
  store,
  providers,
  config,
  savedConfigs,
  voices,
  voiceNames,
  settings,
  uiLang,
  onUiLang,
  onChanged,
  permissions,
  cache,
  version,
}: SettingsTabProps) {
  const t = useT();
  const { settings: preferences, update } = useSettings(settings);

  return (
    <div class="stack">
      <Card title={t('provider.section.title')}>
        <ProviderConfigPanel
          store={store}
          providers={providers}
          saved={config}
          savedConfigs={savedConfigs}
          voices={voices}
          voiceNames={voiceNames}
          onChanged={onChanged}
          {...(permissions ? { permissions } : {})}
        />
      </Card>

      <CacheCard cache={cache} preferences={preferences} update={update} />

      <Card title={t('settings.language.label')}>
        <select
          id="ui-lang"
          aria-label={t('settings.language.label')}
          value={uiLang}
          onChange={(event) => onUiLang(event.currentTarget.value as UiLang)}
        >
          <option value="auto">{t('settings.language.auto')}</option>
          <option value="en">{t('settings.language.en')}</option>
          <option value="ja">{t('settings.language.ja')}</option>
          <option value="zh-CN">{t('settings.language.zh')}</option>
        </select>
      </Card>

      <p class="muted small">
        {version === undefined ? t('settings.about.plain') : t('settings.about.line', { version })}
      </p>
    </div>
  );
}

interface CacheCardProps {
  cache?: CacheAdmin;
  preferences: Settings;
  update: (patch: Partial<Settings>) => void;
}

/**
 * The audio cache: how much is there, how much may be, and how to empty it.
 *
 * Only the audio: the on-device models P4 adds live in Cache Storage and are
 * counted on their own tab. The note in the card says so, because a user who
 * clears this one and expects the model's 90MB back would file a bug.
 */
function CacheCard({ cache, preferences, update }: CacheCardProps) {
  const t = useT();
  const [usage, setUsage] = useState<CacheUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [cleared, setCleared] = useState(false);
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    if (!cache) return;
    let active = true;

    cache
      .readUsage()
      .then((measured) => {
        if (active) setUsage(measured);
      })
      .catch((error: unknown) => {
        console.error('[SayLoud] cannot read the cache usage', error);
        if (active) setFailed(true);
      });

    return () => {
      active = false;
    };
  }, [cache]);

  const onClear = async () => {
    if (!cache) return;
    setClearing(true);
    try {
      await cache.clear();
      // Re-read rather than assuming zero: the store is shared with the
      // offscreen document, and it is the one that knows what is left.
      setUsage(await cache.readUsage());
      setConfirming(false);
      setCleared(true);
    } catch (error) {
      console.error('[SayLoud] cannot clear the cache', error);
      setFailed(true);
    } finally {
      setClearing(false);
    }
  };

  return (
    <Card title={t('settings.cache.title')}>
      <Row
        label={t('settings.cache.persist')}
        help={preferences.cache.persist ? undefined : t('settings.cache.persist-help')}
      >
        <Switch
          id="cache-persist"
          label={t('settings.cache.persist')}
          checked={preferences.cache.persist}
          onChange={(checked) =>
            // The whole cache object, because that is how the store merges it.
            update({ cache: { persist: checked, maxBytes: preferences.cache.maxBytes } })
          }
        />
      </Row>

      <Row label={t('settings.cache.max')}>
        <select
          id="cache-max"
          aria-label={t('settings.cache.max')}
          value={preferences.cache.maxBytes}
          onChange={(event) =>
            update({
              cache: {
                persist: preferences.cache.persist,
                maxBytes: Number(event.currentTarget.value),
              },
            })
          }
        >
          {MAX_BYTES_CHOICES.map((bytes) => (
            <option key={bytes} value={bytes}>
              {formatBytes(bytes)}
            </option>
          ))}
        </select>
      </Row>

      {usage !== null && (
        <p class="muted">
          {t('settings.cache.used', {
            size: formatBytes(usage.bytes),
            count: usage.entries,
          })}
        </p>
      )}
      {failed && <p class="muted">{t('settings.cache.unavailable')}</p>}
      <p class="muted small">{t('settings.cache.note')}</p>
      {cleared && (
        <p class="result ok" role="status">
          {t('settings.cache.cleared')}
        </p>
      )}

      <div class="actions">
        {confirming ? (
          <>
            <button
              type="button"
              class="button primary"
              disabled={clearing}
              onClick={() => void onClear()}
            >
              {t('settings.cache.clear-confirm')}
            </button>
            <button type="button" class="button" onClick={() => setConfirming(false)}>
              {t('settings.cache.cancel')}
            </button>
          </>
        ) : (
          <button
            type="button"
            class="button"
            id="cache-clear"
            disabled={clearing}
            onClick={() => {
              setCleared(false);
              setConfirming(true);
            }}
          >
            {t('settings.cache.clear')}
          </button>
        )}
      </div>
    </Card>
  );
}
