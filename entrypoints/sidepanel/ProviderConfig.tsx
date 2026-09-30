/**
 * The Settings tab: pick a provider, fill in its fields, test, save.
 *
 * The form is generated from `PROVIDER_SCHEMAS`, so this file knows about field
 * *kinds* and nothing about any particular service. Adding a provider to that
 * table is enough to get a form for it here.
 *
 * The saved config is passed in rather than read here, so the panel is the only
 * place that talks to storage for the config; this component owns the draft
 * (the provider being edited, and the values typed so far).
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfigStore, SavedConfigs } from '~/lib/config-store';
import { type Translator, useT } from '~/lib/i18n';
import { type PermissionsApi, requestProviderAccess } from '~/lib/provider-origins';
import {
  configToFormValues,
  type FieldError,
  type FieldSpec,
  type FormValue,
  type FormValues,
  formValuesToConfig,
  PROVIDER_IDS,
  PROVIDER_SCHEMAS,
  type ProviderSchema,
  validateFormValues,
} from '~/lib/providers/config-schema';
import { errorMessage, formatProviderError, providerErrorSummary } from '~/lib/providers/errors';
import type { CloudProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig, ProviderId } from '~/lib/providers/types';
import { type Deadline, startDeadline } from './deadline';
import { type AsyncStatus, StatusLine } from './StatusLine';
import { VoicePicker } from './VoicePicker';

/**
 * Long enough for a slow synthesis — `validate()` really does speak two
 * characters on DashScope and Volcengine — and short enough that a hung socket
 * stops looking like a slow one.
 */
const VALIDATE_TIMEOUT_MS = 20_000;

/**
 * The message for a rejected field.
 *
 * The schema reports a code; the field's own name is filled in here because
 * only the panel knows which language the label is being read in.
 */
function fieldErrorText(error: FieldError, field: FieldSpec, t: Translator): string {
  return t(`error.${error.code}`, { field: t(field.labelKey), ...error.params });
}

export interface ProviderConfigPanelProps {
  store: ConfigStore;
  providers: Record<CloudProviderId, Provider>;
  /** The active config, which decides the provider shown first. */
  saved: ProviderConfig | null;
  /** The last config saved for each provider, used to seed its form. */
  savedConfigs: SavedConfigs;
  /**
   * Called after anything was written — a save or a forget — so the owner can
   * re-read the store. The store is the one source of truth; this panel keeps
   * no copy of what it holds.
   */
  onChanged: () => void;
  /** `chrome.permissions`; absent in tests, where no host grant is asked for. */
  permissions?: PermissionsApi;
}

export function ProviderConfigPanel({
  store,
  providers,
  saved,
  savedConfigs,
  onChanged,
  permissions,
}: ProviderConfigPanelProps) {
  const t = useT();
  const [selected, setSelected] = useState<ProviderId>(() => saved?.provider ?? 'browser');
  const schema = PROVIDER_SCHEMAS[selected];
  const provider = selected === 'browser' ? null : providers[selected];

  return (
    <div class="stack">
      <div class="field">
        <label class="field-label" for="provider-select">
          {t('provider.picker-label')}
        </label>
        <select
          id="provider-select"
          value={selected}
          onChange={(event) => setSelected(event.currentTarget.value as ProviderId)}
        >
          {PROVIDER_IDS.map((id) => (
            <option key={id} value={id}>
              {t(PROVIDER_SCHEMAS[id].labelKey)}
            </option>
          ))}
        </select>
        <span class="field-help">{t(schema.summaryKey)}</span>
        {schema.consoleUrl && (
          <a class="field-help link" href={schema.consoleUrl} target="_blank" rel="noreferrer">
            {t('provider.console-link', { name: t(schema.labelKey) })}
          </a>
        )}
      </div>

      {/*
        Keyed by provider so switching starts from a clean form: the values,
        the inline errors and any test result all belong to one provider.
      */}
      <ProviderForm
        key={selected}
        schema={schema}
        provider={provider}
        saved={savedConfigs[selected] ?? null}
        store={store}
        onChanged={onChanged}
        permissions={permissions}
      />
    </div>
  );
}

