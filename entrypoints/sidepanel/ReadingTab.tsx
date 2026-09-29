/**
 * The Reading tab: what SayLoud is configured to do, and what it last did.
 *
 * There is no playback control here on purpose — the player on the page owns
 * that, and the service worker owns the session. This reads the session
 * snapshot the worker publishes and shows it, which is the whole of the
 * side panel's involvement with playback.
 */
import { useEffect, useState } from 'preact/hooks';
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

  if (loading) return <p class="muted">Loading…</p>;

  return (
    <div class="stack">
      <section class="section">
        <h2>Provider</h2>
        {config ? (
          <dl class="facts">
            <div>
              <dt>Service</dt>
              <dd>{PROVIDER_SCHEMAS[config.provider].label}</dd>
            </div>
            <div>
              <dt>Voice</dt>
              {/*
                The session reports the voice the engine actually resolved, which
                is what is speaking; the configured one is the fallback for when
                nothing is running.
              */}
              <dd>{snapshot?.voice || voice || 'Default voice'}</dd>
            </div>
            <div>
              <dt>Highlight</dt>
              <dd>{highlightLabel(config, providers)}</dd>
            </div>
          </dl>
        ) : (
          <p class="muted">No provider is configured. Open Settings to choose one.</p>
        )}
      </section>

      <section class="section">
        <h2>Reading session</h2>
        {snapshot ? (
          <>
            <p>
              Sentence {snapshot.index + 1} of {snapshot.sentences.length} at {snapshot.rate}×
            </p>
            <div
              class="progress"
              role="img"
              aria-label={`${progressPercent(snapshot)} percent of the article read`}
            >
              <div class="progress-value" style={{ width: `${progressPercent(snapshot)}%` }} />
            </div>
            <p class="muted">{progressPercent(snapshot)}% of the article read.</p>
          </>
        ) : (
          <p class="muted">
            Nothing is being read. Click the SayLoud toolbar icon on a page to start.
          </p>
        )}
        <p class="muted small">
          Reported by the service worker. Playback itself is controlled from the player on the page.
        </p>
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
function highlightLabel(
  config: ProviderConfig,
  providers: Record<CloudProviderId, Provider>
): string {
  if (config.provider === 'browser') return 'Sentence by sentence (browser voice)';

  try {
    return providers[config.provider].capabilities(config).timings === 'exact'
      ? 'Word by word'
      : 'Sentence by sentence';
  } catch {
    // A capability lookup that throws is a wiring bug, not something the user
    // can fix; saying so plainly beats showing nothing.
    return 'Unknown';
  }
}
