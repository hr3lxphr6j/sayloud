/**
 * The Models tab: what to download, from where, and what it costs in space.
 *
 * Three things live here because they are the same decision — the model, the
 * download source, and the device it will run on:
 *
 * 1. **Source** — which mirror the bytes come from. The choice is written to
 *    `ModelStore` (`sayloud:model-source`), which is the only place that stores
 *    it; a copy in the provider config would be a second answer to "where do
 *    downloads come from" and the two would disagree.
 * 2. **Tiers** — one row per size of the same model. Each row is in one of
 *    three states, and nothing else on the panel may claim to know better.
 * 3. **Device and space** — what the machine can do, and how much room the two
 *    model buckets take. Not the audio cache: that is on the Settings tab, and
 *    a user who clears one must not expect the other to shrink (spec §4.5).
 *
 * The download itself runs in the *panel*, never in the offscreen document:
 * Chrome closes an offscreen document 30 seconds after audio stops, and a
 * 163 MB download would be killed halfway through (spec §3.12.3). It is owned
 * by the panel shell rather than by this page, so switching tabs mid-download
 * does not cancel it — closing the panel does, which is exactly what the user
 * closing it means.
 *
 * Nothing here imports ONNX Runtime. The tab moves bytes and reads what Cache
 * Storage already holds; the engine that consumes them only ever runs in the
 * offscreen document's worker, and keeping this file free of it is what makes
 * that structural rather than a convention.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfigStore, SavedConfigs } from '~/lib/config-store';
import { formatDecimalBytes } from '~/lib/format-bytes';
import { type MessageKey, type Translator, useT } from '~/lib/i18n';
import type { DevicePreference } from '~/lib/models/device';
import { fileBytes } from '~/lib/models/downloader';
import {
  type DeviceCaps,
  type DeviceClass,
  deviceClass,
  MODELS,
  type ModelTier,
  type OnDeviceModel,
} from '~/lib/models/registry';
import type { ModelSourceSetting } from '~/lib/models/store';
import { MODEL_HOSTS, type ModelHostId } from '~/lib/models/urls';
import type { ProviderConfig } from '~/lib/providers/types';
import { Card } from './ui/Card';
import {
  localConfigOf,
  type ModelAdmin,
  type ModelStoreView,
  type TierStatus,
  tierKey,
  useDevice,
} from './use-models';

/** The label for each source, in the order `MODEL_HOSTS` offers them. */
const HOST_LABELS: Record<ModelHostId, MessageKey> = {
  auto: 'model.source.auto',
  huggingface: 'model.source.huggingface',
  modelscope: 'model.source.modelscope',
  custom: 'model.source.custom',
};

export interface ModelsTabProps {
  store: ConfigStore;
  /** Absent in tests, which then render the tab's shell and no model cards. */
  models?: ModelAdmin;
  /** Downloads, owned by the panel shell so a tab switch does not cancel one. */
  downloads: ModelStoreView;
  /** The active config, so the tier in use can be marked. */
  config: ProviderConfig | null;
  /** The saved configs, so a tier change is written where the provider reads. */
  savedConfigs: SavedConfigs;
  onChanged: () => void;
}

export function ModelsTab({
  store,
  models,
  downloads,
  config,
  savedConfigs,
  onChanged,
}: ModelsTabProps) {
  const local = localConfigOf(config, savedConfigs);
  const device = useDevice(models, local?.device ?? 'auto');
  const chosen = local?.tier;
  const inUse = config?.provider === 'local';

  return (
    <div class="stack">
      <SourceCard models={models} />
      <TierCards
        store={store}
        downloads={downloads}
        device={device}
        chosenTier={chosen}
        onSetActive={(model, tier) => void setActiveTier(store, model, tier, inUse, onChanged)}
        onChanged={onChanged}
      />
      <StorageCard
        device={device}
        downloads={downloads}
        preference={local?.device ?? 'auto'}
        onSetDevice={(next) => void setDevicePreference(store, next, inUse, onChanged)}
      />
    </div>
  );
}

// --- the download source ----------------------------------------------------

interface SourceCardProps {
  models?: ModelAdmin | undefined;
}

