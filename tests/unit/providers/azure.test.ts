// @vitest-environment node
// The real SDK is never loaded here: a fake is injected through the
// `AzureSdkFactory` seam, which is what makes this provider unit-testable.
import { describe, expect, it, vi } from 'vitest';
import {
  AZURE_CANCELLATION_CODES,
  type AzureOutputFormat,
  AzureProvider,
  type AzureSpeakResult,
  type AzureSpeechSdk,
  type AzureSynthesizerOptions,
  type AzureWordBoundary,
  DEFAULT_OUTPUT_FORMAT,
  isAzureOutputFormat,
  mapCancellationError,
} from '~/lib/providers/azure';
import { ProviderError } from '~/lib/providers/errors';
import type { AzureConfig, ProviderConfig, Voice } from '~/lib/providers/types';
import { base64Of } from './server';

const provider = new AzureProvider(loadFakeSdk);

const signal = new AbortController().signal;

function config(overrides: Partial<AzureConfig> = {}): ProviderConfig {
  return {
    provider: 'azure',
    subscriptionKey: 'azure-secret-key',
    region: 'eastasia',
    ...overrides,
  };
}

interface FakeState {
  created: AzureSynthesizerOptions[];
  texts: string[];
  locales: Array<string | undefined>;
  closes: number;
}

interface FakeConfig {
  result?: AzureSpeakResult;
  speakError?: Error;
  listError?: Error;
  voices?: Voice[];
  boundaries?: AzureWordBoundary[];
}

/** The fake SDK, plus the state the assertions read. */
function fakeSdk(fake: FakeConfig = {}): { sdk: AzureSpeechSdk; state: FakeState } {
  const state: FakeState = { created: [], texts: [], locales: [], closes: 0 };

  const sdk: AzureSpeechSdk = {
    async createSynthesizer(options) {
      state.created.push(options);
      return {
        async speak(text, onWordBoundary, abortSignal) {
          state.texts.push(text);
          for (const boundary of fake.boundaries ?? []) onWordBoundary(boundary);
          if (fake.speakError) throw fake.speakError;
          if (abortSignal.aborted) throw makeAbortError();
          return fake.result ?? { audio: new ArrayBuffer(0), durationMs: 0 };
        },
        async listVoices(locale, abortSignal) {
          state.locales.push(locale);
          if (fake.listError) throw fake.listError;
          if (abortSignal.aborted) throw makeAbortError();
          return fake.voices ?? [];
        },
        close() {
          state.closes++;
        },
      };
    },
  };

  return { sdk, state };
}

/** Swap the fake the provider loads for the next call only. */
let nextSdk: AzureSpeechSdk | Error = new Error('no fake installed');
function loadFakeSdk(): Promise<AzureSpeechSdk> {
  return nextSdk instanceof Error ? Promise.reject(nextSdk) : Promise.resolve(nextSdk);
}

function useFake(fake: FakeConfig = {}): FakeState {
  const { sdk, state } = fakeSdk(fake);
  nextSdk = sdk;
  return state;
}

function makeAbortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}

/** Audio bytes as the SDK hands them over. */
function audioOf(text: string): ArrayBuffer {
  const bytes = Uint8Array.from(atob(base64Of(text)), (char) => char.charCodeAt(0));
  return bytes.buffer;
}

describe('capabilities', () => {
  it('reports exact timings', () => {
    expect(provider.capabilities(config())).toEqual({
      timings: 'exact',
      maxChars: 5000,
      concurrency: 2,
    });
  });

  it('rejects a config for another provider', () => {
    expect(() => provider.capabilities({ provider: 'browser' })).toThrowError(/expected a azure/);
  });
});

describe('isAzureOutputFormat', () => {
  it('accepts the known formats', () => {
    expect(isAzureOutputFormat('mp3_24khz_48k')).toBe(true);
    expect(isAzureOutputFormat('ogg_16khz_opus')).toBe(true);
  });

  it('rejects anything else', () => {
    expect(isAzureOutputFormat('audio-24khz-48kbitrate-mono-mp3')).toBe(false);
    expect(isAzureOutputFormat('')).toBe(false);
  });
});

