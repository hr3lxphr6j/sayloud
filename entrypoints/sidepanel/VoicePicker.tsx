/**
 * Lists a provider's voices and remembers which one was picked.
 *
 * The choice is saved on click rather than with the form: it is a separate
 * preference from the credentials, and a user who has just listened to a voice
 * should not have to also press Save. It is stored per provider, so switching
 * services and switching back keeps the voice that was chosen for each.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfigStore } from '~/lib/config-store';
import type { ProviderSchema } from '~/lib/providers/config-schema';
import { describeProviderError, errorMessage } from '~/lib/providers/errors';
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
  const [voices, setVoices] = useState<Voice[] | null>(null);
  const [status, setStatus] = useState<AsyncStatus>({ kind: 'idle' });
  const [selected, setSelected] = useState<string | null>(null);
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
          ? {
              kind: 'error',
              message: 'This provider returned no voices. Check the model, and the base URL.',
            }
          : { kind: 'ok', message: `${listed.length} voice${listed.length === 1 ? '' : 's'}.` }
      );
    } catch (error) {
      if (deadline.timedOut()) {
        setStatus({ kind: 'error', message: `No response after ${LOAD_TIMEOUT_MS / 1000}s.` });
      } else if (!deadline.signal.aborted) {
        setStatus({ kind: 'error', message: describeProviderError(error) });
      }
    } finally {
      deadline.dispose();
      if (inFlight.current === deadline) inFlight.current = null;
    }
  };

  const onSelect = async (voiceId: string) => {
    setSelected(voiceId);
    try {
      await store.saveSelectedVoice(schema.id, voiceId);
      setStatus({ kind: 'ok', message: `Voice saved: ${voiceId}` });
    } catch (error) {
      setStatus({ kind: 'error', message: `Could not save the voice: ${errorMessage(error)}` });
    }
  };

  return (
    <section class="section">
      <div class="section-header">
        <h2>Voice</h2>
        <button
          type="button"
          class="button"
          disabled={disabled || status.kind === 'running'}
          onClick={() => void onLoad()}
        >
          {status.kind === 'running' ? 'Loading…' : 'Load Voices'}
        </button>
      </div>

      {selected && (
        <p class="muted">
          Selected: <code>{selected}</code>
        </p>
      )}

      {config === null && showFormErrors && (
        <p class="result error" role="alert">
          Fill in the required fields above first.
        </p>
      )}

      <StatusLine status={status} />

      {voices !== null && voices.length > 0 && (
        <ul class="voice-list">
          {voices.map((voice) => (
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
                {voice.supportsTimings === true && <span class="badge">word timings</span>}
              </label>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
