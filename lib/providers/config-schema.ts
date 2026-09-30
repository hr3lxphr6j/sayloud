/**
 * Form schema for `ProviderConfig`.
 *
 * The settings panel renders its fields from this table instead of from
 * hand-written JSX per provider: adding a provider, or a field to one, is a
 * change here and nowhere else. The same table validates what comes back out
 * of `chrome.storage.local`, which is untrusted — it is shared with other
 * versions of the extension, so nothing reaches the UI or an adapter without
 * being checked against the field it claims to be.
 *
 * `FieldSpec.key` is constrained to the config type's own keys, so a typo, or
 * a field declared for the wrong provider, fails `pnpm typecheck` instead of
 * quietly doing nothing.
 *
 * Kinds are chosen from the config type, not from what would look nicest: a
 * closed union (`volcengine.resourceId`, `azure.outputFormat`) is a `select`,
 * and an open `string` (a DashScope model name, an ElevenLabs output format) is
 * a text field, because a picker would stop a user from naming a model we have
 * not heard of yet.
 *
 * The table holds no prose: every label and help line is a `MessageKey`, and
 * the panel translates it. That keeps the schema usable from the service worker
 * and from tests, neither of which has a language.
 */
import type { MessageKey } from '../i18n/messages.en';
import type { ProviderConfig, ProviderConfigMap, ProviderId } from './types';

/** How a field is edited, which decides both the widget and the validation. */
export type FieldKind = 'text' | 'password' | 'url' | 'select' | 'boolean' | 'kv';

export interface FieldOption {
  readonly value: string;
  /** The option's name, translated by whoever renders it. */
  readonly labelKey: MessageKey;
}

/** One editable config key. */
export interface FieldSpec<K extends string = string> {
  readonly key: K;
  readonly labelKey: MessageKey;
  readonly kind: FieldKind;
  /** Blocks saving while the field is empty. */
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly helpKey?: MessageKey;
  /**
   * The value the form shows when nothing is saved.
   *
   * A default stands in for a value everywhere the field is read, so a
   * `required` field that has one is satisfied by it. It is deliberately not
   * `boolean`: a checkbox is never empty, so it has nothing to fall back to.
   */
  readonly defaultValue?: string;
  /** The allowed values, for `kind: 'select'`. */
  readonly options?: readonly FieldOption[];
  /**
   * Values a `select` used to offer, mapped to what a stored config holding
   * one is read as. Keeps a saved config usable after an option is dropped.
   */
  readonly retiredOptions?: Readonly<Record<string, string>>;
}

/**
 * A config key the form does not render but must not lose.
 *
 * `openai-compat.voices` and `elevenlabs.voiceSettings` are structured values
 * with no sensible form control, so the form leaves them alone; they are copied
 * over from the saved config on every save, and only their shape is checked
 * when reading them back.
 */
export interface PassthroughSpec<K extends string = string> {
  readonly key: K;
  readonly kind: 'array' | 'object';
}

/**
 * The config keys of provider `K`, minus the discriminant the form owns.
 *
 * Written as a conditional type so it distributes over the union in the default
 * `K = ProviderId`: `keyof (A | B)` is only the keys both share, which would
 * collapse every provider's fields to `never`.
 */
type ConfigKey<K extends ProviderId> = K extends ProviderId
  ? Extract<Exclude<keyof ProviderConfigMap[K], 'provider'>, string>
  : never;

/** Everything the panel needs to know about one provider. */
export interface ProviderSchema {
  readonly id: ProviderId;
  readonly labelKey: MessageKey;
  /** One line under the provider picker, saying what this provider is. */
  readonly summaryKey: MessageKey;
  /** Where the user creates credentials, when the provider has such a page. */
  readonly consoleUrl?: string;
  readonly fields: readonly FieldSpec[];
  readonly passthrough?: readonly PassthroughSpec[];
}

/**
 * The same shape, with every key tied to provider `K`'s own config keys.
 *
 * Private, and separate from `ProviderSchema` on purpose: a key that goes
 * through the conditional `ConfigKey` makes the generic invariant to the
 * compiler, so a `SchemaSpec<'browser'>` would not be accepted where the union
 * is wanted. The table below is checked against this stricter shape, and what
 * the panel consumes is the plain one.
 */