describe('mapCancellationError', () => {
  it.each([
    [AZURE_CANCELLATION_CODES.authenticationFailure, 'invalid-key'],
    [AZURE_CANCELLATION_CODES.tooManyRequests, 'rate-limit'],
    [AZURE_CANCELLATION_CODES.connectionFailure, 'network-error'],
    [AZURE_CANCELLATION_CODES.serviceTimeout, 'service-unavailable'],
    [AZURE_CANCELLATION_CODES.serviceError, 'service-unavailable'],
    [AZURE_CANCELLATION_CODES.forbidden, 'no-quota'],
    [AZURE_CANCELLATION_CODES.badRequestParameters, 'unknown'],
    [AZURE_CANCELLATION_CODES.runtimeError, 'unknown'],
    [AZURE_CANCELLATION_CODES.noError, 'unknown'],
    [undefined, 'unknown'],
  ])('maps code %s to %s', (code, expected) => {
    expect(mapCancellationError(code, 'failed').code).toBe(expected);
  });

  it('keeps the code and message but never a URL', () => {
    // The SDK appends the subscription key to the WebSocket URL, so an error
    // must never carry that URL.
    const error = mapCancellationError(1, 'auth failed');

    expect(error.details).toEqual({ code: 1 });
    expect(Object.keys(error.details as object)).toEqual(['code']);
  });
});

