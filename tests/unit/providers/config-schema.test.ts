import { describe, expect, it } from 'vitest';
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
import type { ProviderConfig } from '~/lib/providers/types';

const dashscope = PROVIDER_SCHEMAS.dashscope;
const openai = PROVIDER_SCHEMAS['openai-compat'];

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
    expect(parsed.errors).toEqual(['Line 1: expected a "Name: Value" pair.']);
  });

  it('rejects a name that is not a header token', () => {
    const parsed = parseHeaderLines('# note: abc');

    expect(parsed.headers).toEqual({});
    expect(parsed.errors).toEqual(['Line 1: "# note" is not a valid header name.']);
  });

  it('rejects a name with a space in it', () => {
    expect(parseHeaderLines('X Key: abc').errors).toHaveLength(1);
  });

  it('names the offending line when a pair is malformed', () => {
    const parsed = parseHeaderLines('X-Key: abc\nnot a header\nX-More: d');

    expect(parsed.headers).toEqual({ 'X-Key': 'abc', 'X-More': 'd' });
    expect(parsed.errors).toEqual(['Line 2: expected a "Name: Value" pair.']);
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

    expect(errors.apiKey).toBe('API key is required.');
  });

  it('does not require an optional field', () => {
    expect(validateFormValues(dashscope, { apiKey: 'sk-1' })).toEqual({});
  });

  it('rejects a URL without a scheme', () => {
    const errors = validateFormValues(openai, { baseUrl: 'localhost:8880' });

    expect(errors.baseUrl).toMatch(/full URL/);
  });

  it('rejects a select value outside its options', () => {
    const errors = validateFormValues(dashscope, { apiKey: 'sk-1', region: 'mars' });

    expect(errors.region).toBe('Choose one of the listed options.');
  });

  it('accepts a select value that is one of the options', () => {
    expect(validateFormValues(dashscope, { apiKey: 'sk-1', region: 'intl' })).toEqual({});
  });

  it('reports the first malformed header line', () => {
    const errors = validateFormValues(openai, { baseUrl: 'https://a.test/v1', headers: 'oops' });

    expect(errors.headers).toBe('Line 1: expected a "Name: Value" pair.');
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
      region: 'intl',
    });

    expect(values.apiKey).toBe('sk-1');
    expect(values.region).toBe('intl');
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

  it('rejects a config whose required field is missing', () => {
    expect(parseStoredConfig({ provider: 'dashscope' })).toBeNull();
    expect(parseStoredConfig({ provider: 'dashscope', apiKey: '' })).toBeNull();
    expect(parseStoredConfig({ provider: 'dashscope', apiKey: 42 })).toBeNull();
  });

  it('drops an unknown option from an optional select, leaving the provider default', () => {
    const parsed = parseStoredConfig({
      provider: 'volcengine',
      appId: 'a',
      accessToken: 't',
      model: 'tts-9.0',
    });

    expect(parsed).toEqual({ provider: 'volcengine', appId: 'a', accessToken: 't' });
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