interface SchemaSpec<K extends ProviderId> {
  readonly id: K;
  readonly labelKey: MessageKey;
  readonly summaryKey: MessageKey;
  readonly consoleUrl?: string;
  readonly fields: readonly FieldSpec<ConfigKey<K>>[];
  readonly passthrough?: readonly PassthroughSpec<ConfigKey<K>>[];
}

/**
 * The endpoint each of these adapters falls back to.
 *
 * Duplicated rather than imported on purpose: this module is bundled into the
 * service worker, and importing an adapter would drag its wire format into
 * that bundle. A unit test compares each entry with the adapter's own exported
 * `DEFAULT_BASE_URL`, so the two copies cannot drift apart unnoticed.
 */
const DEFAULT_BASE_URLS = {
  dashscope: 'https://dashscope.aliyuncs.com',
  volcengine: 'https://openspeech.bytedance.com',
  elevenlabs: 'https://api.elevenlabs.io',
} as const;

/**
 * The schema table.
 *
 * Key order is the picker's display order, so the browser voice comes first:
 * it is the only option that needs nothing filled in.
 */
const SCHEMAS = {
  browser: {
    id: 'browser',
    labelKey: 'provider.browser.label',
    summaryKey: 'provider.browser.summary',
    fields: [],
  },

  dashscope: {
    id: 'dashscope',
    labelKey: 'provider.dashscope.label',
    summaryKey: 'provider.dashscope.summary',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    fields: [
      {
        key: 'apiKey',
        labelKey: 'field.api-key',
        kind: 'password',
        required: true,
        placeholder: 'sk-…',
      },
      {
        key: 'workspaceId',
        labelKey: 'field.workspace-id',
        kind: 'text',
        helpKey: 'provider.dashscope.workspace-id.help',
      },
      {
        key: 'region',
        labelKey: 'field.region',
        kind: 'select',
        // The spec's two regions (spec §2.2, line 126). `ap-southeast-1` is the
        // international site, whose host is `dashscope-intl.aliyuncs.com`.
        options: [
          { value: 'cn-beijing', labelKey: 'provider.dashscope.region.option.cn-beijing' },
          {
            value: 'ap-southeast-1',
            labelKey: 'provider.dashscope.region.option.ap-southeast-1',
          },
        ],
        helpKey: 'provider.dashscope.region.help',
      },
      {
        key: 'model',
        labelKey: 'field.model',
        kind: 'text',
        placeholder: 'cosyvoice-v3-flash',
        helpKey: 'provider.dashscope.model.help',
      },
      {
        key: 'baseUrl',
        labelKey: 'field.base-url',
        kind: 'url',
        defaultValue: DEFAULT_BASE_URLS.dashscope,
        placeholder: DEFAULT_BASE_URLS.dashscope,
        helpKey: 'provider.dashscope.base-url.help',
      },
    ],
  },

  volcengine: {
    id: 'volcengine',
    labelKey: 'provider.volcengine.label',
    summaryKey: 'provider.volcengine.summary',
    consoleUrl: 'https://console.volcengine.com/speech/',
    fields: [
      {
        key: 'apiKey',
        labelKey: 'field.api-key',
        kind: 'password',
        required: true,
        helpKey: 'provider.volcengine.api-key.help',
      },
      {
        key: 'resourceId',
        labelKey: 'field.resource-id',
        kind: 'select',
        required: true,
        options: [
          {
            value: 'seed-tts-1.0',
            labelKey: 'provider.volcengine.resource-id.option.seed-tts-1.0',
          },
          {
            value: 'seed-tts-2.0',
            labelKey: 'provider.volcengine.resource-id.option.seed-tts-2.0',
          },
        ],
        // 声音复刻 speaks only cloned voices, which the picker cannot enter.
        retiredOptions: { 'seed-icl-2.0': 'seed-tts-1.0' },
        helpKey: 'provider.volcengine.resource-id.help',
      },
      {
        key: 'baseUrl',
        labelKey: 'field.base-url',
        kind: 'url',
        defaultValue: DEFAULT_BASE_URLS.volcengine,
        placeholder: DEFAULT_BASE_URLS.volcengine,
        helpKey: 'provider.volcengine.base-url.help',
      },
    ],
  },

  'openai-compat': {
    id: 'openai-compat',
    labelKey: 'provider.openai-compat.label',
    summaryKey: 'provider.openai-compat.summary',
    fields: [
      {
        key: 'baseUrl',
        labelKey: 'field.base-url',
        kind: 'url',
        required: true,
        placeholder: 'http://localhost:8880/v1',
      },
      {
        key: 'apiKey',
        labelKey: 'field.api-key',
        kind: 'password',
        helpKey: 'provider.openai-compat.api-key.help',
      },
      { key: 'model', labelKey: 'field.model', kind: 'text', placeholder: 'kokoro' },
      {
        key: 'captionedSpeech',
        labelKey: 'field.captioned-speech',
        kind: 'boolean',
        helpKey: 'provider.openai-compat.captioned-speech.help',
      },
      {
        key: 'headers',
        labelKey: 'field.extra-headers',
        kind: 'kv',
        placeholder: 'X-Gateway-Key: …',
        helpKey: 'provider.openai-compat.extra-headers.help',
      },
    ],
    passthrough: [{ key: 'voices', kind: 'array' }],
  },

  elevenlabs: {
    id: 'elevenlabs',
    labelKey: 'provider.elevenlabs.label',
    summaryKey: 'provider.elevenlabs.summary',
    consoleUrl: 'https://elevenlabs.io/app/settings/api-keys',
    fields: [
      { key: 'apiKey', labelKey: 'field.api-key', kind: 'password', required: true },
      {
        key: 'model',
        labelKey: 'field.model',
        kind: 'text',
        placeholder: 'eleven_multilingual_v2',
      },
      {
        key: 'outputFormat',
        labelKey: 'field.output-format',
        kind: 'text',
        placeholder: 'mp3_44100_128',
      },
      {
        key: 'baseUrl',
        labelKey: 'field.base-url',
        kind: 'url',
        defaultValue: DEFAULT_BASE_URLS.elevenlabs,
        placeholder: DEFAULT_BASE_URLS.elevenlabs,
      },
    ],
    passthrough: [{ key: 'voiceSettings', kind: 'object' }],
  },

  azure: {
    id: 'azure',
    labelKey: 'provider.azure.label',
    summaryKey: 'provider.azure.summary',
    consoleUrl: 'https://portal.azure.com/',
    fields: [
      {
        key: 'subscriptionKey',
        labelKey: 'field.subscription-key',
        kind: 'password',
        required: true,
      },
      {
        key: 'region',
        labelKey: 'field.region',
        kind: 'text',
        required: true,
        placeholder: 'eastasia',
        helpKey: 'provider.azure.region.help',
      },
      {
        key: 'outputFormat',
        labelKey: 'field.output-format',
        kind: 'select',
        options: [
          {
            value: 'mp3_24khz_48k',
            labelKey: 'provider.azure.output-format.option.mp3_24khz_48k',
          },
          {
            value: 'mp3_16khz_32k',
            labelKey: 'provider.azure.output-format.option.mp3_16khz_32k',
          },
          {
            value: 'wav_24khz_16bit',
            labelKey: 'provider.azure.output-format.option.wav_24khz_16bit',
          },
          {
            value: 'ogg_16khz_opus',
            labelKey: 'provider.azure.output-format.option.ogg_16khz_opus',
          },
        ],
      },
      {
        key: 'lang',
        labelKey: 'field.language-hint',
        kind: 'text',
        placeholder: 'zh-CN',
        helpKey: 'provider.azure.language-hint.help',
      },
    ],
  },

  // Last, so it reads as the alternative to the services above rather than as
  // another one of them.
  //
  // No fields yet, and deliberately so: the model, tier and device pickers live
  // in the Models tab, where they can show download state, and repeating them
  // as a generic form here would give the same setting two places to be wrong.
  // The row exists so the provider can be selected and so its label and summary
  // come from the same table as every other provider's.
  local: {
    id: 'local',
    labelKey: 'provider.local.label',
    summaryKey: 'provider.local.summary',
    fields: [],
  },
} satisfies { [K in ProviderId]: SchemaSpec<K> };

