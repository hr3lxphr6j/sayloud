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
 *
 * The same component stands in two places: inside a provider's form, and on the
 * full-page picker the Reading tab's voice card opens. The page is the same
 * panel of voices with the heading left to the page header above it.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfigStore } from '~/lib/config-store';
import { useT } from '~/lib/i18n';
import { PROVIDER_SCHEMAS, type ProviderSchema } from '~/lib/providers/config-schema';
import { errorMessage, formatProviderError, providerErrorSummary } from '~/lib/providers/errors';
import type { CloudProviderId } from '~/lib/providers/registry';
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
  /** Draws its own `voice.section` heading; off on the full-page picker. */
  heading?: boolean;
  /** Lets the form show its own field errors when this is pressed too early. */
  onAttempt?: () => void;
  /**
   * Whether the form is showing its errors, i.e. the user has tried something.
   *
   * The "fill the form in first" complaint is derived from this rather than
   * kept in `status`, so it cannot outlive the form being filled in: it is
   * simply no longer true, and re-rendering drops it.
   */
  showFormErrors?: boolean;
  /** A voice was saved, so a reader looking at the same setting can catch up. */
  onSaved?: () => void;
}

export function VoicePicker({
  schema,
  provider,
  config,
  store,
  disabled,
  heading = true,
  onAttempt,
  showFormErrors = false,
  onSaved,
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
    onAttempt?.();
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

  const onSelect = async (voiceId: string, name?: string) => {
    if (voiceId.length === 0) return;
    setSelected(voiceId);
    try {
      await store.saveSelectedVoice(schema.id, voiceId);
      // A name only comes from the catalogue, so a voice picked out of the list
      // has one and an id typed into the box does not. Remembering it here is
      // what lets the summaries say "Vivi 2.0" without fetching the catalogue
      // again — the id stays the choice, the name is how it was listed.
      if (name !== undefined) await store.saveVoiceName(schema.id, voiceId, name);
      setStatus({ kind: 'ok', message: t('voice.saved', { voice: voiceId }) });
      onSaved?.();
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
        {heading && <h2>{t('voice.section')}</h2>}
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

      {/*
        Before the list has been fetched the page is otherwise just a button
        and an id box, which reads as broken rather than as empty. The line goes
        where the search box will appear, so fetching replaces it in place.
      */}
      {voices === null && status.kind === 'idle' && <p class="muted">{t('voice.load-hint')}</p>}

      {config === null && showFormErrors && (
        <p class="result error" role="alert">
          {t('voice.fill-form-first')}
        </p>
      )}

      {voices !== null && voices.length > 0 && (
        <input
          type="search"
          aria-label={t('voice.filter-label')}
          placeholder={t('voice.filter-placeholder', { count: voices.length })}
          value={query}
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      )}

      <StatusLine status={status} />

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
                  onChange={() => void onSelect(voice.id, voice.name)}
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

      {/*
        Last, after the list: it is the escape hatch for a voice the catalogue
        does not have, not the way most people pick one.
      */}
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
    </section>
  );
}

export interface VoicePickerPageProps {
  store: ConfigStore;
  providers: Record<CloudProviderId, Provider>;
  /** The active config; its provider decides whose voices are listed. */
  config: ProviderConfig | null;
  onSaved: () => void;
}

/**
 * The voice picker as a page, opened from the Reading tab's voice card.
 *
 * It has no form of its own, so nothing has to be validated before the voices
 * are fetched: the config it lists from is the one that is already saved.
 */
export function VoicePickerPage({ store, providers, config, onSaved }: VoicePickerPageProps) {
  const t = useT();

  if (!config) return <p class="muted">{t('panel.no-provider')}</p>;
  if (config.provider === 'browser') return <p class="muted">{t('voice.browser-note')}</p>;

  return (
    <VoicePicker
      schema={PROVIDER_SCHEMAS[config.provider]}
      provider={providers[config.provider]}
      config={config}
      store={store}
      disabled={false}
      heading={false}
      onSaved={onSaved}
    />
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