/**
 * Where the bytes come from.
 *
 * The choice shown is a draft rather than the stored value, because `custom`
 * with an unusable URL normalizes straight back to `auto`: rendering what was
 * stored would make the custom box impossible to reach in the first place.
 */
function SourceCard({ models }: SourceCardProps) {
  const t = useT();
  const store = models?.store;
  const [host, setHost] = useState<ModelHostId>('auto');
  const [customUrl, setCustomUrl] = useState('');
  const [invalid, setInvalid] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  /**
   * Whether the user has already chosen something.
   *
   * The stored source is read asynchronously, so a click that lands first
   * would otherwise be undone by the read resolving a moment later — the
   * control would snap back to what was saved before it was touched.
   */
  const touched = useRef(false);

  useEffect(() => {
    if (!store) return;
    let active = true;
    store.getSource().then(
      (setting) => {
        if (!active || touched.current) return;
        setHost(setting.host);
        setCustomUrl(setting.customHostUrl ?? '');
      },
      (error: unknown) => {
        console.error('[SayLoud] cannot read the download source', error);
      }
    );
    return () => {
      active = false;
    };
  }, [store]);

  /** Write the draft, reporting back whatever was actually stored. */
  const write = (next: ModelSourceSetting): void => {
    // The control leads: picking `custom` has to show the URL box before the
    // choice can be valid, or there is nowhere to type the URL that would
    // make it valid.
    touched.current = true;
    setHost(next.host);

    if (next.host === 'custom' && !isHttpsUrl(customUrl)) {
      setInvalid(true);
      setSaved(false);
      setFailure(null);
      return;
    }
    if (!store) return;

    store.setSource(next).then(
      (stored) => {
        setHost(stored.host);
        setCustomUrl(stored.customHostUrl ?? '');
        setInvalid(false);
        setSaved(true);
        setFailure(null);
      },
      (error: unknown) => {
        setSaved(false);
        setFailure(errorText(error));
      }
    );
  };

  return (
    <Card title={t('model.source.title')}>
      <div class="field">
        <label class="field-label" for="model-source">
          {t('model.source.label')}
        </label>
        <select
          id="model-source"
          value={host}
          disabled={models === undefined}
          onChange={(event) =>
            write({
              host: event.currentTarget.value as ModelHostId,
              ...(customUrl === '' ? {} : { customHostUrl: customUrl }),
            })
          }
        >
          {MODEL_HOSTS.map((id) => (
            <option key={id} value={id}>
              {t(HOST_LABELS[id])}
            </option>
          ))}
        </select>
        <span class="field-help" id="model-source-help">
          {t('model.source.help')}
        </span>
      </div>

      {host === 'custom' && (
        <div class="field">
          <label class="field-label" for="model-source-url">
            {t('model.source.custom-label')}
          </label>
          <input
            id="model-source-url"
            type="url"
            spellcheck={false}
            autocomplete="off"
            placeholder="https://example.com/models"
            value={customUrl}
            aria-invalid={invalid ? true : undefined}
            // `onInput` keeps the box responsive; the write waits for the
            // field to be left, because `https://a` is a *valid* URL and
            // storing every prefix of what is being typed would store junk.
            onInput={(event) => {
              setCustomUrl(event.currentTarget.value);
              setInvalid(false);
              setSaved(false);
            }}
            onChange={(event) =>
              write({ host: 'custom', customHostUrl: event.currentTarget.value })
            }
          />
          {invalid && <span class="field-error">{t('model.source.custom-invalid')}</span>}
        </div>
      )}

      {saved && (
        <p class="result ok" role="status">
          {t('model.source.saved')}
        </p>
      )}
      {failure !== null && (
        <p class="result error" role="status">
          {t('model.source.save-failed', { detail: failure })}
        </p>
      )}
    </Card>
  );
}

// --- the model cards --------------------------------------------------------

interface TierCardsProps {
  store: ConfigStore;
  downloads: ModelStoreView;
  device: ReturnType<typeof useDevice>;
  chosenTier: string | undefined;
  onSetActive: (model: OnDeviceModel, tier: ModelTier) => void;
  onChanged: () => void;
}

/**
 * One card per model, straight from the registry.
 *
 * The list is walked rather than written out, so a second model family is a
 * registry entry and nothing here. With one entry there is deliberately no
 * "add a model" placeholder: an empty control is worse than no control.
 */
