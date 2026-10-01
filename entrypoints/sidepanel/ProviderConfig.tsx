/**
 * The Settings tab: the provider list, its in-place forms, and the voice
 * picker that belongs to each one.
 *
 * The form is generated from `PROVIDER_SCHEMAS`, so this file knows about field
 * *kinds* and nothing about any particular service. Adding a provider to that
 * table is enough to get a row and a form for it here.
 *
 * The list is rows rather than a `<select>` (spec §8.2): a service has a status
 * to show — configured or not, in use or not — and the form for the chosen one
 * opens where the row is, so the panel never loses the user's place. The saved
 * config is passed in rather than read here, so the panel is the only place that
 * talks to storage for the config; this component owns the draft (which row is
 * open, and the values typed so far).
 *
 * Each row carries two controls, which are two different jobs: the circle (a
 * radio, since one of N is in use) says which service SayLoud reads with, and
 * the row's own button opens the form that configures it. They are siblings on
 * purpose — a button cannot hold another — and because saving a config must not
 * be the thing that starts using it.
 *
 * The form saves itself when a field loses focus (spec §8.2), which is why
 * there is no Save button: there is nothing to press. What it does have is a
 * line saying whether the write happened, because a form that fails validation
 * writes nothing and leaves the typed key in place.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfigStore, SavedConfigs, VoiceNames } from '~/lib/config-store';
import { type Translator, useT } from '~/lib/i18n';
import {
  hasProviderAccess,
  type PermissionsApi,
  requestProviderAccess,
} from '~/lib/provider-origins';
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
import type { AdapterProviderId } from '~/lib/providers/registry';
import type { Provider, ProviderConfig, ProviderId } from '~/lib/providers/types';
import { type Deadline, startDeadline } from './deadline';
import { type AsyncStatus, StatusLine } from './StatusLine';
import { ChevronRight } from './ui/icons';
import { StatusDot } from './ui/StatusDot';

/**
 * Long enough for a slow synthesis — `validate()` really does speak two
 * characters on Dashscope and Volcengine — and short enough that a hung socket
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
  providers: Record<AdapterProviderId, Provider>;
  /** The active config, which decides which row opens first. */
  saved: ProviderConfig | null;
  /** The last config saved for each provider, used to seed its form. */
  savedConfigs: SavedConfigs;
  /** The voice chosen for each provider, for the row summaries. */
  voices?: Record<string, string>;
  /**
   * What those voices were called in the list they were picked from, so a row
   * can say "Vivi 2.0" where it would otherwise spell out an id.
   */
  voiceNames?: VoiceNames;
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
  voices = {},
  voiceNames = {},
  onChanged,
  permissions,
}: ProviderConfigPanelProps) {
  const t = useT();
  // With nothing saved the browser voice is what is in use, so its row is the
  // one that opens: the list starts by showing the current state of things.
  const [open, setOpen] = useState<ProviderId | null>(() => saved?.provider ?? 'browser');
  const active = saved?.provider ?? 'browser';

  /**
   * Choose which service is in use. Separate from the form's Save on purpose.
   *
   * `setActiveConfig` refuses a provider with nothing saved — the control is
   * disabled in that case, and this is the backstop — so a refusal only has to
   * leave the list as it was.
   *
   * Exception: the local provider gets a default config when activated with
   * nothing saved, and when already active with a saved config, the saved one
   * is synced to match the active one (fixes stale saved configs).
   */
  const activate = async (provider: ProviderId) => {
    if (provider === 'local') {
      const configs = await store.getSavedConfigs();
      const localSaved = configs.local;
      if (!localSaved) {
        // Create a default config so the user can activate local without visiting
        // the Models tab first. Use fp16 as the default tier (best balance of
        // speed and quality when WebGPU is available).
        await store.saveConfig({
          provider: 'local',
          modelId: 'kokoro-82m',
          tier: 'fp16',
          device: 'auto',
        });
      } else if (localSaved.provider === 'local' && saved?.provider === 'local') {
        // Sync saved config to active config when they differ (e.g. user changed
        // tier in Models tab but saved config wasn't updated). This prevents
        // "model not downloaded" errors when the saved tier differs from active.
        if (localSaved.tier !== saved.tier || localSaved.modelId !== saved.modelId) {
          await store.saveConfig(saved);
        }
      }
    }
    if (await store.setActiveConfig(provider)) onChanged();
  };

  return (
    <>
      <p class="muted small">{t('provider.list.hint')}</p>
      <div class="provider-list" role="radiogroup" aria-label={t('provider.list.label')}>
        {PROVIDER_IDS.map((id) => {
          const schema = PROVIDER_SCHEMAS[id];
          const config = id === 'browser' ? null : (savedConfigs[id] ?? null);
          const expanded = open === id;
          const inUse = active === id;
          const voice = voices[id];
          // The browser voice needs no config, so it can always be chosen; a
          // service with nothing saved has nothing to switch to.
          const activatable = id === 'browser' || config !== null;

          return (
            <div class="provider-entry" key={id} data-provider={id} data-active={inUse}>
              <div class="provider-row">
                {/*
                  A real radio, not a button wearing the role: the circle is
                  one of N, and the browser's own grouping is what gives arrow
                  keys, the checked state and the disabled state for free. The
                  input is invisible and stretched over the label, which draws
                  the dot — so the hit target is the label, not the dot.
                */}
                <label class="provider-select">
                  <input
                    type="radio"
                    class="provider-radio"
                    name="sayloud-provider"
                    checked={inUse}
                    disabled={!activatable}
                    aria-label={t('provider.use', { service: t(schema.labelKey) })}
                    onChange={() => void activate(id)}
                  />
                  <StatusDot state={inUse ? 'active' : config ? 'configured' : 'empty'} />
                </label>
                <button
                  type="button"
                  class="provider-toggle"
                  aria-expanded={expanded}
                  aria-controls={expanded ? `provider-form-${id}` : undefined}
                  onClick={() => setOpen(expanded ? null : id)}
                >
                  <span class="provider-row-text">
                    <span class="provider-name">{t(schema.labelKey)}</span>
                    <span class="provider-summary">
                      {config
                        ? t('provider.configured', {
                            // The id is what is stored; the name is how the list
                            // the user picked it from wrote it. Unknown voices —
                            // typed in by id — keep the id, which is all we know.
                            voice: voice
                              ? (voiceNames[id]?.[voice] ?? voice)
                              : t('panel.default-voice'),
                          })
                        : t(schema.summaryKey)}
                    </span>
                  </span>
                  {inUse && <span class="pill active">{t('provider.active')}</span>}
                  <span class="provider-chevron">
                    <ChevronRight />
                  </span>
                </button>
              </div>

              {/*
                Keyed by provider so opening another row starts from a clean
                form: the values, the inline errors and any test result all
                belong to one provider.
              */}
              {expanded && (
                <div class="provider-form" id={`provider-form-${id}`}>
                  <ProviderForm
                    key={id}
                    schema={schema}
                    provider={id === 'browser' ? null : providers[id]}
                    saved={config}
                    active={inUse}
                    store={store}
                    onChanged={onChanged}
                    permissions={permissions}
                  />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

interface ProviderFormProps {
  schema: ProviderSchema;
  /** Null for the browser voice, which has nothing to check or list. */
  provider: Provider | null;
  saved: ProviderConfig | null;
  /** Whether this provider is the one in use; it decides what Save reports. */
  active: boolean;
  store: ConfigStore;
  onChanged: () => void;
  permissions: PermissionsApi | undefined;
}

function ProviderForm({
  schema,
  provider,
  saved,
  active,
  store,
  onChanged,
  permissions,
}: ProviderFormProps) {
  const t = useT();
  const [values, setValues] = useState<FormValues>(() => configToFormValues(schema, saved));
  /**
   * Whether the user has done something with this form.
   *
   * Field errors belong to a form somebody has tried to use: one that has just
   * opened with an empty required field is not wrong yet. The form saves on the
   * first blur, so that is exactly what "tried to use" means here.
   */
  const [touched, setTouched] = useState(false);
  const [test, setTest] = useState<AsyncStatus>({ kind: 'idle' });
  const [save, setSave] = useState<AsyncStatus>({ kind: 'idle' });
  /**
   * Whether the last save failed for lack of host access.
   *
   * That failure is the one the form can get out of, so it gets a way out: the
   * prompt needs a user gesture, and only a click has one.
   */
  const [grantNeeded, setGrantNeeded] = useState(false);
  const inFlight = useRef<Deadline | null>(null);

  useEffect(() => () => inFlight.current?.cancel(), []);

  const errors = validateFormValues(schema, values);
  const valid = Object.keys(errors).length === 0;
  const draft = valid ? formValuesToConfig(schema, values, saved) : null;
  /**
   * The fields this form draws.
   *
   * Hidden ones are left out entirely: they are validated and saved like any
   * other, but the Models tab is where the user changes them, and a second
   * control for the same setting is a second thing that can disagree.
   */
  const visibleFields = schema.fields.filter((field) => !field.hidden);
  /**
   * A running Test Connection owns the form: its result is about what is on
   * screen, so the fields must not change under it.
   *
   * A running save deliberately does not. A save starts when a field loses
   * focus, which is the first half of the click that focuses the next control —
   * disabling anything for its duration would swallow that click.
   */
  const testing = test.kind === 'running';
  /**
   * Bumped by every edit, so a save that finishes after one does not report on
   * values that are no longer on screen.
   */
  const revision = useRef(0);
  /** The saved config as form values, which is what an edit is measured against. */
  const savedValues = configToFormValues(schema, saved);

  const update = (key: string, value: FormValue) => {
    setValues((current) => ({ ...current, [key]: value }));
    revision.current += 1;
    // A result from before the edit describes a config that no longer exists.
    setTest({ kind: 'idle' });
    setSave({ kind: 'idle' });
    setGrantNeeded(false);
  };

  const onTest = async () => {
    setTouched(true);
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

  /**
   * Write `config` and report what happened.
   *
   * `access` is passed in rather than awaited here because the prompt needs the
   * click's gesture and the first `await` gives it up; the caller starts it. A
   * call whose gesture is gone must not have been made at all — see the check
   * in `autoSave` — so a refusal here means the user declined the prompt or the
   * host is not granted and no prompt could be raised.
   */
  const write = async (config: ProviderConfig, access: Promise<boolean>) => {
    const started = revision.current;
    setSave({ kind: 'running' });
    setGrantNeeded(false);
    try {
      // A config the extension cannot reach would only fail later, mid-read.
      if (!(await access.catch(() => false))) {
        if (revision.current === started) {
          setGrantNeeded(true);
          setSave({
            kind: 'error',
            message: t('provider.not-saved', { detail: t('provider.access-needed') }),
          });
        }
        return;
      }
      await store.saveConfig(config);
      // Saving is not switching, and this row was already the one in use — so
      // re-point the active config at what was just saved. Leaving the old
      // values there would mean the panel shows one key while the engine reads
      // with another until the user thinks to press the circle again.
      if (active) await store.setActiveConfig(schema.id);
      if (revision.current === started) {
        setSave({
          kind: 'ok',
          message: t(active ? 'provider.saved' : 'provider.saved-not-active'),
        });
      }
      // The write happened either way, so the owner still has to re-read.
      onChanged();
    } catch (error) {
      if (revision.current === started) {
        setSave({
          kind: 'error',
          message: t('provider.not-saved', { detail: errorMessage(error) }),
        });
      }
    }
  };

  /**
   * Save what was typed when a field loses focus.
   *
   * On blur rather than on every keystroke: a half-typed key is not a config,
   * and writing one per character would fill storage with them. The form is
   * validated whole, so an invalid one writes nothing and the saved values stay
   * as they were.
   */
  const autoSave = () => {
    setTouched(true);
    if (!draft) {
      // The fields say which one is wrong; the line says that nothing was
      // written, which is the part looking at the form cannot tell you.
      setGrantNeeded(false);
      setSave({ kind: 'error', message: t('provider.not-saved-invalid') });
      return;
    }
    // Tabbing through a form that was not edited is not a save.
    const edited = schema.fields.some((field) => values[field.key] !== savedValues[field.key]);
    if (!edited) return;

    // Nothing is asked for here: a blur carries no user gesture, and
    // `permissions.request` without one never comes back — the line would sit
    // at "Saving…" forever. The grant is only checked, and the Grant access
    // button takes on the asking.
    void hasProviderAccess(draft, permissions).then((granted) =>
      write(draft, Promise.resolve(granted))
    );
  };

  /**
   * Ask for the host grant again, now that there is a gesture to ask with, and
   * write the config once it is there.
   */
  const onGrantAccess = () => {
    if (!draft) return;
    void write(draft, requestProviderAccess(draft, permissions));
  };

  const onDelete = async () => {
    setSave({ kind: 'running' });
    setGrantNeeded(false);
    try {
      await store.forgetConfig(schema.id);
      setValues(configToFormValues(schema, null));
      setTest({ kind: 'idle' });
      setSave({ kind: 'ok', message: t('provider.deleted') });
      // Deleting the active provider also made the browser voice active.
      onChanged();
    } catch (error) {
      setSave({
        kind: 'error',
        message: t('provider.delete-failed', { detail: errorMessage(error) }),
      });
    }
  };

  return (
    <div class="stack">
      {visibleFields.length === 0 ? (
        <p class="notice">{t(schema.formNoticeKey ?? 'provider.browser-notice')}</p>
      ) : (
        /*
          The listener sits on the container, not on each field: `blur` does not
          bubble, so a handler on the parent of a field never hears about it.
          `focusout` does bubble, and it fires for every way out of a field —
          including the one that closes this form.
        */
        <div class="form" onFocusOut={autoSave}>
          {visibleFields.map((field) => (
            <Field
              key={field.key}
              field={field}
              value={values[field.key]}
              error={touched ? errors[field.key] : undefined}
              disabled={testing}
              onChange={update}
            />
          ))}
        </div>
      )}

      <CapabilityNote provider={provider} config={draft} />

      {schema.consoleUrl && (
        <a class="field-help link" href={schema.consoleUrl} target="_blank" rel="noreferrer">
          {t('provider.console-link', { name: t(schema.labelKey) })}
        </a>
      )}

      {/*
        Test Connection is the only button left: the form saves itself when a
        field loses focus, and a key that is already saved is dropped from the
        link at the bottom. Neither needs a button of its own.

        Local models have no API to test, so they get no button.
      */}
      {provider && schema.id !== 'local' && (
        <div class="actions">
          <button type="button" class="button" disabled={testing} onClick={() => void onTest()}>
            {test.kind === 'running' ? t('provider.testing') : t('provider.test')}
          </button>
        </div>
      )}

      <div class="form-results">
        <StatusLine status={test} />
        <div class="save-status">
          {/*
            A running save needs a line of its own — there is no button left to
            carry the spinner, and a silent pause after a blur reads as nothing
            having happened.
          */}
          {save.kind === 'running' ? (
            <p class="result muted" role="status">
              {t('provider.saving')}
            </p>
          ) : (
            <StatusLine status={save} />
          )}
          {grantNeeded && (
            <button type="button" class="button" disabled={testing} onClick={onGrantAccess}>
              {t('provider.grant-access')}
            </button>
          )}
        </div>
      </div>

      {/*
        No voice picker here. Choosing a voice is about how the reading sounds
        rather than about what this service is, and the Reading tab's voice card
        is the one place that does it — one place, one answer to "which voice am
        I using", and no second copy to keep in step.
      */}

      {/*
        Last, and quiet: deleting is the rare thing to do here, and it is the
        only way to drop a key once it is stored. Offered only when there is
        something to delete. Hidden for providers whose fields are all hidden
        (e.g. local, whose config lives on the Models tab) — there is no key
        to delete.
      */}
      {saved && schema.fields.some((f) => !f.hidden) && (
        <button
          type="button"
          class="provider-delete"
          disabled={testing}
          onClick={() => void onDelete()}
        >
          {t('provider.delete')}
        </button>
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