/** Every provider, in picker order. */
export const PROVIDER_SCHEMAS: { [K in ProviderId]: ProviderSchema } = SCHEMAS;

/**
 * Display order for the provider picker.
 *
 * Taken from the table's own key order so the two cannot drift apart: a
 * provider added above appears in the picker without a second edit.
 */
export const PROVIDER_IDS = Object.keys(SCHEMAS) as ProviderId[];

/** A value the form holds: every field is a string except the checkboxes. */
export type FormValue = string | boolean;
export type FormValues = Record<string, FormValue>;

/**
 * Why a field was rejected.
 *
 * A code rather than a sentence: this module is bundled into the service worker
 * and read by the adapters, and neither has a language. The panel turns the code
 * and its parameters into words.
 */
export type FieldErrorCode =
  | 'required'
  | 'invalid-url'
  | 'invalid-select'
  | 'invalid-header-line'
  | 'invalid-header-name';

export interface FieldError {
  readonly code: FieldErrorCode;
  /** Values for the message's placeholders, such as the header line number. */
  readonly params?: Readonly<Record<string, string>>;
}

/** Field key to what is wrong with it. */
export type FieldErrors = Record<string, FieldError>;

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True for an absolute http(s) URL, the only thing a `url` field may hold. */
export function isHttpUrl(text: string): boolean {
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Render a header map as the `Name: Value` lines the textarea shows. */
function formatHeaders(value: unknown): string {
  if (!isPlainObject(value)) return '';
  return Object.entries(value)
    .map(([name, header]) => `${name}: ${String(header)}`)
    .join('\n');
}

export interface HeaderParse {
  headers: Record<string, string>;
  /** One entry per line that is not a `Name: Value` pair, naming the line. */
  errors: FieldError[];
}

/**
 * RFC 9110 `token`: the only thing an HTTP header name may be made of.
 *
 * Checked because the alternative is a typo silently becoming a header the
 * server ignores — `# a note` is not a name, and neither is `X-Key ` with a
 * trailing space.
 */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Parse the header textarea.
 *
 * Blank lines are skipped, and everything else has to be a `Name: Value` pair.
 * There is deliberately no comment syntax: a line that looks like a note would
 * either be dropped without a word or sent as a bogus header, and a settings
 * box that quietly discards what was typed into it is worse than one that
 * complains.
 */
export function parseHeaderLines(text: string): HeaderParse {
  const headers: Record<string, string> = {};
  const errors: FieldError[] = [];

  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;

    const separator = line.indexOf(':');
    const name = separator === -1 ? '' : line.slice(0, separator).trim();
    if (name === '') {
      errors.push({ code: 'invalid-header-line', params: { line: String(index + 1) } });
      return;
    }
    if (!HEADER_NAME.test(name)) {
      errors.push({
        code: 'invalid-header-name',
        params: { line: String(index + 1), name },
      });
      return;
    }

    headers[name] = line.slice(separator + 1).trim();
  });

  return { headers, errors };
}