function TierCards({
  store,
  downloads,
  device,
  chosenTier,
  onSetActive,
  onChanged,
}: TierCardsProps) {
  const t = useT();
  const [confirming, setConfirming] = useState<string | null>(null);
  const caps = device?.probe.caps;
  const recommendedClass = caps ? deviceClass(caps) : undefined;

  return (
    <>
      {MODELS.map((model) => (
        <Card key={model.id}>
          <div class="model-head">
            <div class="model-head-text">
              <span class="model-name">{t(model.labelKey)}</span>
              <span class="model-meta">{cardMeta(model, t)}</span>
            </div>
            {chosenTier !== undefined && modelHasTier(model, chosenTier) && (
              <span class="pill active">{t('model.in-use')}</span>
            )}
          </div>

          <a class="field-help link" href={model.license.url} target="_blank" rel="noreferrer">
            {t('model.license', { name: model.license.name })}
          </a>

          <ul class="tiers">
            {(model.tiers ?? []).map((tier) => (
              <TierRow
                key={tier.id}
                model={model}
                tier={tier}
                status={downloads.statuses[tierKey(model, tier)] ?? { kind: 'unknown' }}
                recommended={recommendationKey(tier, recommendedClass, caps)}
                chosen={chosenTier === tier.id}
                confirming={confirming === tierKey(model, tier)}
                onDownload={() => downloads.start(model, tier)}
                onCancel={() => downloads.cancel(model, tier)}
                onSetActive={() => onSetActive(model, tier)}
                onDelete={() => {
                  setConfirming(null);
                  void removeTier(store, model, tier, chosenTier === tier.id, onChanged, downloads);
                }}
                onAskDelete={() => setConfirming(tierKey(model, tier))}
                onCancelDelete={() => setConfirming(null)}
              />
            ))}
          </ul>
        </Card>
      ))}
      {downloads.failed && <p class="muted">{t('model.read-failed')}</p>}
    </>
  );
}

/** The card's second line: what this model speaks, offers, and reports. */
function cardMeta(model: OnDeviceModel, t: Translator): string {
  return [
    model.languages.join(' · '),
    t('model.voice-count', { count: model.voiceCount }),
    t('model.timings'),
  ].join(' · ');
}

/**
 * Why this tier is the one to get, or why it cannot be used here.
 *
 * A tier can be preferred for exactly one device class, and the badge has to
 * say which: "recommended" alone is a claim about a machine the reader may be
 * looking at from another one.
 *
 * A missing *requirement* outranks that and replaces it. "Not preferred" means
 * slower than it needs to be; "cannot run" means the audio comes out wrong, and
 * the difference is worth losing the recommendation badge over.
 */
function recommendationKey(
  tier: ModelTier,
  preferred: DeviceClass | undefined,
  caps: DeviceCaps | undefined
): MessageKey | undefined {
  if (caps !== undefined && tier.requires !== undefined && !caps[tier.requires]) {
    return 'model.requires-missing';
  }
  if (preferred === undefined || tier.preferredFor?.includes(preferred) !== true) return undefined;
  // `wasm` is the only class without a GPU, and the one whose badge must not
  // read as advice to use one.
  return preferred === 'wasm' ? 'model.recommended-cpu' : 'model.recommended';
}

function modelHasTier(model: OnDeviceModel, tierId: string): boolean {
  return (model.tiers ?? []).some((tier) => tier.id === tierId);
}

interface TierRowProps {
  model: OnDeviceModel;
  tier: ModelTier;
  status: TierStatus;
  /** Why this tier is the one to get, when it is. */
  recommended: MessageKey | undefined;
  chosen: boolean;
  confirming: boolean;
  onDownload: () => void;
  onCancel: () => void;
  onSetActive: () => void;
  onDelete: () => void;
  onAskDelete: () => void;
  onCancelDelete: () => void;
}

