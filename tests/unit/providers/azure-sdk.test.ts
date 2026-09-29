// @vitest-environment node
// The real SDK is replaced by a module mock: this file tests the binding
// logic (tick conversion, boundary filtering, abort wiring), not Azure.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AzureOutputFormat } from '~/lib/providers/azure';

interface ConfigState {
  subscriptionKey: string | undefined;
  region: string | undefined;
  voiceName: string | undefined;
  language: string | undefined;
  outputFormat: number | undefined;
  properties: Array<{ name: unknown; value: string }>;
}

interface SynthesizerState {
  constructed: boolean;
  speakText: string | undefined;
  locale: string | undefined;
  closes: number;
  wordBoundary: ((sender: unknown, event: unknown) => void) | undefined;
  onResult: ((result: unknown) => void) | undefined;
  onError: ((error: string) => void) | undefined;
  voices: unknown;
}

const fake = vi.hoisted(() => {
  const config: ConfigState = {
    subscriptionKey: undefined,
    region: undefined,
    voiceName: undefined,
    language: undefined,
    outputFormat: undefined,
    properties: [],
  };
  const synth: SynthesizerState = {
    constructed: false,
    speakText: undefined,
    locale: undefined,
    closes: 0,
    wordBoundary: undefined,
    onResult: undefined,
    onError: undefined,
    voices: { voices: [] },
  };

  class SpeechConfig {
    private voiceName = '';
    private language = '';
    private format = -1;

    get speechSynthesisVoiceName(): string {
      return this.voiceName;
    }

    set speechSynthesisVoiceName(value: string) {
      this.voiceName = value;
      config.voiceName = value;
    }

    get speechSynthesisLanguage(): string {
      return this.language;
    }

    set speechSynthesisLanguage(value: string) {
      this.language = value;
      config.language = value;
    }

    get speechSynthesisOutputFormat(): number {
      return this.format;
    }

    set speechSynthesisOutputFormat(value: number) {
      this.format = value;
      config.outputFormat = value;
    }

    static fromSubscription(key: string, region: string): SpeechConfig {
      config.subscriptionKey = key;
      config.region = region;
      return new SpeechConfig();
    }

    setProperty(name: unknown, value: string): void {
      config.properties.push({ name, value });
    }
  }

  class SpeechSynthesizer {
    private handler: ((sender: unknown, event: unknown) => void) | undefined;

    constructor(readonly speechConfig: SpeechConfig) {
      synth.constructed = true;
    }

    // azure-sdk assigns this on the instance, so mirror it into the shared
    // state the assertions read.
    get wordBoundary(): ((sender: unknown, event: unknown) => void) | undefined {
      return this.handler;
    }

    set wordBoundary(value: ((sender: unknown, event: unknown) => void) | undefined) {
      this.handler = value;
      synth.wordBoundary = value;
    }

    speakTextAsync(
      text: string,
      onResult?: (result: unknown) => void,
      onError?: (error: string) => void
    ): void {
      synth.speakText = text;
      synth.onResult = onResult;
      synth.onError = onError;
    }

    getVoicesAsync(locale?: string): Promise<unknown> {
      synth.locale = locale;
      return Promise.resolve(synth.voices);
    }

    close(): void {
      synth.closes++;
    }
  }

  return { config, synth, SpeechConfig, SpeechSynthesizer };
});

vi.mock('microsoft-cognitiveservices-speech-sdk', () => ({
  SpeechConfig: fake.SpeechConfig,
  SpeechSynthesizer: fake.SpeechSynthesizer,
  PropertyId: {
    SpeechServiceResponse_RequestWordBoundary: 45,
    SpeechServiceResponse_RequestPunctuationBoundary: 46,
  },
  SpeechSynthesisOutputFormat: {
    Audio24Khz48KBitRateMonoMp3: 6,
    Audio16Khz32KBitRateMonoMp3: 3,
    Riff24Khz16BitMonoPcm: 12,
    Ogg16Khz16BitMonoOpus: 17,
  },
  ResultReason: { SynthesizingAudioCompleted: 8, Canceled: 1 },
  CancellationDetails: {
    fromResult: (result: unknown) => {
      const details = (result as { cancellation?: unknown }).cancellation;
      return details ?? { ErrorCode: 0, errorDetails: '' };
    },
  },
  SpeechSynthesisBoundaryType: {
    Word: 'WordBoundary',
    Punctuation: 'PunctuationBoundary',
    Sentence: 'SentenceBoundary',
  },
  SynthesisVoiceGender: { Unknown: 0, Female: 1, Male: 2, Neutral: 3 },
}));

const { createAzureSpeechSdk } = await import('~/lib/providers/azure-sdk');

/** Our format vocabulary mapped to the SDK's enum values. */
const FORMAT_CASES: Array<[AzureOutputFormat, number]> = [
  ['mp3_24khz_48k', 6],
  ['mp3_16khz_32k', 3],
  ['wav_24khz_16bit', 12],
  ['ogg_16khz_opus', 17],
];

