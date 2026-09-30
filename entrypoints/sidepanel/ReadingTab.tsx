/**
 * The Reading tab: what SayLoud is set to do, and what it last did.
 *
 * There is no playback control here on purpose — the player on the page owns
 * that, and the service worker owns the session. This reads the session
 * snapshot the worker publishes and shows it, which is the whole of the side
 * panel's involvement with playback.
 *
 * The two sliders are the exception that proves that rule: they are
 * preferences, not transport. A drag updates the number on screen and writes
 * settings once, when the handle is released.
 */
import { useEffect, useState } from 'preact/hooks';
import { supportsPictureInPicture } from '~/lib/document-pip';
import { formatRate } from '~/lib/format-rate';
import { type MessageKey, useT } from '~/lib/i18n';
import type { SessionSnapshot } from '~/lib/protocol';
import { PROVIDER_SCHEMAS } from '~/lib/providers/config-schema';
import type { CloudProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig } from '~/lib/providers/types';
import type { SessionWatch } from '~/lib/session-watch';
import {
  MAX_RATE,
  MAX_VOLUME,
  MIN_RATE,
  MIN_VOLUME,
  type SettingsStore,
} from '~/lib/settings-store';
import { Card } from './ui/Card';
import { SpeakerGlyph } from './ui/icons';
import { Row } from './ui/Row';
import { Slider } from './ui/Slider';
import { Switch } from './ui/Switch';
import { useSettings } from './use-settings';

/** One step of the volume slider: 5%, which is 30 steps across 0–150%. */
const VOLUME_STEP = 0.05;
/** One step of the rate slider, to match the presets the player offers. */
const RATE_STEP = 0.05;

export interface ReadingTabProps {
  /** The saved config; null when the user has not configured a provider. */
  config: ProviderConfig | null;
  /** The voice chosen for the saved provider, if any. */
  voice: string | null;
  providers: Record<CloudProviderId, Provider>;
  session: SessionWatch;
  /** Absent in tests, which then show the defaults and save nothing. */
  settings?: SettingsStore;
  /** Opens the Settings tab, where a service is configured. */
  onOpenSettings: () => void;
  /** Switches the panel to the full-page voice picker. */
  onChangeVoice: () => void;
}