/** One tier, in whichever of its three states it is actually in. */
function TierRow({
  model,
  tier,
  status,
  recommended,
  chosen,
  confirming,
  onDownload,
  onCancel,
  onSetActive,
  onDelete,
  onAskDelete,
  onCancelDelete,
}: TierRowProps) {
  const t = useT();
  const label = t(tier.labelKey);

  if (status.kind === 'downloading') {
    return (
      <li class="tier-download" data-tier={`${model.id}:${tier.id}`} data-state="downloading">
        <div class="tier-download-head">
          <span class="tier-name">
            {t('model.downloading', { tier: label, percent: percentOf(status) })}
          </span>
          <button type="button" class="button" onClick={onCancel}>
            {t('model.cancel')}
          </button>
        </div>
        <div
          class="progress"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentOf(status)}
          aria-label={t('model.downloading', { tier: label, percent: percentOf(status) })}
        >
          <div class="progress-value" style={{ width: `${percentOf(status)}%` }} />
        </div>
      </li>
    );
  }

  return (
    <li class="tier" data-tier={`${model.id}:${tier.id}`} data-state={status.kind}>
      <div class="tier-text">
        <span class="tier-name">
          {label}
          {recommended !== undefined && <span class="tier-hint"> · {t(recommended)}</span>}
        </span>
        <span class="tier-size">{tierSize(tier)}</span>

        {status.kind === 'failed' && (
          <span class="field-error" title={status.detail}>
            {t('model.download-failed')}
          </span>
        )}
        {status.kind === 'absent' && status.cancelled === true && (
          <span class="tier-size">{t('model.download-cancelled')}</span>
        )}
        {confirming && <span class="field-error">{t('model.delete-warning')}</span>}
      </div>

      <div class="tier-actions">
        {confirming ? (
          <>
            <button type="button" class="button primary" onClick={onDelete}>
              {t('model.delete-confirm')}
            </button>
            <button type="button" class="button" onClick={onCancelDelete}>
              {t('model.cancel')}
            </button>
          </>
        ) : status.kind === 'downloaded' ? (
          <>
            {chosen ? (
              <span class="pill active">{t('model.in-use')}</span>
            ) : (
              <button type="button" class="button" onClick={onSetActive}>
                {t('model.set-active')}
              </button>
            )}
            {/*
              Only a tier in use is worth a warning: deleting one that is not
              costs a download if it is ever wanted again, and asking twice
              about a decision that is easy to reverse is noise.
            */}
            <button type="button" class="button" onClick={chosen ? onAskDelete : onDelete}>
              {t('model.delete')}
            </button>
          </>
        ) : (
          <button type="button" class="button" onClick={onDownload}>
            {t('model.download')}
          </button>
        )}
      </div>
    </li>
  );
}

// --- device and space -------------------------------------------------------

interface StorageCardProps {
  device: ReturnType<typeof useDevice>;
  downloads: ModelStoreView;
  /** What the user asked for, which is not always what the probe resolves to. */
  preference: DevicePreference;
  onSetDevice: (device: DevicePreference) => void;
}

/**
 * What the machine can do, what it will actually use, and what the two model
 * buckets cost.
 *
 * The line below the control reports what the engine *will* use, resolved from
 * a real probe, rather than what it used last: an offscreen document has no
 * `chrome.storage` to write such a record into, and a guess from the panel would
 * be a claim about a context it cannot see.
 *
 * The control exists because "auto" is a decision made from one capability
 * check, and a capability check cannot see a driver bug. A GPU that advertises
 * `shader-f16` and then produces distorted half-precision audio is a real thing
 * to be caught by, and the only way to tell it apart from a bad download is to
 * ask the CPU to run the same weights.
 */
function StorageCard({ device, downloads, preference, onSetDevice }: StorageCardProps) {
  const t = useT();
  const usage = downloads.usage;

  return (
    <Card title={t('model.storage.title')}>
      <div class="row">
        <label class="row-label" for="device-preference">
          {t('field.device')}
        </label>
        <select
          id="device-preference"
          class="input select"
          value={preference}
          onChange={(event) =>
            onSetDevice((event.currentTarget as HTMLSelectElement).value as DevicePreference)
          }
        >
          <option value="auto">{t('model.device.option-auto')}</option>
          <option value="webgpu">{t('model.device.option-webgpu')}</option>
          <option value="wasm">{t('model.device.option-wasm')}</option>
        </select>
      </div>
      <div class="row">
        <span class="row-label">{t('model.device.resolved')}</span>
        <span class="row-value">{deviceText(device, t)}</span>
      </div>
      <p class="muted small">{t('model.device.help')}</p>
      <div class="row">
        <span class="row-label">{t('model.storage.label')}</span>
        <span class="row-value">{usage === null ? '—' : formatDecimalBytes(usage.totalBytes)}</span>
      </div>
      <p class="muted small">{t('model.storage.note')}</p>
      <p class="muted small">{t('model.voices.note')}</p>
    </Card>
  );
}

