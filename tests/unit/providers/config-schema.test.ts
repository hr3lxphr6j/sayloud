import { describe, expect, it } from 'vitest';
import { en, type MessageKey } from '~/lib/i18n/messages.en';
import { MODELS } from '~/lib/models/registry';
import {
  configToFormValues,
  type FormValues,
  formValuesToConfig,
  isHttpUrl,
  PROVIDER_IDS,
  PROVIDER_SCHEMAS,
  type ProviderSchema,
  parseHeaderLines,
  parseStoredConfig,
  validateFormValues,
} from '~/lib/providers/config-schema';
import { DEFAULT_BASE_URL as DASHSCOPE_BASE_URL } from '~/lib/providers/dashscope';
import { DEFAULT_BASE_URL as ELEVENLABS_BASE_URL } from '~/lib/providers/elevenlabs';
import type { ProviderConfig } from '~/lib/providers/types';
import { DEFAULT_BASE_URL as VOLCENGINE_BASE_URL } from '~/lib/providers/volcengine';

const dashscope = PROVIDER_SCHEMAS.dashscope;
const volcengine = PROVIDER_SCHEMAS.volcengine;
const openai = PROVIDER_SCHEMAS['openai-compat'];

/**
 * A label or help line, in English.
 *
 * The schema holds keys, so an assertion about the wording has to go through
 * the catalogue. English is the reference language for these: they describe
 * what a provider's console asks for, which no translation can change.
 */
function text(key: MessageKey | undefined): string {
  return key === undefined ? '' : en[key];
}

/** Form values with every field filled with something the field accepts. */
function filledValues(schema: ProviderSchema): FormValues {
  const values = configToFormValues(schema);

  for (const field of schema.fields) {
    if (field.kind === 'boolean') continue;
    if (field.kind === 'select') values[field.key] = field.options?.[0]?.value ?? '';
    else if (field.kind === 'url') values[field.key] = 'https://example.test/v1';
    else if (field.kind === 'kv') values[field.key] = 'X-Key: value';
    else values[field.key] = `${field.key}-value`;
  }

  return values;
}