/** The tick unit Azure uses for audio positions. */
const TICKS_PER_MS = 10_000;

const options = {
  subscriptionKey: 'secret',
  region: 'eastasia',
  voiceName: 'zh-CN-XiaoxiaoNeural',
  outputFormat: 'mp3_24khz_48k' as const,
};

beforeEach(() => {
  fake.config.subscriptionKey = undefined;
  fake.config.region = undefined;
  fake.config.voiceName = undefined;
  fake.config.language = undefined;
  fake.config.outputFormat = undefined;
  fake.config.properties = [];

  fake.synth.constructed = false;
  fake.synth.speakText = undefined;
  fake.synth.locale = undefined;
  fake.synth.closes = 0;
  fake.synth.wordBoundary = undefined;
  fake.synth.onResult = undefined;
  fake.synth.onError = undefined;
  fake.synth.voices = { voices: [] };
});

/** The wordBoundary handler azure-sdk installed on the synthesizer. */
function emitWordBoundary(event: {
  boundaryType?: string;
  textOffset?: number;
  audioOffset?: number;
  duration?: number;
}): void {
  fake.synth.wordBoundary?.(undefined, {
    boundaryType: 'WordBoundary',
    textOffset: 0,
    audioOffset: 0,
    duration: 0,
    ...event,
  });
}

/** Complete the in-flight synthesis with a successful result. */
function completeWith(audioData: ArrayBuffer, audioDuration: number): void {
  fake.synth.onResult?.({ reason: 8, audioData, audioDuration });
}

describe('createSynthesizer', () => {
  it('configures the voice, language and region', async () => {
    await createAzureSpeechSdk().createSynthesizer({ ...options, lang: 'zh-CN' });

    expect(fake.synth.constructed).toBe(true);
    expect(fake.config.subscriptionKey).toBe('secret');
    expect(fake.config.region).toBe('eastasia');
    expect(fake.config.voiceName).toBe('zh-CN-XiaoxiaoNeural');
    expect(fake.config.language).toBe('zh-CN');
  });

  it('leaves the voice and language unset when they are not supplied', async () => {
    await createAzureSpeechSdk().createSynthesizer({
      subscriptionKey: 'secret',
      region: 'eastasia',
      outputFormat: 'mp3_24khz_48k',
    });

    expect(fake.config.voiceName).toBeUndefined();
    expect(fake.config.language).toBeUndefined();
  });

  it('enables word boundaries and disables punctuation boundaries', async () => {
    await createAzureSpeechSdk().createSynthesizer(options);

    // Without these two properties the SDK delivers no usable word events:
    // boundaries are off by default, and punctuation boundaries are on.
    expect(fake.config.properties).toEqual([
      { name: 45, value: 'true' },
      { name: 46, value: 'false' },
    ]);
  });

  it.each(FORMAT_CASES)('maps %s to SDK format %i', async (outputFormat, expected) => {
    await createAzureSpeechSdk().createSynthesizer({ ...options, outputFormat });

    expect(fake.config.outputFormat).toBe(expected);
  });
});