/**
 * Save which backend to ask for, and re-point the active config at it.
 *
 * Written through the same path as a tier change, for the same reason: the
 * router reads the *active* config, so saving alone would leave the next
 * sentence on the old device. `device` travels to the offscreen document inside
 * the provider config, so the change takes effect when the session reloads.
 */
async function setDevicePreference(
  store: ConfigStore,
  device: DevicePreference,
  inUse: boolean,
  onChanged: () => void
): Promise<void> {
  try {
    const saved = (await store.getSavedConfigs()).local;
    const config = { ...(saved ?? { provider: 'local' as const }), provider: 'local' as const };
    await store.saveConfig({ ...config, device });
    if (inUse) await store.setActiveConfig('local');
    onChanged();
  } catch (error) {
    console.error('[SayLoud] cannot save the device preference', error);
  }
}

/** The device line: the machine's own words when it has any. */
function deviceText(device: ReturnType<typeof useDevice>, t: Translator): string {
  if (device === null) return t('model.device.not-loaded');
  if (device.device === null) return t('error.device-unavailable');
  if (device.device === 'wasm') return t('model.device.wasm');

  const name = device.probe.adapterName;
  return name === undefined
    ? t('model.device.webgpu')
    : t('model.device.webgpu-named', { adapter: name });
}

// --- actions ----------------------------------------------------------------

/**
 * Make a downloaded tier the one to run.
 *
 * Written to the saved config and, when the local provider is already the one
 * in use, re-pointed at the active config too — the router reads the *active*
 * config, so saving alone would leave playback on the old tier. Same rule the
 * provider form follows: changing a setting is not the same as switching to it.
 */
async function setActiveTier(
  store: ConfigStore,
  model: OnDeviceModel,
  tier: ModelTier,
  inUse: boolean,
  onChanged: () => void
): Promise<void> {
  try {
    const saved = (await store.getSavedConfigs()).local;
    const config = { ...(saved ?? { provider: 'local' as const }), provider: 'local' as const };
    await store.saveConfig({ ...config, modelId: model.id, tier: tier.id });
    if (inUse) await store.setActiveConfig('local');
    onChanged();
  } catch (error) {
    console.error('[SayLoud] cannot select the model tier', error);
  }
}

/**
 * Drop a tier's files.
 *
 * A tier in use falls back to the model's first tier rather than to nothing:
 * the provider then reports `model-missing` if that one is not downloaded
 * either, which is a state the panel already knows how to explain (spec §4.3).
 */
async function removeTier(
  store: ConfigStore,
  model: OnDeviceModel,
  tier: ModelTier,
  wasChosen: boolean,
  onChanged: () => void,
  downloads: ModelStoreView
): Promise<void> {
  try {
    await downloads.remove(model, tier);
    if (wasChosen) {
      const first = model.tiers?.[0];
      const saved = (await store.getSavedConfigs()).local;
      if (first && saved?.provider === 'local') {
        await store.saveConfig({ ...saved, tier: first.id });
      }
    }
    onChanged();
  } catch (error) {
    console.error('[SayLoud] cannot delete the model tier', error);
  }
}

/** How far along a download is, in whole percent. */
function percentOf(status: Extract<TierStatus, { kind: 'downloading' }>): number {
  if (status.totalBytes <= 0) return 0;
  return Math.min(100, Math.round((status.bytes / status.totalBytes) * 100));
}

/** The tier's own files, plus the ones every tier shares. */
function tierSize(tier: ModelTier): string {
  const total = tier.files.reduce((sum, file) => sum + fileBytes(tier, file), 0);
  return formatDecimalBytes(total);
}

/** An absolute `https://` URL, which is what the spec requires of a mirror. */
function isHttpsUrl(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith('https://')) return false;
  try {
    new URL(trimmed);
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