interface ProviderFormProps {
  schema: ProviderSchema;
  /** Null for the browser voice, which has nothing to check or list. */
  provider: Provider | null;
  saved: ProviderConfig | null;
  store: ConfigStore;
  onChanged: () => void;
  permissions: PermissionsApi | undefined;
}

function ProviderForm({
  schema,
  provider,
  saved,
  store,
  onChanged,
  permissions,
}: ProviderFormProps) {
  const t = useT();
  const [values, setValues] = useState<FormValues>(() => configToFormValues(schema, saved));
  /** Errors appear only once the user has tried to do something with the form. */
  const [submitted, setSubmitted] = useState(false);
  const [test, setTest] = useState<AsyncStatus>({ kind: 'idle' });
  const [save, setSave] = useState<AsyncStatus>({ kind: 'idle' });
  const inFlight = useRef<Deadline | null>(null);

  useEffect(() => () => inFlight.current?.cancel(), []);

  const errors = validateFormValues(schema, values);
  const valid = Object.keys(errors).length === 0;
  const draft = valid ? formValuesToConfig(schema, values, saved) : null;
  const busy = test.kind === 'running' || save.kind === 'running';

  const update = (key: string, value: FormValue) => {
    setValues((current) => ({ ...current, [key]: value }));
    // A result from before the edit describes a config that no longer exists.
    setTest({ kind: 'idle' });
    setSave({ kind: 'idle' });
  };

  const onTest = async () => {
    setSubmitted(true);
    if (!provider || !draft) return;

    // Before any await: the prompt needs the click's user gesture.
    const access = requestProviderAccess(draft, permissions);

    const deadline = startDeadline(VALIDATE_TIMEOUT_MS);
    inFlight.current?.cancel();
    inFlight.current = deadline;
    setTest({ kind: 'running' });

    try {
      if (!(await access)) {
        setTest({ kind: 'error', message: t('provider.access-declined') });
        return;
      }
      await provider.validate(draft, deadline.signal);
      setTest({ kind: 'ok', message: t('provider.test-succeeded') });
    } catch (error) {
      // A cancelled request is either this panel's own deadline or a request
      // that a newer one replaced; neither is a failure to report.
      if (deadline.timedOut()) {
        setTest({
          kind: 'error',
          message: t('error.no-response', { seconds: VALIDATE_TIMEOUT_MS / 1000 }),
        });
      } else if (!deadline.signal.aborted) {
        setTest({ kind: 'error', message: formatProviderError(providerErrorSummary(error), t) });
      }
    } finally {
      deadline.dispose();
      if (inFlight.current === deadline) inFlight.current = null;
    }
  };

  const onSave = async () => {
    setSubmitted(true);
    if (!draft) return;

    // Before any await: the prompt needs the click's user gesture.
    const access = requestProviderAccess(draft, permissions);

    setSave({ kind: 'running' });
    try {
      // A config the extension cannot reach would only fail later, mid-read.
      if (!(await access)) {
        setSave({ kind: 'error', message: t('provider.access-declined') });
        return;
      }
      await store.saveConfig(draft);
      setSave({ kind: 'ok', message: t('provider.saved') });
      onChanged();
    } catch (error) {
      setSave({
        kind: 'error',
        message: t('provider.save-failed', { detail: errorMessage(error) }),
      });
    }
  };

  const onForget = async () => {
    setSave({ kind: 'running' });
    try {
      await store.forgetConfig(schema.id);
      setValues(configToFormValues(schema, null));
      setTest({ kind: 'idle' });
      setSave({ kind: 'ok', message: t('provider.forgotten') });
      // Forgetting the active provider also made the browser voice active.
      onChanged();
    } catch (error) {
      setSave({
        kind: 'error',
        message: t('provider.forget-failed', { detail: errorMessage(error) }),
      });
    }
  };

  return (
    <div class="stack">
      {schema.fields.length === 0 ? (
        <p class="notice">{t('provider.browser-notice')}</p>
      ) : (
        <div class="form">
          {schema.fields.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={values[field.key]}
              error={submitted ? errors[field.key] : undefined}
              disabled={busy}
              onChange={update}
            />
          ))}
        </div>
      )}

      <CapabilityNote provider={provider} config={draft} />

      <div class="actions">
        {provider && (
          <button type="button" class="button" disabled={busy} onClick={() => void onTest()}>
            {test.kind === 'running' ? t('provider.testing') : t('provider.test')}
          </button>
        )}
        <button type="button" class="button primary" disabled={busy} onClick={() => void onSave()}>
          {save.kind === 'running' ? t('provider.saving') : t('provider.save')}
        </button>
        {saved && schema.id !== 'browser' && (
          <button type="button" class="button" disabled={busy} onClick={() => void onForget()}>
            {t('provider.forget')}
          </button>
        )}
      </div>

      <div class="form-results">
        <StatusLine status={test} />
        <StatusLine status={save} />
      </div>

      {provider && (
        <VoicePicker
          schema={schema}
          provider={provider}
          config={draft}
          store={store}
          disabled={busy}
          onAttempt={() => setSubmitted(true)}
          showFormErrors={submitted}
        />
      )}
    </div>
  );
}