describe('speak', () => {
  it('resolves with the audio and converts ticks to milliseconds', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const pending = synthesizer.speak('你好', () => {}, new AbortController().signal);

    expect(fake.synth.speakText).toBe('你好');
    completeWith(new Uint8Array([1, 2, 3]).buffer, 900 * TICKS_PER_MS);

    const result = await pending;
    expect(Array.from(new Uint8Array(result.audio))).toEqual([1, 2, 3]);
    expect(result.durationMs).toBe(900);
  });

  it('converts boundary ticks to milliseconds', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const boundaries: Array<{ textOffset: number; audioOffsetMs: number; durationMs: number }> = [];

    const pending = synthesizer.speak(
      '你好世界',
      (b) => boundaries.push(b),
      new AbortController().signal
    );
    emitWordBoundary({
      textOffset: 2,
      audioOffset: 400 * TICKS_PER_MS,
      duration: 500 * TICKS_PER_MS,
    });
    completeWith(new ArrayBuffer(0), 0);
    await pending;

    expect(boundaries).toEqual([{ textOffset: 2, audioOffsetMs: 400, durationMs: 500 }]);
  });

  it('ignores punctuation and sentence boundaries', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const boundaries: unknown[] = [];

    const pending = synthesizer.speak(
      '你好。',
      (b) => boundaries.push(b),
      new AbortController().signal
    );
    emitWordBoundary({ boundaryType: 'PunctuationBoundary', textOffset: 2 });
    emitWordBoundary({ boundaryType: 'SentenceBoundary', textOffset: 3 });
    emitWordBoundary({ boundaryType: 'WordBoundary', textOffset: 0 });
    completeWith(new ArrayBuffer(0), 0);
    await pending;

    expect(boundaries).toEqual([{ textOffset: 0, audioOffsetMs: 0, durationMs: 0 }]);
  });

  it('reports a non-success result as a mapped provider error', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const pending = synthesizer.speak('你好', () => {}, new AbortController().signal);

    fake.synth.onResult?.({
      reason: 1,
      cancellation: { ErrorCode: 1, errorDetails: 'auth failed' },
    });

    await expect(pending).rejects.toMatchObject({ code: 'invalid-key', message: 'auth failed' });
  });

  it('describes a cancellation that carries no details', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const pending = synthesizer.speak('你好', () => {}, new AbortController().signal);

    fake.synth.onResult?.({ reason: 1, cancellation: { ErrorCode: 0, errorDetails: '' } });

    await expect(pending).rejects.toMatchObject({ message: 'Azure synthesis ended with reason 1' });
  });

  it('reports the SDK error callback as a provider error', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const pending = synthesizer.speak('你好', () => {}, new AbortController().signal);

    fake.synth.onError?.('connection reset');

    await expect(pending).rejects.toMatchObject({
      code: 'unknown',
      message: 'connection reset',
    });
  });

  it('rejects immediately when the signal is already aborted', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const controller = new AbortController();
    controller.abort();

    await expect(synthesizer.speak('你好', () => {}, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    // The SDK has no cancel API, so closing the synthesizer is what actually
    // stops the request.
    expect(fake.synth.closes).toBe(1);
  });

  it('rejects with an AbortError when the signal fires mid-flight', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const controller = new AbortController();
    const pending = synthesizer.speak('你好', () => {}, controller.signal);

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.synth.closes).toBe(1);
  });

  it('ignores a result that arrives after the abort', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const controller = new AbortController();
    const pending = synthesizer.speak('你好', () => {}, controller.signal);

    controller.abort();
    // A late success must not resurrect a request the caller cancelled.
    completeWith(new ArrayBuffer(0), 100 * TICKS_PER_MS);

    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('ignores a second result for the same request', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const pending = synthesizer.speak('你好', () => {}, new AbortController().signal);

    completeWith(new Uint8Array([1]).buffer, 100 * TICKS_PER_MS);
    fake.synth.onError?.('too late');

    await expect(pending).resolves.toMatchObject({ durationMs: 100 });
  });
});

describe('listVoices', () => {
  it('maps the SDK voice info', async () => {
    fake.synth.voices = {
      voices: [
        { name: 'zh-CN-XiaoxiaoNeural', localName: '晓晓', locale: 'zh-CN', gender: 1 },
        { name: 'zh-CN-YunxiNeural', localName: '云希', locale: 'zh-CN', gender: 2 },
        { name: 'neutral', localName: 'N', locale: 'en-US', gender: 3 },
      ],
    };

    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);

    await expect(synthesizer.listVoices('zh-CN', new AbortController().signal)).resolves.toEqual([
      {
        id: 'zh-CN-XiaoxiaoNeural',
        name: '晓晓',
        lang: 'zh-CN',
        gender: 'female',
        supportsTimings: true,
      },
      {
        id: 'zh-CN-YunxiNeural',
        name: '云希',
        lang: 'zh-CN',
        gender: 'male',
        supportsTimings: true,
      },
      { id: 'neutral', name: 'N', lang: 'en-US', gender: 'neutral', supportsTimings: true },
    ]);
    expect(fake.synth.locale).toBe('zh-CN');
  });

  it('omits an unknown gender and a missing locale', async () => {
    fake.synth.voices = { voices: [{ name: 'v', localName: '', gender: 0 }] };

    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);

    await expect(synthesizer.listVoices(undefined, new AbortController().signal)).resolves.toEqual([
      { id: 'v', name: 'v', supportsTimings: true },
    ]);
  });

  it('falls back to the voice name when there is no local name', async () => {
    fake.synth.voices = { voices: [{ name: 'v', localName: '', locale: 'en-US', gender: 1 }] };

    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);

    await expect(synthesizer.listVoices(undefined, new AbortController().signal)).resolves.toEqual([
      { id: 'v', name: 'v', lang: 'en-US', gender: 'female', supportsTimings: true },
    ]);
  });

  it('returns nothing when the result has no voice list', async () => {
    fake.synth.voices = {};

    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);

    await expect(synthesizer.listVoices(undefined, new AbortController().signal)).resolves.toEqual(
      []
    );
  });

  it('honours a cancellation that landed while the request was in flight', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);
    const controller = new AbortController();
    controller.abort();

    await expect(synthesizer.listVoices(undefined, controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('close', () => {
  it('closes the underlying synthesizer once', async () => {
    const synthesizer = await createAzureSpeechSdk().createSynthesizer(options);

    synthesizer.close();
    synthesizer.close();

    expect(fake.synth.closes).toBe(1);
  });
});
