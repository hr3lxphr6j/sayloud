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
 */
import type { ProviderConfig, ProviderConfigMap, ProviderId } from './types';

/** How a field is edited, which decides both the widget and the validation. */
export type FieldKind = 'text' | 'password' | 'url' | 'select' | 'boolean' | 'kv';

export interface FieldOption {
  readonly value: string;
  readonly label: string;
}

/** One editable config key. */
export interface FieldSpec<K extends string = string> {
  readonly key: K;
  readonly label: string;
  readonly kind: FieldKind;
  /** Blocks saving while the field is empty. */
  readonly required?: boolean;
  readonly placeholder?: string;
  readonly help?: string;
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
  readonly label: string;
  /** One line under the provider picker, saying what this provider is. */
  readonly summary: string;
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
  readonly label: string;
  readonly summary: string;
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
    label: 'Browser voice',
    summary: 'Uses the voices Chrome already has installed. Nothing to configure.',
    fields: [],
  },

  dashscope: {
    id: 'dashscope',
    label: 'DashScope (阿里云百炼)',
    summary: 'Alibaba Cloud Model Studio. CosyVoice v3 and later report word timings.',
    consoleUrl: 'https://bailian.console.aliyun.com/',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'password',
        required: true,
        placeholder: 'sk-…',
      },
      {
        key: 'workspaceId',
        label: 'Workspace id',
        kind: 'text',
        help: 'Only for keys scoped to a business space. Leave empty otherwise.',
      },
      {
        key: 'region',
        label: 'Region',
        kind: 'select',
        // The spec's two regions (spec §2.2, line 126). `ap-southeast-1` is the
        // international site, whose host is `dashscope-intl.aliyuncs.com`.
        options: [
          { value: 'cn-beijing', label: 'China (cn-beijing)' },
          { value: 'ap-southeast-1', label: 'Singapore (ap-southeast-1)' },
        ],
        help: 'CosyVoice and Qwen-Audio-TTS are only served from cn-beijing; the Singapore region serves the Qwen-TTS models.',
      },
      {
        key: 'model',
        label: 'Model',
        kind: 'text',
        placeholder: 'cosyvoice-v3-flash',
        help: 'Word timings need a cosyvoice-v3 or later model; the adapter then sends word_timestamp_enabled automatically.',
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'url',
        defaultValue: DEFAULT_BASE_URLS.dashscope,
        placeholder: DEFAULT_BASE_URLS.dashscope,
        help: 'Override the region host, for example to go through a proxy.',
      },
    ],
  },

  volcengine: {
    id: 'volcengine',
    label: '火山引擎豆包 TTS',
    summary: 'Volcano Engine Doubao. The seed-tts-1.0 resource reports word timings.',
    consoleUrl: 'https://console.volcengine.com/speech/',
    fields: [
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'password',
        required: true,
        help: 'From the new console, sent as the X-Api-Key header. The old console app id + access token pair is not supported.',
      },
      {
        key: 'resourceId',
        label: 'Resource id',
        kind: 'select',
        required: true,
        options: [
          { value: 'seed-tts-1.0', label: 'seed-tts-1.0 (word timings)' },
          { value: 'seed-tts-2.0', label: 'seed-tts-2.0 (sentence-level only)' },
          { value: 'seed-icl-2.0', label: 'seed-icl-2.0 (sentence-level only)' },
        ],
        help: 'The resource id decides both the model version and the billing mode.',
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'url',
        defaultValue: DEFAULT_BASE_URLS.volcengine,
        placeholder: DEFAULT_BASE_URLS.volcengine,
        help: 'Host only, without /api/v3/… — for example to go through a proxy.',
      },
    ],
  },

  'openai-compat': {
    id: 'openai-compat',
    label: 'OpenAI-compatible',
    summary: 'Any /v1/audio/speech endpoint, including a local Kokoro-FastAPI server.',
    fields: [
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'url',
        required: true,
        placeholder: 'http://localhost:8880/v1',
      },
      {
        key: 'apiKey',
        label: 'API key',
        kind: 'password',
        help: 'Leave empty for a local server that needs no auth.',
      },
      { key: 'model', label: 'Model', kind: 'text', placeholder: 'kokoro' },
      {
        key: 'captionedSpeech',
        label: 'Use /dev/captioned_speech',
        kind: 'boolean',
        help: 'Kokoro-FastAPI only. Returns word timings; the standard endpoint does not.',
      },
      {
        key: 'headers',
        label: 'Extra headers',
        kind: 'kv',
        placeholder: 'X-Gateway-Key: …',
        help: 'One Name: Value pair per line, for a self-hosted gateway.',
      },
    ],
    passthrough: [{ key: 'voices', kind: 'array' }],
  },

  elevenlabs: {
    id: 'elevenlabs',
    label: 'ElevenLabs',
    summary: 'Word timings come from the with-timestamps endpoint.',
    consoleUrl: 'https://elevenlabs.io/app/settings/api-keys',
    fields: [
      { key: 'apiKey', label: 'API key', kind: 'password', required: true },
      {
        key: 'model',
        label: 'Model',
        kind: 'text',
        placeholder: 'eleven_multilingual_v2',
      },
      {
        key: 'outputFormat',
        label: 'Output format',
        kind: 'text',
        placeholder: 'mp3_44100_128',
      },
      {
        key: 'baseUrl',
        label: 'Base URL',
        kind: 'url',
        defaultValue: DEFAULT_BASE_URLS.elevenlabs,
        placeholder: DEFAULT_BASE_URLS.elevenlabs,
      },
    ],
    passthrough: [{ key: 'voiceSettings', kind: 'object' }],
  },

  azure: {
    id: 'azure',
    label: 'Azure Speech',
    summary: 'Azure AI Speech over the Speech SDK WebSocket.',
    consoleUrl: 'https://portal.azure.com/',
    fields: [
      {
        key: 'subscriptionKey',
        label: 'Subscription key',
        kind: 'password',
        required: true,
      },
      {
        key: 'region',
        label: 'Region',
        kind: 'text',
        required: true,
        placeholder: 'eastasia',
        help: 'The region slug of the Speech resource, not its display name.',
      },
      {
        key: 'outputFormat',
        label: 'Output format',
        kind: 'select',
        options: [
          { value: 'mp3_24khz_48k', label: 'MP3 24 kHz 48 kbit/s (default)' },
          { value: 'mp3_16khz_32k', label: 'MP3 16 kHz 32 kbit/s' },
          { value: 'wav_24khz_16bit', label: 'WAV 24 kHz 16-bit' },
          { value: 'ogg_16khz_opus', label: 'OGG 16 kHz Opus' },
        ],
      },
      {
        key: 'lang',
        label: 'Language hint',
        kind: 'text',
        placeholder: 'zh-CN',
        help: 'Used to list voices when the voice id does not imply a language.',
      },
    ],
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

/** Field key to the message shown under it. */
export type FieldErrors = Record<string, string>;

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
  /** One message per line that is not a `Name: Value` pair, naming the line. */
  errors: string[];
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
  const errors: string[] = [];

  text.split('\n').forEach((raw, index) => {
    const line = raw.trim();
    if (line === '') return;

    const separator = line.indexOf(':');
    const name = separator === -1 ? '' : line.slice(0, separator).trim();
    if (name === '') {
      errors.push(`Line ${index + 1}: expected a "Name: Value" pair.`);
      return;
    }
    if (!HEADER_NAME.test(name)) {
      errors.push(`Line ${index + 1}: "${name}" is not a valid header name.`);
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
      if (field.required) errors[field.key] = `${field.label} is required.`;
      continue;
    }

    if (field.kind === 'url' && !isHttpUrl(text)) {
      errors[field.key] = 'Enter a full URL, for example http://localhost:8880/v1.';
    } else if (field.kind === 'select' && !field.options?.some((o) => o.value === text)) {
      errors[field.key] = 'Choose one of the listed options.';
    } else if (field.kind === 'kv') {
      const { errors: lineErrors } = parseHeaderLines(text);
      if (lineErrors.length > 0) errors[field.key] = lineErrors[0] as string;
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
      return field.options?.some((option) => option.value === raw) ? raw : undefined;

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