describe('PROVIDER_SCHEMAS', () => {
  it('lists every provider exactly once', () => {
    expect([...PROVIDER_IDS].sort()).toEqual(Object.keys(PROVIDER_SCHEMAS).sort());
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
  });

  it('never declares a field for the discriminant or twice for the same key', () => {
    for (const id of PROVIDER_IDS) {
      const keys = PROVIDER_SCHEMAS[id].fields.map((field) => field.key);
      expect(keys).not.toContain('provider');
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('gives every select real options', () => {
    for (const id of PROVIDER_IDS) {
      for (const field of PROVIDER_SCHEMAS[id].fields) {
        if (field.kind !== 'select') continue;
        expect(field.options?.length ?? 0).toBeGreaterThan(0);
      }
    }
  });

  it('puts the browser voice first, since it needs nothing filled in', () => {
    expect(PROVIDER_IDS[0]).toBe('browser');
    expect(PROVIDER_SCHEMAS.browser.fields).toHaveLength(0);
  });

  it('exposes exactly the fields the verified Volcengine contract uses', () => {
    // The old console's appId / access token and a separate model field are
    // deliberately absent: only the new console's X-Api-Key is supported, and
    // the resource id decides the model version.
    expect(volcengine.fields.map((field) => field.key)).toEqual([
      'apiKey',
      'resourceId',
      'baseUrl',
    ]);
  });

  it('requires the Volcengine API key and names the header it is sent as', () => {
    const apiKey = volcengine.fields.find((field) => field.key === 'apiKey');

    expect(apiKey).toMatchObject({ kind: 'password', required: true });
    expect(text(apiKey?.helpKey)).toMatch(/X-Api-Key/);
    expect(text(apiKey?.helpKey)).toMatch(/new console/);
  });

  it('offers the Volcengine resource ids as a required select', () => {
    const resourceId = volcengine.fields.find((field) => field.key === 'resourceId');

    expect(resourceId).toMatchObject({ kind: 'select', required: true });
    expect(resourceId?.options?.map((option) => option.value)).toEqual([
      'seed-tts-1.0',
      'seed-tts-2.0',
    ]);
    // Only the 1.0 resource reports word timings.
    expect(text(resourceId?.options?.[0]?.labelKey)).toMatch(/word timings/);
  });

  it('offers the spec regions for DashScope, with the Beijing-only caveat', () => {
    // The region is cn-beijing / ap-southeast-1, and the
    // CosyVoice HTTP API is only open in Beijing.
    const region = dashscope.fields.find((field) => field.key === 'region');

    expect(region?.kind).toBe('select');
    expect(region?.options?.map((option) => option.value)).toEqual([
      'cn-beijing',
      'ap-southeast-1',
    ]);
    expect(text(region?.helpKey)).toMatch(/cn-beijing/);
  });

  it('names a model V4 exercised and says how word timings are enabled', () => {
    // cosyvoice-v3-flash was measured with word_timestamp_enabled; the flag is
    // sent by the adapter, not typed by the user.
    const model = dashscope.fields.find((field) => field.key === 'model');

    expect(model?.placeholder).toBe('cosyvoice-v3-flash');
    expect(text(model?.helpKey)).toMatch(/cosyvoice-v3/);
    expect(text(model?.helpKey)).toMatch(/word_timestamp_enabled/);
  });

  it('keeps every base URL default equal to its adapter constant', () => {
    // The schema cannot import the adapters — it is bundled into the service
    // worker — so the two copies of each host are compared here instead.
    const cases = [
      [PROVIDER_SCHEMAS.dashscope, DASHSCOPE_BASE_URL],
      [volcengine, VOLCENGINE_BASE_URL],
      [PROVIDER_SCHEMAS.elevenlabs, ELEVENLABS_BASE_URL],
    ] as const;

    for (const [schema, url] of cases) {
      const field = schema.fields.find((entry) => entry.key === 'baseUrl');
      expect(field?.defaultValue).toBe(url);
      // Clearing the field must still show which host an empty value means.
      expect(field?.placeholder).toBe(url);
    }
  });
});

describe('defaultValue', () => {
  it('shows the field default when nothing is stored', () => {
    const values = configToFormValues(volcengine);

    expect(values.baseUrl).toBe(VOLCENGINE_BASE_URL);
    // A field with no default still starts empty.
    expect(values.apiKey).toBe('');
  });

  it('prefers a stored value over the default', () => {
    const values = configToFormValues(volcengine, {
      provider: 'volcengine',
      apiKey: 'k',
      resourceId: 'seed-tts-1.0',
      baseUrl: 'https://proxy.test',
    });

    expect(values.baseUrl).toBe('https://proxy.test');
  });

  it('validates a field holding its default, and one left empty', () => {
    const schema: ProviderSchema = {
      id: 'dashscope',
      labelKey: 'provider.dashscope.label',
      summaryKey: 'provider.dashscope.summary',
      fields: [
        {
          key: 'apiKey',
          labelKey: 'field.api-key',
          kind: 'text',
          required: true,
          defaultValue: 'sk-default',
        },
      ],
    };

    // Empty falls back to the default, so the requirement is satisfied by it.
    expect(validateFormValues(schema, { apiKey: 'sk-default' })).toEqual({});
    expect(validateFormValues(schema, { apiKey: '' })).toEqual({});
  });

  it('still requires a field that has no default', () => {
    expect(validateFormValues(volcengine, { baseUrl: VOLCENGINE_BASE_URL }).resourceId).toEqual({
      code: 'required',
    });
  });

  it('checks the default the way it checks a typed value', () => {
    const schema: ProviderSchema = {
      id: 'dashscope',
      labelKey: 'provider.dashscope.label',
      summaryKey: 'provider.dashscope.summary',
      fields: [
        { key: 'baseUrl', labelKey: 'field.base-url', kind: 'url', defaultValue: 'not-a-url' },
      ],
    };

    expect(validateFormValues(schema, {})).toHaveProperty('baseUrl');
  });
});

describe('isHttpUrl', () => {
  it('accepts absolute http and https URLs', () => {
    expect(isHttpUrl('http://localhost:8880/v1')).toBe(true);
    expect(isHttpUrl('https://api.example.com/v1')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isHttpUrl('example.com/v1')).toBe(false);
    expect(isHttpUrl('ftp://example.com')).toBe(false);
    expect(isHttpUrl('/v1/audio')).toBe(false);
    expect(isHttpUrl('')).toBe(false);
  });
});

describe('parseHeaderLines', () => {
  it('reads one Name: Value pair per line', () => {
    expect(parseHeaderLines('X-Key: abc\nX-Other:def').headers).toEqual({
      'X-Key': 'abc',
      'X-Other': 'def',
    });
  });

  it('keeps colons that belong to the value', () => {
    expect(parseHeaderLines('X-Url: https://example.test/a').headers).toEqual({
      'X-Url': 'https://example.test/a',
    });
  });

  it('skips blank lines', () => {
    const parsed = parseHeaderLines('\nX-Key: abc\n\n');

    expect(parsed.headers).toEqual({ 'X-Key': 'abc' });
    expect(parsed.errors).toEqual([]);
  });

  it('reports a line that is not a pair, rather than dropping it', () => {
    // A note is not a header, and quietly discarding it would be worse than
    // saying so: the user would think it had been kept.
    const parsed = parseHeaderLines('# a note\nX-Key: abc');

    expect(parsed.headers).toEqual({ 'X-Key': 'abc' });
    expect(parsed.errors).toEqual([{ code: 'invalid-header-line', params: { line: '1' } }]);
  });

  it('rejects a name that is not a header token', () => {
    const parsed = parseHeaderLines('# note: abc');

    expect(parsed.headers).toEqual({});
    expect(parsed.errors).toEqual([
      { code: 'invalid-header-name', params: { line: '1', name: '# note' } },
    ]);
  });

  it('rejects a name with a space in it', () => {
    expect(parseHeaderLines('X Key: abc').errors).toHaveLength(1);
  });

  it('names the offending line when a pair is malformed', () => {
    const parsed = parseHeaderLines('X-Key: abc\nnot a header\nX-More: d');

    expect(parsed.headers).toEqual({ 'X-Key': 'abc', 'X-More': 'd' });
    expect(parsed.errors).toEqual([{ code: 'invalid-header-line', params: { line: '2' } }]);
  });

  it('rejects a line whose name is only whitespace', () => {
    expect(parseHeaderLines('   : abc').errors).toHaveLength(1);
  });
});

describe('validateFormValues', () => {
  it('accepts a form with every field filled', () => {
    for (const id of PROVIDER_IDS) {
      expect(validateFormValues(PROVIDER_SCHEMAS[id], filledValues(PROVIDER_SCHEMAS[id]))).toEqual(
        {}
      );
    }
  });

  it('requires the fields marked required', () => {
    const errors = validateFormValues(dashscope, { apiKey: '   ' });

    expect(errors.apiKey).toEqual({ code: 'required' });
  });

  it('does not require an optional field', () => {
    expect(validateFormValues(dashscope, { apiKey: 'sk-1' })).toEqual({});
  });

  it('rejects a URL without a scheme', () => {
    const errors = validateFormValues(openai, { baseUrl: 'localhost:8880' });

    expect(errors.baseUrl).toEqual({ code: 'invalid-url' });
  });

  it('rejects a select value outside its options', () => {
    const errors = validateFormValues(dashscope, { apiKey: 'sk-1', region: 'mars' });

    expect(errors.region).toEqual({ code: 'invalid-select' });
  });

  it('accepts a select value that is one of the options', () => {
    expect(validateFormValues(dashscope, { apiKey: 'sk-1', region: 'ap-southeast-1' })).toEqual({});
  });

  it('reports the first malformed header line', () => {
    const errors = validateFormValues(openai, { baseUrl: 'https://a.test/v1', headers: 'oops' });

    expect(errors.headers).toEqual({ code: 'invalid-header-line', params: { line: '1' } });
  });

  it('ignores booleans, which are never empty', () => {
    expect(
      validateFormValues(openai, { baseUrl: 'https://a.test/v1', captionedSpeech: false })
    ).toEqual({});
  });
});

describe('configToFormValues', () => {
  it('seeds the fields from a saved config', () => {
    const values = configToFormValues(dashscope, {
      provider: 'dashscope',
      apiKey: 'sk-1',
      region: 'ap-southeast-1',
    });

    expect(values.apiKey).toBe('sk-1');
    expect(values.region).toBe('ap-southeast-1');
    expect(values.model).toBe('');
  });

  it('renders a header map as editable lines', () => {
    const values = configToFormValues(openai, {
      provider: 'openai-compat',
      baseUrl: 'https://a.test/v1',
      headers: { 'X-Key': 'abc' },
    });

    expect(values.headers).toBe('X-Key: abc');
  });

  it('reads a checkbox as a boolean', () => {
    expect(
      configToFormValues(openai, {
        provider: 'openai-compat',
        baseUrl: 'https://a.test/v1',
        captionedSpeech: true,
      }).captionedSpeech
    ).toBe(true);
  });

  it('ignores a config that belongs to another provider', () => {
    const values = configToFormValues(dashscope, {
      provider: 'elevenlabs',
      apiKey: 'sk-1',
    } as ProviderConfig);

    expect(values.apiKey).toBe('');
  });
});

describe('formValuesToConfig', () => {
  it('trims values and drops the empty optional ones', () => {
    const config = formValuesToConfig(dashscope, { apiKey: '  sk-1  ', model: '   ' });

    expect(config).toEqual({ provider: 'dashscope', apiKey: 'sk-1' });
  });

  it('writes a checkbox even when it is off', () => {
    const config = formValuesToConfig(openai, {
      baseUrl: 'https://a.test/v1',
      captionedSpeech: false,
    });

    expect(config).toEqual({
      provider: 'openai-compat',
      baseUrl: 'https://a.test/v1',
      captionedSpeech: false,
    });
  });

  it('turns header lines into a map, and omits it when there are none', () => {
    expect(
      formValuesToConfig(openai, { baseUrl: 'https://a.test/v1', headers: 'X-Key: abc' })
    ).toMatchObject({ headers: { 'X-Key': 'abc' } });

    expect(
      formValuesToConfig(openai, { baseUrl: 'https://a.test/v1', headers: '  ' })
    ).not.toHaveProperty('headers');
  });

  it('carries over the keys the form does not render', () => {
    const previous: ProviderConfig = {
      provider: 'openai-compat',
      baseUrl: 'https://old.test/v1',
      voices: [{ id: 'af_bella', name: 'Bella' }],
    };

    const config = formValuesToConfig(openai, { baseUrl: 'https://new.test/v1' }, previous);

    expect(config).toEqual({
      provider: 'openai-compat',
      baseUrl: 'https://new.test/v1',
      // The checkbox is always written, so the form's own state is explicit.
      captionedSpeech: false,
      voices: [{ id: 'af_bella', name: 'Bella' }],
    });
  });

  it('does not carry anything over from another provider', () => {
    const previous: ProviderConfig = {
      provider: 'elevenlabs',
      apiKey: 'k',
      voiceSettings: { stability: 0.5 },
    };

    const config = formValuesToConfig(openai, { baseUrl: 'https://a.test/v1' }, previous);

    expect(config).not.toHaveProperty('voiceSettings');
  });
});

describe('parseStoredConfig', () => {
  it('round-trips every provider through the form', () => {
    for (const id of PROVIDER_IDS) {
      const schema = PROVIDER_SCHEMAS[id];
      const built = formValuesToConfig(schema, filledValues(schema));

      expect(parseStoredConfig(built)).toEqual(built);
    }
  });

  it('rejects anything that is not an object', () => {
    for (const value of [null, undefined, 42, 'dashscope', ['dashscope'], true]) {
      expect(parseStoredConfig(value)).toBeNull();
    }
  });

  it('rejects an object with no provider', () => {
    expect(parseStoredConfig({ apiKey: 'sk-1' })).toBeNull();
  });

  it('rejects a provider it does not know', () => {
    expect(parseStoredConfig({ provider: 'polly' })).toBeNull();
  });

  it('keeps a saved Volcengine config whose resource id was retired', () => {
    // seed-icl-2.0 used to be offered; dropping the whole config would also
    // drop the user's key and silently switch them to the browser voice.
    expect(
      parseStoredConfig({ provider: 'volcengine', apiKey: 'k', resourceId: 'seed-icl-2.0' })
    ).toEqual({ provider: 'volcengine', apiKey: 'k', resourceId: 'seed-tts-1.0' });
  });

  it('rejects a config whose required field is missing', () => {
    expect(parseStoredConfig({ provider: 'dashscope' })).toBeNull();
    expect(parseStoredConfig({ provider: 'dashscope', apiKey: '' })).toBeNull();
    expect(parseStoredConfig({ provider: 'dashscope', apiKey: 42 })).toBeNull();
  });

  it('rejects a config whose required select holds an unknown option', () => {
    expect(
      parseStoredConfig({ provider: 'volcengine', apiKey: 'k', resourceId: 'seed-tts-9.0' })
    ).toBeNull();
  });

  it('keeps a resource id that is one of the known ones', () => {
    expect(
      parseStoredConfig({ provider: 'volcengine', apiKey: 'k', resourceId: 'seed-tts-2.0' })
    ).toEqual({ provider: 'volcengine', apiKey: 'k', resourceId: 'seed-tts-2.0' });
  });

  it('rejects an old-console Volcengine config, which has no supported key', () => {
    expect(parseStoredConfig({ provider: 'volcengine', appId: 'a', accessToken: 't' })).toBeNull();
  });

  it('drops an unknown option from an optional select, leaving the provider default', () => {
    const parsed = parseStoredConfig({
      provider: 'azure',
      subscriptionKey: 'k',
      region: 'eastasia',
      outputFormat: 'mp3_48khz',
    });

    expect(parsed).toEqual({ provider: 'azure', subscriptionKey: 'k', region: 'eastasia' });
  });

  it('drops a corrupt optional field but keeps the rest', () => {
    const parsed = parseStoredConfig({
      provider: 'dashscope',
      apiKey: 'sk-1',
      region: 'mars',
      model: 42,
      baseUrl: 'https://a.test',
    });

    expect(parsed).toEqual({ provider: 'dashscope', apiKey: 'sk-1', baseUrl: 'https://a.test' });
  });

  it('drops an optional field stored as an empty string', () => {
    expect(parseStoredConfig({ provider: 'dashscope', apiKey: 'sk-1', model: '' })).toEqual({
      provider: 'dashscope',
      apiKey: 'sk-1',
    });
  });

  it('keeps a boolean only when it really is one', () => {
    expect(
      parseStoredConfig({
        provider: 'openai-compat',
        baseUrl: 'https://a.test',
        captionedSpeech: true,
      })
    ).toMatchObject({ captionedSpeech: true });

    expect(
      parseStoredConfig({
        provider: 'openai-compat',
        baseUrl: 'https://a.test',
        captionedSpeech: 'yes',
      })
    ).not.toHaveProperty('captionedSpeech');
  });

  it('keeps a header map only when every value is a string', () => {
    expect(
      parseStoredConfig({
        provider: 'openai-compat',
        baseUrl: 'https://a.test',
        headers: { 'X-Key': 'abc' },
      })
    ).toMatchObject({ headers: { 'X-Key': 'abc' } });

    expect(
      parseStoredConfig({
        provider: 'openai-compat',
        baseUrl: 'https://a.test',
        headers: { 'X-Key': 42 },
      })
    ).not.toHaveProperty('headers');
  });

  it('keeps a passthrough value of the right shape', () => {
    expect(
      parseStoredConfig({
        provider: 'openai-compat',
        baseUrl: 'https://a.test',
        voices: [{ id: 'af_bella', name: 'Bella' }],
      })
    ).toMatchObject({ voices: [{ id: 'af_bella', name: 'Bella' }] });

    expect(
      parseStoredConfig({
        provider: 'elevenlabs',
        apiKey: 'k',
        voiceSettings: { stability: 0.5 },
      })
    ).toMatchObject({ voiceSettings: { stability: 0.5 } });
  });

  it('drops a passthrough value of the wrong shape', () => {
    expect(
      parseStoredConfig({ provider: 'openai-compat', baseUrl: 'https://a.test', voices: 'bella' })
    ).not.toHaveProperty('voices');

    expect(
      parseStoredConfig({ provider: 'elevenlabs', apiKey: 'k', voiceSettings: [1, 2] })
    ).not.toHaveProperty('voiceSettings');
  });

  it('ignores keys no field claims', () => {
    expect(parseStoredConfig({ provider: 'dashscope', apiKey: 'sk-1', sneaky: 'value' })).toEqual({
      provider: 'dashscope',
      apiKey: 'sk-1',
    });
  });

  it('accepts the browser voice, which has no fields to check', () => {
    expect(parseStoredConfig({ provider: 'browser', extra: 1 })).toEqual({ provider: 'browser' });
  });
});

/**
 * The on-device provider's fields are all hidden, which makes them the one part
 * of the table the form never exercises — so they are checked directly here.
 */
describe('the on-device provider', () => {
  const local = PROVIDER_SCHEMAS.local;

  it('declares the three choices the Models tab owns, and hides every one', () => {
    expect(local.fields.map((field) => field.key)).toEqual(['modelId', 'tier', 'device']);
    expect(local.fields.every((field) => field.hidden === true)).toBe(true);
  });

  it('says where those choices are made, since the form draws nothing', () => {
    expect(text(local.formNoticeKey)).toMatch(/Models tab/);
  });

  it('keeps the model, tier and device through a round trip', () => {
    // The bug this guards: `parseStoredConfig` keeps only the keys a field
    // claims, so a hidden field missing from the table would make the Models
    // tab's own writes vanish the next time anything read the config back.
    const saved = {
      provider: 'local',
      modelId: 'kokoro-82m',
      tier: 'fp16',
      device: 'webgpu',
    };

    expect(parseStoredConfig(saved)).toEqual(saved);
  });

  it('round-trips through the form values the panel seeds itself with', () => {
    const config: ProviderConfig = {
      provider: 'local',
      modelId: 'kokoro-82m',
      tier: 'fp32',
      device: 'wasm',
    };

    expect(formValuesToConfig(local, configToFormValues(local, config))).toEqual(config);
  });

  it('drops a tier or a device this build does not have', () => {
    expect(parseStoredConfig({ provider: 'local', tier: 'q4', device: 'tpu' })).toEqual({
      provider: 'local',
    });
  });

  it('accepts every model and tier the registry offers', () => {
    for (const model of MODELS) {
      for (const tier of model.tiers ?? []) {
        const config: ProviderConfig = { provider: 'local', modelId: model.id, tier: tier.id };
        const values = configToFormValues(local, config);

        expect(validateFormValues(local, values)).toEqual({});
        expect(formValuesToConfig(local, values)).toEqual(config);
      }
    }
  });

  it('never rejects a hidden field, which would block a save it cannot explain', () => {
    // A hidden field's complaint is drawn nowhere, so an error here would show
    // as "fix the highlighted fields" with nothing highlighted.
    expect(validateFormValues(local, configToFormValues(local, null))).toEqual({});
  });
});