describe('synthesize', () => {
  const boundaries: AzureWordBoundary[] = [
    { textOffset: 0, audioOffsetMs: 0, durationMs: 400 },
    { textOffset: 2, audioOffsetMs: 400, durationMs: 500 },
  ];

  it('returns the audio and aligns the WordBoundary events', async () => {
    useFake({
      result: { audio: audioOf('AZURE-AUDIO'), durationMs: 900 },
      boundaries,
    });

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'zh-CN-XiaoxiaoNeural', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AZURE-AUDIO');
    expect(result.mime).toBe('audio/mpeg');
    expect(result.durationMs).toBe(900);
    expect(result.timings).toEqual([
      { charStart: 0, charEnd: 2, startMs: 0, endMs: 400 },
      { charStart: 2, charEnd: 4, startMs: 400, endMs: 900 },
    ]);
  });

  it('passes the config through to the SDK', async () => {
    const state = useFake({ boundaries });

    await provider.synthesize(
      { text: '你好', voiceId: 'zh-CN-YunxiNeural', signal },
      config({ lang: 'zh-CN', outputFormat: 'wav_24khz_16bit' })
    );

    expect(state.created).toEqual([
      {
        subscriptionKey: 'azure-secret-key',
        region: 'eastasia',
        voiceName: 'zh-CN-YunxiNeural',
        outputFormat: 'wav_24khz_16bit',
        lang: 'zh-CN',
      },
    ]);
    expect(state.texts).toEqual(['你好']);
  });

  it.each([
    ['mp3_24khz_48k', 'audio/mpeg'],
    ['mp3_16khz_32k', 'audio/mpeg'],
    ['wav_24khz_16bit', 'audio/wav'],
    ['ogg_16khz_opus', 'audio/ogg'],
  ] as Array<[AzureOutputFormat, string]>)('maps %s to %s', async (outputFormat, mime) => {
    useFake({ result: { audio: audioOf('A'), durationMs: 100 } });

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'v', signal },
      config({ outputFormat })
    );

    expect(result.mime).toBe(mime);
  });

  it('defaults the output format when unset or unrecognized', async () => {
    const state = useFake({ result: { audio: audioOf('A'), durationMs: 100 } });

    await provider.synthesize({ text: '你好', voiceId: 'v', signal }, config());
    await provider.synthesize(
      { text: '你好', voiceId: 'v', signal },
      config({ outputFormat: 'nonsense' })
    );

    expect(state.created.map((options) => options.outputFormat)).toEqual([
      DEFAULT_OUTPUT_FORMAT,
      DEFAULT_OUTPUT_FORMAT,
    ]);
  });

  it('falls back to the last boundary end when the SDK reports no duration', async () => {
    useFake({ result: { audio: audioOf('A'), durationMs: 0 }, boundaries });

    const result = await provider.synthesize({ text: '你好世界', voiceId: 'v', signal }, config());

    expect(result.durationMs).toBe(900);
  });

  it('omits timings when no boundary events arrive', async () => {
    useFake({ result: { audio: audioOf('A'), durationMs: 500 } });

    const result = await provider.synthesize({ text: '你好', voiceId: 'v', signal }, config());

    expect(result.timings).toBeUndefined();
    expect(result.durationMs).toBe(500);
  });

  it('omits timings when there is no duration to place them against', async () => {
    useFake({ result: { audio: audioOf('A'), durationMs: 0 } });

    const result = await provider.synthesize({ text: '你好', voiceId: 'v', signal }, config());

    expect(result.timings).toBeUndefined();
    expect(result.durationMs).toBe(0);
  });

  it('drops timings whose offsets do not describe the sentence', async () => {
    // A textOffset past the end of the sentence means the events belong to
    // some other text, so none of them can be trusted.
    useFake({
      result: { audio: audioOf('A'), durationMs: 900 },
      boundaries: [{ textOffset: 40, audioOffsetMs: 0, durationMs: 100 }],
    });

    const result = await provider.synthesize({ text: '你好', voiceId: 'v', signal }, config());

    expect(result.timings).toBeUndefined();
  });

  it('requires a voice id', async () => {
    useFake();

    await expect(
      provider.synthesize({ text: '你好', voiceId: '', signal }, config())
    ).rejects.toMatchObject({ message: 'Azure requires a voice id' });
  });

  it('releases the WebSocket on success', async () => {
    const state = useFake({ result: { audio: audioOf('A'), durationMs: 100 } });

    await provider.synthesize({ text: '你好', voiceId: 'v', signal }, config());

    expect(state.closes).toBe(1);
  });

  it('releases the WebSocket when synthesis fails', async () => {
    const state = useFake({ speakError: new ProviderError('service-unavailable', 'boom') });

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'v', signal }, config())
    ).rejects.toMatchObject({ code: 'service-unavailable' });
    expect(state.closes).toBe(1);
  });

  it('releases the WebSocket when the request is aborted', async () => {
    const state = useFake({ result: { audio: audioOf('A'), durationMs: 100 } });

    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'v', signal: controller.signal }, config())
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(state.closes).toBe(1);
  });

  it('reports a failed SDK load as service-unavailable', async () => {
    nextSdk = new Error('Failed to fetch dynamically imported module');

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'v', signal }, config())
    ).rejects.toMatchObject({
      code: 'service-unavailable',
      message: /Azure Speech SDK could not be loaded/,
    });
  });

  it('does not re-wrap an error that is already a provider error', async () => {
    const original = new ProviderError('invalid-key', 'bad key');
    nextSdk = original;

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'v', signal }, config())
    ).rejects.toBe(original);
  });

  it('never logs the request URL, which carries the subscription key', async () => {
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
    ];

    try {
      useFake({
        speakError: mapCancellationError(1, 'wss://eastasia.api.cognitive.microsoft.com'),
      });

      await provider
        .synthesize({ text: '你好', voiceId: 'v', signal }, config())
        .catch(() => undefined);

      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('validate', () => {
  it('checks the key against the voices endpoint and releases the connection', async () => {
    const state = useFake({ voices: [{ id: 'v', name: 'V' }] });

    await expect(provider.validate(config({ lang: 'zh-CN' }), signal)).resolves.toBeUndefined();

    expect(state.locales).toEqual(['zh-CN']);
    expect(state.closes).toBe(1);
  });

  it('rejects when the key is refused', async () => {
    useFake({
      listError: mapCancellationError(AZURE_CANCELLATION_CODES.authenticationFailure, 'no'),
    });

    await expect(provider.validate(config(), signal)).rejects.toMatchObject({
      code: 'invalid-key',
    });
  });
});

describe('listVoices', () => {
  it('maps the SDK voice info', async () => {
    const state = useFake({
      voices: [
        { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', lang: 'zh-CN', gender: 'female' },
        { id: 'zh-CN-YunxiNeural', name: '云希', lang: 'zh-CN', gender: 'male' },
      ],
    });

    await expect(provider.listVoices(config(), signal)).resolves.toEqual([
      { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', lang: 'zh-CN', gender: 'female' },
      { id: 'zh-CN-YunxiNeural', name: '云希', lang: 'zh-CN', gender: 'male' },
    ]);
    expect(state.closes).toBe(1);
  });

  it('returns nothing when the SDK reports no voices', async () => {
    useFake({ voices: [] });

    await expect(provider.listVoices(config(), signal)).resolves.toEqual([]);
  });

  it('propagates an abort rather than reporting an empty list', async () => {
    useFake({ voices: [{ id: 'v', name: 'V' }] });

    const controller = new AbortController();
    controller.abort();

    await expect(provider.listVoices(config(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});
