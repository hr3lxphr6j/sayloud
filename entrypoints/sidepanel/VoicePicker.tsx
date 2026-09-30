/**
 * Lists a provider's voices and remembers which one was picked.
 *
 * The choice is saved on click rather than with the form: it is a separate
 * preference from the credentials, and a user who has just listened to a voice
 * should not have to also press Save. It is stored per provider, so switching
 * services and switching back keeps the voice that was chosen for each.
 *
 * A voice can also be typed in by id: a cloned voice, one the provider added
 * after the catalogue was taken, or one a server does not list. The list can
 * run to hundreds of entries (Volcengine 2.0 has 445), so it is filterable.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfigStore } from '~/lib/config-store';
import { useT } from '~/lib/i18n';
import type { ProviderSchema } from '~/lib/providers/config-schema';
import { errorMessage, formatProviderError, providerErrorSummary } from '~/lib/providers/errors';
import type { Provider, ProviderConfig, Voice } from '~/lib/providers/types';
import { type Deadline, startDeadline } from './deadline';
import { type AsyncStatus, StatusLine } from './StatusLine';

/** Voice catalogues are small, but a local server can take a moment to answer. */
const LOAD_TIMEOUT_MS = 15_000;

export interface VoicePickerProps {
  schema: ProviderSchema;
  provider: Provider;
  /** Null while the form is incomplete; there is nothing to ask the provider yet. */
  config: ProviderConfig | null;
  store: ConfigStore;
  disabled: boolean;
  /** Lets the form show its own field errors when this is pressed too early. */
  onAttempt: () => void;
  /**
   * Whether the form is showing its errors, i.e. the user has tried something.
   *
   * The "fill the form in first" complaint is derived from this rather than
   * kept in `status`, so it cannot outlive the form being filled in: it is
   * simply no longer true, and re-rendering drops it.
   */
  showFormErrors: boolean;
}

export function VoicePicker({
  schema,
  provider,
  config,
  store,
  disabled,
  onAttempt,
  showFormErrors,
}: VoicePickerProps) {
  const t = useT();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [status, setStatus] = useState<AsyncStatus>({ kind: 'idle' });
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typedId, setTypedId] = useState('');
  const inFlight = useRef<Deadline | null>(null);

  useEffect(() => {
    let active = true;
    store
      .getSelectedVoice(schema.id)
      .then((voiceId) => {
        if (active) setSelected(voiceId);
      })
      .catch((error: unknown) => {
        console.error('[SayLoud] cannot read the selected voice', error);
      });
    return () => {
      active = false;
    };
  }, [store, schema.id]);

  useEffect(() => () => inFlight.current?.cancel(), []);

  const onLoad = async () => {
    onAttempt();
    if (!config) return;

    const deadline = startDeadline(LOAD_TIMEOUT_MS);
    inFlight.current?.cancel();
    inFlight.current = deadline;
    setStatus({ kind: 'running' });

    try {
      const listed = await provider.listVoices(config, deadline.signal);
      setVoices(listed);
      setStatus(
        listed.length === 0
          ? { kind: 'error', message: t('voice.none-returned') }
          : {
              kind: 'ok',
              message: t(listed.length === 1 ? 'voice.count-one' : 'voice.count-many', {
                count: listed.length,
              }),
            }
      );
    } catch (error) {
      if (deadline.timedOut()) {
        setStatus({
          kind: 'error',
          message: t('error.no-response', { seconds: LOAD_TIMEOUT_MS / 1000 }),
        });
      } else if (!deadline.signal.aborted) {
        setStatus({ kind: 'error', message: formatProviderError(providerErrorSummary(error), t) });
      }
    } finally {
      deadline.dispose();
      if (inFlight.current === deadline) inFlight.current = null;
    }
  };

  const onSelect = async (voiceId: string) => {
    if (voiceId.length === 0) return;
    setSelected(voiceId);
    try {
      await store.saveSelectedVoice(schema.id, voiceId);
      setStatus({ kind: 'ok', message: t('voice.saved', { voice: voiceId }) });
    } catch (error) {
      setStatus({
        kind: 'error',
        message: t('voice.save-failed', { detail: errorMessage(error) }),
      });
    }
  };

  const shown = voices === null ? [] : filterVoices(voices, query);

  return (
    <section class="section">
      <div class="section-header">
        <h2>{t('voice.section')}</h2>
        <button
          type="button"
          class="button"
          disabled={disabled || status.kind === 'running'}
          onClick={() => void onLoad()}
        >
          {status.kind === 'running' ? t('voice.loading') : t('voice.load')}
        </button>
      </div>

      {selected && (
        <p class="muted">
          {t('voice.selected')} <code>{selected}</code>
        </p>
      )}

      {config === null && showFormErrors && (
        <p class="result error" role="alert">
          {t('voice.fill-form-first')}
        </p>
      )}

      <form
        class="voice-custom"
        onSubmit={(event) => {
          event.preventDefault();
          void onSelect(typedId.trim());
        }}
      >
        <label class="field-label" for={`voice-id-${schema.id}`}>
          {t('voice.id-label')}
        </label>
        <div class="inline">
          <input
            id={`voice-id-${schema.id}`}
            type="text"
            placeholder={t('voice.id-placeholder')}
            spellcheck={false}
            autocomplete="off"
            value={typedId}
            disabled={disabled}
            onInput={(event) => setTypedId(event.currentTarget.value)}
          />
          <button type="submit" class="button" disabled={disabled || typedId.trim() === ''}>
            {t('voice.use-id')}
          </button>
        </div>
      </form>

      <StatusLine status={status} />

      {voices !== null && voices.length > 0 && (
        <input
          type="search"
          aria-label={t('voice.filter-label')}
          placeholder={t('voice.filter-placeholder', { count: voices.length })}
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      )}

      {voices !== null && voices.length > 0 && shown.length === 0 && (
        <p class="muted">{t('voice.no-match', { query: query.trim() })}</p>
      )}

      {shown.length > 0 && (
        <ul class="voice-list">
          {shown.map((voice) => (
            <li key={voice.id}>
              <label class="voice">
                <input
                  type="radio"
                  name={`voice-${schema.id}`}
                  checked={selected === voice.id}
                  disabled={disabled}
                  onChange={() => void onSelect(voice.id)}
                />
                <span class="voice-name">{voice.name}</span>
                <code class="voice-id">{voice.id}</code>
                {(voice.lang || voice.gender) && (
                  <span class="voice-meta">
                    {[voice.lang, voice.gender].filter(Boolean).join(' · ')}
                  </span>
                )}
                {voice.supportsTimings === true && (
                  <span class="badge">{t('voice.badge-timings')}</span>
                )}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** Voices whose name, id or language contains `query`, ignoring case. */
export function filterVoices(voices: readonly Voice[], query: string): Voice[] {
  const needle = query.trim().toLowerCase();
  if (needle === '') return [...voices];
  return voices.filter((voice) =>
    [voice.name, voice.id, voice.lang ?? ''].some((text) => text.toLowerCase().includes(needle))
  );
}