/**
 * Seed the form from a saved config.
 *
 * A config for another provider is ignored rather than half-applied: the form
 * only ever shows one provider's fields.
 */
export function configToFormValues(
  schema: ProviderSchema,
  config?: ProviderConfig | null
): FormValues {
  const source =
    config?.provider === schema.id ? (config as unknown as Record<string, unknown>) : undefined;

  const values: FormValues = {};
  for (const field of schema.fields) {
    const stored = source?.[field.key];
    if (field.kind === 'boolean') {
      values[field.key] = stored === true;
      continue;
    }

    const rendered =
      field.kind === 'kv' ? formatHeaders(stored) : typeof stored === 'string' ? stored : '';
    // A field with nothing stored shows its default, so the form presents the
    // endpoint the adapter would fall back to anyway. An empty string counts
    // as nothing stored: `parseStoredConfig` never keeps one.
    values[field.key] = rendered !== '' ? rendered : (field.defaultValue ?? '');
  }
  return values;
}

/** Everything wrong with the form as it stands, for inline display. */
export function validateFormValues(schema: ProviderSchema, values: FormValues): FieldErrors {
  const errors: FieldErrors = {};

  for (const field of schema.fields) {
    if (field.kind === 'boolean') continue;

    const raw = values[field.key];
    const typed = typeof raw === 'string' ? raw.trim() : '';
    // An empty field holds its default, so that is the value checked here —
    // which is also what makes a `required` field with a default satisfied.
    const text = typed === '' ? (field.defaultValue ?? '') : typed;

    if (text === '') {
      if (field.required) errors[field.key] = { code: 'required' };
      continue;
    }

    if (field.kind === 'url' && !isHttpUrl(text)) {
      errors[field.key] = { code: 'invalid-url' };
    } else if (field.kind === 'select' && !field.options?.some((o) => o.value === text)) {
      errors[field.key] = { code: 'invalid-select' };
    } else if (field.kind === 'kv') {
      const { errors: lineErrors } = parseHeaderLines(text);
      const first = lineErrors[0];
      // One complaint at a time: the panel shows a single line under the field.
      if (first) errors[field.key] = first;
    }
  }

  return errors;
}