export function ReadingTab({
  config,
  voice,
  providers,
  session,
  settings,
  onOpenSettings,
  onChangeVoice,
}: ReadingTabProps) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);
  const { settings: saved, update } = useSettings(settings);

  /**
   * What the sliders show while a handle is being dragged.
   *
   * Null when nothing is being dragged, so the value on screen follows the
   * stored one — including a change made in another context, which arrives
   * through `storage.onChanged`.
   */
  const [draft, setDraft] = useState<{ volume?: number; rate?: number } | null>(null);
  const volume = draft?.volume ?? saved.volume;
  const rate = draft?.rate ?? saved.rate;

  useEffect(() => {
    let active = true;
    const refresh = () => {
      session
        .load()
        .then((loaded) => {
          if (active) setSnapshot(loaded);
        })
        .catch((error: unknown) => {
          console.error('[SayLoud] cannot read the reading session', error);
        });
    };

    refresh();
    const unsubscribe = session.subscribe(refresh);
    return () => {
      active = false;
      unsubscribe();
    };
  }, [session]);

  // The browser voice is what Chrome has installed, and it is also what an
  // unconfigured panel is reading with; either way there is no service to
  // choose a voice on, and the panel says so instead of offering one.
  const cloudConfig = config !== null && config.provider !== 'browser' ? config : null;

  return (
    <div class="stack">
      {cloudConfig ? (
        <section class="section">
          <h2>{t('voice.section')}</h2>
          <button type="button" class="voice-card" onClick={onChangeVoice}>
            <span class="voice-card-mark">
              <SpeakerGlyph />
            </span>
            <span class="voice-card-text">
              {/*
                The session reports the voice the engine actually resolved, which
                is what is speaking; the configured one is what the next session
                will use.
              */}
              <span class="voice-card-name">
                {snapshot?.voice || voice || t('panel.default-voice')}
              </span>
              <span class="voice-card-meta">{voiceMeta(cloudConfig, providers, t)}</span>
            </span>
            <span class="voice-card-action">{t('panel.voice.change')}</span>
          </button>
        </section>
      ) : (
        <div class="notice">
          <p class="muted">{t('panel.no-provider')}</p>
          <button type="button" class="button disclosure" onClick={onOpenSettings}>
            {t('panel.configure')}
          </button>
        </div>
      )}

      <Card>
        <div class="rows">
          <div>
            <Slider
              id="volume-slider"
              label={t('settings.volume.label')}
              value={volume}
              min={MIN_VOLUME}
              max={MAX_VOLUME}
              step={VOLUME_STEP}
              display={formatVolume(volume)}
              onInput={(next) => setDraft((current) => ({ ...current, volume: next }))}
              onCommit={(next) => {
                update({ volume: next });
                setDraft((current) => ({ ...current, volume: undefined }));
              }}
            />
            {!cloudConfig && <p class="muted small">{t('settings.volume.browser-cap')}</p>}
          </div>

          <Slider
            id="rate-slider"
            label={t('settings.rate.label')}
            value={rate}
            min={MIN_RATE}
            max={MAX_RATE}
            step={RATE_STEP}
            display={formatRate(rate)}
            onInput={(next) => setDraft((current) => ({ ...current, rate: next }))}
            onCommit={(next) => {
              update({ rate: next });
              setDraft((current) => ({ ...current, rate: undefined }));
            }}
          />

          <Row
            label={t('settings.caption.label')}
            // The window is opened from the page's bar, never from here: Chrome
            // refuses `requestWindow()` in a side panel. So the help says where
            // the button is — and when the browser has no such API at all, it
            // says that instead of pointing at a button that will not appear.
            help={t(
              supportsPictureInPicture() ? 'settings.caption.help' : 'settings.caption.unsupported'
            )}
          >
            <Switch
              id="caption-switch"
              label={t('settings.caption.label')}
              checked={saved.captionWindow}
              onChange={(checked) => update({ captionWindow: checked })}
            />
          </Row>
        </div>
      </Card>

      <Card title={t('panel.section.session')}>
        {snapshot ? (
          <>
            <p>
              {t('panel.sentence-progress', {
                index: snapshot.index + 1,
                total: snapshot.sentences.length,
                rate: snapshot.rate,
              })}
            </p>
            <div
              class="progress"
              role="img"
              aria-label={t('panel.progress-label', { percent: progressPercent(snapshot) })}
            >
              <div class="progress-value" style={{ width: `${progressPercent(snapshot)}%` }} />
            </div>
            <p class="muted">{t('panel.progress-text', { percent: progressPercent(snapshot) })}</p>
          </>
        ) : (
          <p class="muted">{t('panel.nothing-reading')}</p>
        )}
      </Card>
    </div>
  );
}

/** The voice card's second line: which service, and how it highlights. */
function voiceMeta(
  config: ProviderConfig & { provider: CloudProviderId },
  providers: Record<CloudProviderId, Provider>,
  t: (key: MessageKey) => string
): string {
  const service = t(PROVIDER_SCHEMAS[config.provider].labelKey);
  return [service, t(highlightKey(config, providers))].join(' · ');
}

function formatVolume(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function progressPercent(snapshot: SessionSnapshot): number {
  if (snapshot.sentences.length === 0) return 0;
  const charsTotal = snapshot.sentences.reduce(
    (total, sentence) => total + sentence.text.length,
    0
  );
  if (charsTotal === 0) return 0;
  return Math.min(100, Math.round((snapshot.charsRead / charsTotal) * 100));
}

/**
 * Whether this configuration yields word-level highlight.
 *
 * The browser voice has no adapter to ask, and never reports timings: the
 * content script highlights the whole sentence it handed to `chrome.tts`. It is
 * not asked about here — the card would be repeating the service name back.
 */
function highlightKey(
  config: ProviderConfig & { provider: CloudProviderId },
  providers: Record<CloudProviderId, Provider>
): MessageKey {
  try {
    return providers[config.provider].capabilities(config).timings === 'exact'
      ? 'panel.highlight.words'
      : 'panel.highlight.sentences';
  } catch {
    // A capability lookup that throws is a wiring bug, not something the user
    // can fix; saying so plainly beats showing nothing.
    return 'panel.highlight.unknown';
  }
}
