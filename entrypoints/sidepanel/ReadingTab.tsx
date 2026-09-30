/**
 * The Reading tab: what SayLoud is configured to do, and what it last did.
 *
 * There is no playback control here on purpose — the player on the page owns
 * that, and the service worker owns the session. This reads the session
 * snapshot the worker publishes and shows it, which is the whole of the
 * side panel's involvement with playback.
 */
import { useEffect, useState } from 'preact/hooks';
import { type MessageKey, useT } from '~/lib/i18n';
import type { SessionSnapshot } from '~/lib/protocol';
import { PROVIDER_SCHEMAS } from '~/lib/providers/config-schema';
import type { CloudProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig } from '~/lib/providers/types';
import type { SessionWatch } from '~/lib/session-watch';

export interface ReadingTabProps {
  /** The saved config; null when the user has not configured a provider. */
  config: ProviderConfig | null;
  /** The voice chosen for the saved provider, if any. */
  voice: string | null;
  providers: Record<CloudProviderId, Provider>;
  session: SessionWatch;
  /** True until the saved config has been read. */
  loading: boolean;
}

export function ReadingTab({ config, voice, providers, session, loading }: ReadingTabProps) {
  const t = useT();
  const [snapshot, setSnapshot] = useState<SessionSnapshot | null>(null);

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

  if (loading) return <p class="muted">{t('panel.loading')}</p>;

  return (
    <div class="stack">
      <section class="section">
        <h2>{t('panel.section.provider')}</h2>
        {config ? (
          <dl class="facts">
            <div>
              <dt>{t('panel.fact.service')}</dt>
              <dd>{t(PROVIDER_SCHEMAS[config.provider].labelKey)}</dd>
            </div>
            <div>
              <dt>{t('panel.fact.voice')}</dt>
              {/*
                The session reports the voice the engine actually resolved, which
                is what is speaking; the configured one is the fallback for when
                nothing is running.
              */}
              <dd>{snapshot?.voice || voice || t('panel.default-voice')}</dd>
            </div>
            <div>
              <dt>{t('panel.fact.highlight')}</dt>
              <dd>{t(highlightKey(config, providers))}</dd>
            </div>
          </dl>
        ) : (
          <p class="muted">{t('panel.no-provider')}</p>
        )}
      </section>

      <section class="section">
        <h2>{t('panel.section.session')}</h2>
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
        <p class="muted small">{t('panel.reported-by')}</p>
      </section>
    </div>
  );
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
 * content script highlights the whole sentence it handed to `chrome.tts`.
 */
function highlightKey(
  config: ProviderConfig,
  providers: Record<CloudProviderId, Provider>
): MessageKey {
  if (config.provider === 'browser') return 'panel.highlight.browser';

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
