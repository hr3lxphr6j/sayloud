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
import type { ConfigStore, VoiceNames } from '~/lib/config-store';
import { useT } from '~/lib/i18n';
import { PROVIDER_SCHEMAS, type ProviderSchema } from '~/lib/providers/config-schema';
import { errorMessage, formatProviderError, providerErrorSummary } from '~/lib/providers/errors';
import type { AdapterProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig, Voice } from '~/lib/providers/types';
import { type Deadline, startDeadline } from './deadline';
import { type AsyncStatus, StatusLine } from './StatusLine';

/** Voice catalogues are small, but a local server can take a moment to answer. */
const LOAD_TIMEOUT_MS = 15_000;

export interface VoicePickerProps {
  schema: ProviderSchema;
  provider: Provider;
  /**
   * The saved config to list voices from. Not nullable: this picker is only
   * reachable for the service already in use, and an unsaved config has no
   * catalogue to ask for — the panel says so instead of showing this.
   */
  config: ProviderConfig;
  store: ConfigStore;
  /** A voice was saved, so a reader looking at the same setting can catch up. */
  onSaved?: () => void;
}

export function VoicePicker({ schema, provider, config, store, onSaved }: VoicePickerProps) {
  const t = useT();
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [status, setStatus] = useState<AsyncStatus>({ kind: 'idle' });
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [typedId, setTypedId] = useState('');
  /** The names voices were listed under, so a chosen id can be shown as one. */
  const [names, setNames] = useState<VoiceNames>({});
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
    store
      .getVoiceNames()
      .then((loaded) => {
        if (active) setNames(loaded);
      })
      .catch((error: unknown) => {
        console.error('[SayLoud] cannot read the voice names', error);
      });
    return () => {
      active = false;
    };
  }, [store, schema.id]);

  /**
   * A stable stand-in for the config, which the parent rebuilds on every render.
   *
   * The list belongs to the config it was fetched for — another model has other
   * voices — so a fetch is only reusable while this key is unchanged.
   */
  const configKey = config === null ? '' : JSON.stringify(config);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);

  useEffect(() => {
    // A quiet line describes the config it was produced for. Once that config
    // is edited the line is no longer about anything, so it goes — this is what
    // keeps "fill in the fields above" from outliving the fields being filled
    // in.
    setStatus((current) => (current.kind === 'quiet' ? { kind: 'idle' } : current));
  }, [configKey]);

  useEffect(() => () => inFlight.current?.cancel(), []);

  const onLoad = async () => {
    const deadline = startDeadline(LOAD_TIMEOUT_MS);
    inFlight.current?.cancel();
    inFlight.current = deadline;
    setStatus({ kind: 'running' });

    try {
      const listed = await provider.listVoices(config, deadline.signal);
      setVoices(listed);
      setLoadedKey(configKey);
      setStatus(
        listed.length === 0
          ? { kind: 'quiet', message: t('voice.none-returned') }
          : {
              kind: 'ok',
              message: t(listed.length === 1 ? 'voice.count-one' : 'voice.count-many', {
                count: listed.length,
              }),
            }
      );
    } catch (error) {
      // Quiet on purpose. A list that could not be fetched is not something the
      // reader has to act on, and the manual id box below still works — while a
      // red failure would fire every time someone opens a row whose key is not
      // filled in yet, which is most of the time on first run.
      if (deadline.timedOut()) {
        setStatus({
          kind: 'quiet',
          message: t('voice.load-failed', {
            detail: t('error.no-response', { seconds: LOAD_TIMEOUT_MS / 1000 }),
          }),
        });
      } else if (!deadline.signal.aborted) {
        setStatus({
          kind: 'quiet',
          message: t('voice.load-failed', {
            detail: formatProviderError(providerErrorSummary(error), t),
          }),
        });
      }
    } finally {
      deadline.dispose();
      if (inFlight.current === deadline) inFlight.current = null;
    }
  };

  /**
   * Fetch the list when the search box is focused.
   *
   * Focus rather than a button: the box is where someone who wants a voice
   * looks anyway, and it lets the section read as "type here" instead of
   * "press that". An attempt that failed is retried on the next focus, because
   * the fix for most failures is editing the config above and coming back.
   */
  const onSearchFocus = () => {
    if (status.kind === 'running') return;
    // Fetch when there is nothing to show, and again when what is on screen was
    // fetched for a config that has since been edited.
    if (voices === null || loadedKey !== configKey) void onLoad();
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
      if (name !== undefined) {
        await store.saveVoiceName(schema.id, voiceId, name);
        // Keep the copy in step so the line above does not fall back to the id
        // for a voice the user just picked out of the list.
        setNames((current) => ({
          ...current,
          [schema.id]: { ...current[schema.id], [voiceId]: name },
        }));
      }
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
  const listed = voices !== null && voices.length > 0;
  const selectedName = selected === null ? null : (names[schema.id]?.[selected] ?? null);

  return (
    <section class="section voice-section">
      {selected && (
        <p class="muted">
          {t('voice.selected')}{' '}
          {/*
            The name when the catalogue gave one, the id otherwise. A name is
            only known for a voice picked out of a list, so the id stays the
            honest fallback rather than something invented from it.
          */}
          {selectedName ? (
            <span class="voice-name" title={selected}>
              {selectedName}
            </span>
          ) : (
            <code>{selected}</code>
          )}
        </p>
      )}

      {/*
        Always present, because focusing it is the only way in: the button that
        used to fetch the list sat in the header and read as a section-level
        action rather than as the way to see the section's contents.
      */}
      <input
        type="search"
        aria-label={t('voice.filter-label')}
        placeholder={
          listed
            ? t(voices.length === 1 ? 'voice.filter-one' : 'voice.filter-many', {
                count: voices.length,
              })
            : t('voice.search')
        }
        value={query}
        onFocus={onSearchFocus}
        onInput={(event) => setQuery(event.currentTarget.value)}
      />

      {status.kind === 'running' ? (
        <p class="muted">{t('voice.loading')}</p>
      ) : (
        <StatusLine status={status} />
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
            onInput={(event) => setTypedId(event.currentTarget.value)}
          />
          <button type="submit" class="button" disabled={typedId.trim() === ''}>
            {t('voice.use-id')}
          </button>
        </div>
      </form>
    </section>
  );
}

export interface VoicePickerPageProps {
  store: ConfigStore;
  providers: Record<AdapterProviderId, Provider>;
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