/** What this provider will do about word-level highlighting. */
function CapabilityNote({
  provider,
  config,
}: {
  provider: Provider | null;
  config: ProviderConfig | null;
}) {
  const t = useT();
  if (!provider || !config) return null;

  let exact: boolean;
  try {
    exact = provider.capabilities(config).timings === 'exact';
  } catch {
    // `capabilities()` throws only on a wiring bug, and the form should not
    // disappear because of one.
    return null;
  }

  return <p class="notice">{t(exact ? 'provider.timings-exact' : 'provider.timings-none')}</p>;
}

interface FieldProps {
  field: FieldSpec;
  value: FormValue | undefined;
  error: FieldError | undefined;
  disabled: boolean;
  onChange: (key: string, value: FormValue) => void;
}

function Field({ field, value, error, disabled, onChange }: FieldProps) {
  const t = useT();
  const id = `field-${field.key}`;
  const helpId = `${id}-help`;
  const errorId = `${id}-error`;
  const describedBy = [field.helpKey ? helpId : null, error ? errorId : null]
    .filter(Boolean)
    .join(' ');

  const text = typeof value === 'string' ? value : '';
  const label = (
    <>
      {t(field.labelKey)}
      {field.required && (
        <span class="required" aria-hidden="true">
          {' '}
          *
        </span>
      )}
    </>
  );
  const help = field.helpKey && (
    <span class="field-help" id={helpId}>
      {t(field.helpKey)}
    </span>
  );
  const message = error && (
    <span class="field-error" id={errorId}>
      {fieldErrorText(error, field, t)}
    </span>
  );

  if (field.kind === 'boolean') {
    return (
      <div class="field checkbox">
        <label for={id}>
          <input
            id={id}
            type="checkbox"
            checked={value === true}
            disabled={disabled}
            aria-describedby={describedBy || undefined}
            onChange={(event) => onChange(field.key, event.currentTarget.checked)}
          />
          {label}
        </label>
        {help}
        {message}
      </div>
    );
  }

  const shared = {
    id,
    disabled,
    'aria-describedby': describedBy || undefined,
    'aria-invalid': error ? true : undefined,
  };

  return (
    <div class="field">
      <label class="field-label" for={id}>
        {label}
      </label>
      {field.kind === 'select' ? (
        <select
          {...shared}
          value={text}
          onChange={(event) => onChange(field.key, event.currentTarget.value)}
        >
          {/* An optional select left blank means "whatever the provider defaults to". */}
          {!field.required && <option value="">{t('field.default-option')}</option>}
          {field.options?.map((option) => (
            <option key={option.value} value={option.value}>
              {t(option.labelKey)}
            </option>
          ))}
        </select>
      ) : field.kind === 'kv' ? (
        <textarea
          {...shared}
          rows={3}
          placeholder={field.placeholder}
          spellcheck={false}
          value={text}
          // `input`, not `change`: Preact maps onChange to the DOM event, which
          // fires on blur, so the form would lag one edit behind what is typed.
          onInput={(event) => onChange(field.key, event.currentTarget.value)}
        />
      ) : (
        <input
          {...shared}
          type={field.kind === 'password' ? 'password' : field.kind === 'url' ? 'url' : 'text'}
          placeholder={field.placeholder}
          spellcheck={false}
          autocomplete="off"
          value={text}
          onInput={(event) => onChange(field.key, event.currentTarget.value)}
        />
      )}
      {help}
      {message}
    </div>
  );
}