/**
 * Turn form values into a config.
 *
 * Only valid to call once `validateFormValues` came back empty: an invalid
 * select or a malformed header line would otherwise reach the adapter. Empty
 * optional fields are omitted rather than written as `''`, so an adapter's own
 * default still applies.
 */
export function formValuesToConfig(
  schema: ProviderSchema,
  values: FormValues,
  previous?: ProviderConfig | null
): ProviderConfig {
  const config: Record<string, unknown> = { provider: schema.id };

  for (const field of schema.fields) {
    const raw = values[field.key];

    if (field.kind === 'boolean') {
      config[field.key] = raw === true;
      continue;
    }

    const text = typeof raw === 'string' ? raw.trim() : '';
    if (text === '') continue;

    if (field.kind === 'kv') {
      const { headers } = parseHeaderLines(text);
      if (Object.keys(headers).length > 0) config[field.key] = headers;
      continue;
    }

    config[field.key] = text;
  }

  // Carry over the keys the form does not render, so editing a field cannot
  // silently delete the voice list or the voice settings that came with them.
  if (previous?.provider === schema.id) {
    const source = previous as unknown as Record<string, unknown>;
    for (const spec of schema.passthrough ?? []) {
      if (source[spec.key] !== undefined) config[spec.key] = source[spec.key];
    }
  }

  return config as unknown as ProviderConfig;
}

/** Check one stored value against its field, or reject it. */
function coerceStored(field: FieldSpec, raw: unknown): unknown {
  switch (field.kind) {
    case 'boolean':
      return typeof raw === 'boolean' ? raw : undefined;

    case 'select':
      if (typeof raw !== 'string') return undefined;
      if (field.options?.some((option) => option.value === raw)) return raw;
      // An option that has since been retired maps to its replacement, so the
      // rest of the saved config (the key above all) survives it. Anything
      // else is still rejected.
      return field.retiredOptions?.[raw];

    case 'kv':
      if (!isPlainObject(raw)) return undefined;
      return Object.values(raw).every((value) => typeof value === 'string') ? raw : undefined;

    default:
      // An empty string is "not set", not a value worth keeping.
      return typeof raw === 'string' && raw !== '' ? raw : undefined;
  }
}

/** Check one passthrough value: only its outer shape is ours to judge. */
function coercePassthrough(spec: PassthroughSpec, raw: unknown): unknown {
  if (spec.kind === 'array') return Array.isArray(raw) ? raw : undefined;
  return isPlainObject(raw) ? raw : undefined;
}

/**
 * Validate a config read back from storage.
 *
 * `null` means "not configured": a config missing a required field is unusable,
 * so reporting it as absent is better than handing a half-built config to an
 * adapter. A single corrupt optional field, on the other hand, is dropped and
 * the rest is kept — one bad character in a model name should not cost the user
 * their API key.
 */
export function parseStoredConfig(value: unknown): ProviderConfig | null {
  if (!isPlainObject(value)) return null;

  const id = value.provider;
  if (typeof id !== 'string' || !Object.hasOwn(SCHEMAS, id)) return null;

  const schema = SCHEMAS[id as ProviderId] as ProviderSchema;
  const config: Record<string, unknown> = { provider: schema.id };

  for (const field of schema.fields) {
    const raw = value[field.key];
    if (raw === undefined) {
      if (field.required) return null;
      continue;
    }

    const coerced = coerceStored(field, raw);
    if (coerced === undefined) {
      if (field.required) return null;
      continue;
    }
    config[field.key] = coerced;
  }

  for (const spec of schema.passthrough ?? []) {
    const coerced = coercePassthrough(spec, value[spec.key]);
    if (coerced !== undefined) config[spec.key] = coerced;
  }

  return config as unknown as ProviderConfig;
}
