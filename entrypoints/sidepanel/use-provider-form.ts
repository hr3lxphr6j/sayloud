/**
 * The provider form's behaviour: the draft, the writes and the three actions
 * that change them.
 *
 * Split out of `ProviderConfig.tsx` so the component is markup and this is the
 * part with timing in it — a validation deadline, a queue that keeps saves in
 * edit order, and a revision counter that stops a late write from reporting on
 * values that are no longer on screen. None of that is visible in the DOM,
 * which is exactly why it is worth having in one place with a name.
 *
 * The hook is called once per open form: `ProviderConfigPanel` keys the form by
 * provider, so switching rows remounts it and every piece of state here starts
 * over with the new provider's saved config.
 */
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ConfigStore } from '~/lib/config-store';
import { useT } from '~/lib/i18n';
import {
  hasProviderAccess,
  type PermissionsApi,
  requestProviderAccess,
} from '~/lib/provider-origins';
import {
  configToFormValues,
  type FieldErrors,
  type FormValue,
  type FormValues,
  formValuesToConfig,
  type ProviderSchema,
  validateFormValues,
} from '~/lib/providers/config-schema';
import { errorMessage, formatProviderError, providerErrorSummary } from '~/lib/providers/errors';
import type { Provider, ProviderConfig } from '~/lib/providers/types';
import { type Deadline, startDeadline } from './deadline';
import type { AsyncStatus } from './StatusLine';

/**
 * Long enough for a slow synthesis — `validate()` really does speak two
 * characters on Dashscope and Volcengine — and short enough that a hung socket
 * stops looking like a slow one.
 */
const VALIDATE_TIMEOUT_MS = 20_000;

export interface ProviderFormOptions {
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

/** What the form's markup reads, and the four things a user can do to it. */
export interface ProviderFormActions {
  values: FormValues;
  /** Whether the user has done something with this form. */
  touched: boolean;
  test: AsyncStatus;
  save: AsyncStatus;
  /** Whether the last save failed for lack of host access. */
  grantNeeded: boolean;
  errors: FieldErrors;
  valid: boolean;
  /** The config as it would be saved, or null while the form does not validate. */
  draft: ProviderConfig | null;
  /** True while a test is running, which is when the fields must not change. */
  testing: boolean;
  update: (key: string, value: FormValue) => void;
  onTest: () => Promise<void>;
  /** Save what was typed; wired to the form's `focusout`. */
  autoSave: () => void;
  onGrantAccess: () => void;
  onDelete: () => Promise<void>;
}

export function useProviderFormActions({
  schema,
  provider,
  saved,
  active,
  store,
  onChanged,
  permissions,
}: ProviderFormOptions): ProviderFormActions {
  const t = useT();
  const [values, setValues] = useState<FormValues>(() => configToFormValues(schema, saved));
  /**
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
  const writeQueue = useRef(Promise.resolve());
  /** The saved config as form values, which is what an edit is measured against. */
  const savedValues = configToFormValues(schema, saved);

  /** The line every failed write shares: what was attempted, and what stopped it. */
  const notSaved = (detail: string) => {
    setSave({ kind: 'error', message: t('provider.not-saved', { detail }) });
  };

  /**
   * A write is starting.
   *
   * The grant offer goes with it: it belongs to the previous attempt, and a
   * second write that needs access raises its own.
   */
  const startWrite = () => {
    setSave({ kind: 'running' });
    setGrantNeeded(false);
  };

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
    const granted = access.catch(() => false);
    const operation = async (): Promise<void> => {
      startWrite();
      try {
        // A config the extension cannot reach would only fail later, mid-read.
        if (!(await granted)) {
          if (revision.current === started) {
            setGrantNeeded(true);
            notSaved(t('provider.access-needed'));
          }
          return;
        }
        await store.saveConfig(config);
        // Saving is not switching, and this row was already the one in use — so
        // re-point the active config at what was just saved. Leaving the old
        // values there would mean the panel shows one key while the engine reads
        // with another until the user thinks to press the circle again.
        if (active && (await store.getConfig())?.provider === schema.id) {
          await store.setActiveConfig(schema.id);
        }
        if (revision.current === started) {
          setSave({
            kind: 'ok',
            message: t(active ? 'provider.saved' : 'provider.saved-not-active'),
          });
        }
        // The write happened either way, so the owner still has to re-read.
        onChanged();
      } catch (error) {
        if (revision.current === started) notSaved(errorMessage(error));
      }
    };
    writeQueue.current = writeQueue.current.catch(() => {}).then(operation);
    await writeQueue.current;
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
    void write(draft, hasProviderAccess(draft, permissions));
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
    startWrite();
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

  return {
    values,
    touched,
    test,
    save,
    grantNeeded,
    errors,
    valid,
    draft,
    testing,
    update,
    onTest,
    autoSave,
    onGrantAccess,
    onDelete,
  };
}
