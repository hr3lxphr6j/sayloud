// @vitest-environment node
// MSW patches Node's global fetch; happy-dom's fetch is not intercepted.
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import { ElevenLabsProvider, mapElevenLabsError, mapErrorCode } from '~/lib/providers/elevenlabs';
import type { ElevenLabsConfig, ProviderConfig } from '~/lib/providers/types';
import { base64Of, server, useMswServer } from './server';

useMswServer();

const BASE_URL = 'https://api.elevenlabs.io';
const VOICE_ID = 'voice-1';
const SYNTHESIZE = `${BASE_URL}/v1/text-to-speech/${VOICE_ID}/with-timestamps`;
const VOICES = `${BASE_URL}/v1/voices`;

const provider = new ElevenLabsProvider();
const signal = new AbortController().signal;

function config(overrides: Partial<ElevenLabsConfig> = {}): ProviderConfig {
  return { provider: 'elevenlabs', apiKey: 'el-key', ...overrides };
}

/** The three parallel alignment arrays ElevenLabs returns. */
function alignmentFor(text: string, msPerChar = 100) {
  const characters = [...text];
  return {
    characters,
    character_start_times_seconds: characters.map((_, index) => (index * msPerChar) / 1000),
    character_end_times_seconds: characters.map((_, index) => ((index + 1) * msPerChar) / 1000),
  };
}

function synthesisBody(text: string) {
  return { audio_base64: base64Of('EL-AUDIO'), alignment: alignmentFor(text) };
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
    expect(() => provider.capabilities({ provider: 'browser' })).toThrowError(
      /expected a elevenlabs/
    );
  });
});

describe('synthesize', () => {
  it('decodes the audio and merges character timings into words', async () => {
    server.use(http.post(SYNTHESIZE, () => HttpResponse.json(synthesisBody('Hello world'))));

    const result = await provider.synthesize(
      { text: 'Hello world', voiceId: VOICE_ID, signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('EL-AUDIO');
    expect(result.mime).toBe('audio/mpeg');
    expect(result.durationMs).toBe(1100);
    expect(result.timings).toEqual([
      { charStart: 0, charEnd: 5, startMs: 0, endMs: 500 },
      { charStart: 6, charEnd: 11, startMs: 600, endMs: 1100 },
    ]);
  });

  it('sends the key header, model and voice settings', async () => {
    let seenHeaders: Headers | undefined;
    let seenBody: unknown;

    server.use(
      http.post(SYNTHESIZE, async ({ request }) => {
        seenHeaders = request.headers;
        seenBody = await request.json();
        return HttpResponse.json(synthesisBody('Hello world'));
      })
    );

    await provider.synthesize(
      { text: 'Hello world', voiceId: VOICE_ID, signal },
      config({ model: 'eleven_turbo_v2_5', voiceSettings: { stability: 0.5 } })
    );

    expect(seenHeaders?.get('xi-api-key')).toBe('el-key');
    expect(seenBody).toEqual({
      text: 'Hello world',
      model_id: 'eleven_turbo_v2_5',
      voice_settings: { stability: 0.5 },
    });
  });

  it('defaults the model and omits voice settings when unset', async () => {
    let seenBody: { model_id?: string; voice_settings?: unknown } | undefined;

    server.use(
      http.post(SYNTHESIZE, async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.json(synthesisBody('Hi'));
      })
    );

    await provider.synthesize({ text: 'Hi', voiceId: VOICE_ID, signal }, config());

    expect(seenBody?.model_id).toBe('eleven_multilingual_v2');
    expect(seenBody?.voice_settings).toBeUndefined();
  });

  it('passes the output format as a query parameter and derives the mime type', async () => {
    let seenUrl = '';

    server.use(
      http.post(SYNTHESIZE, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(synthesisBody('Hi'));
      })
    );

    const result = await provider.synthesize(
      { text: 'Hi', voiceId: VOICE_ID, signal },
      config({ outputFormat: 'pcm_16000' })
    );

    expect(seenUrl).toContain('output_format=pcm_16000');
    expect(result.mime).toBe('audio/L16');
  });

  it('URL-encodes the voice id', async () => {
    let seenUrl = '';

    server.use(
      http.post(`${BASE_URL}/v1/text-to-speech/voice%2Fweird/with-timestamps`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(synthesisBody('Hi'));
      })
    );

    await provider.synthesize({ text: 'Hi', voiceId: 'voice/weird', signal }, config());

    expect(seenUrl).toContain('/text-to-speech/voice%2Fweird/with-timestamps');
  });

  it('falls back to normalized_alignment when alignment is absent', async () => {
    server.use(
      http.post(SYNTHESIZE, () =>
        HttpResponse.json({
          audio_base64: base64Of('AUDIO'),
          normalized_alignment: alignmentFor('Hello world'),
        })
      )
    );

    const result = await provider.synthesize(
      { text: 'Hello world', voiceId: VOICE_ID, signal },
      config()
    );

    expect(result.timings).toHaveLength(2);
  });

  it('rejects the alignment when the arrays have different lengths', async () => {
    const alignment = alignmentFor('Hello world');

    server.use(
      http.post(SYNTHESIZE, () =>
        HttpResponse.json({
          audio_base64: base64Of('AUDIO'),
          alignment: { ...alignment, character_end_times_seconds: [0.1, 0.2] },
        })
      )
    );

    const result = await provider.synthesize(
      { text: 'Hello world', voiceId: VOICE_ID, signal },
      config()
    );

    expect(result.timings).toBeUndefined();
  });

  it('rejects the alignment when an entry is not a number', async () => {
    const alignment = alignmentFor('Hi');

    server.use(
      http.post(SYNTHESIZE, () =>
        HttpResponse.json({
          audio_base64: base64Of('AUDIO'),
          alignment: { ...alignment, character_start_times_seconds: [0, 'nope'] },
        })
      )
    );

    const result = await provider.synthesize({ text: 'Hi', voiceId: VOICE_ID, signal }, config());

    expect(result.timings).toBeUndefined();
  });

  it('rejects an empty alignment', async () => {
    server.use(
      http.post(SYNTHESIZE, () =>
        HttpResponse.json({
          audio_base64: base64Of('AUDIO'),
          alignment: {
            characters: [],
            character_start_times_seconds: [],
            character_end_times_seconds: [],
          },
        })
      )
    );

    const result = await provider.synthesize({ text: 'Hi', voiceId: VOICE_ID, signal }, config());

    expect(result.timings).toBeUndefined();
  });

  it('skips normalized words and keeps the ones that do line up', async () => {
    // ElevenLabs aligns against the text it speaks: "5" is spoken as "five",
    // so the alignment covers more characters than the sentence has. Spec
    // §2.1 / V9: skip the words that do not line up, keep the rest.
    server.use(
      http.post(SYNTHESIZE, () =>
        HttpResponse.json({
          audio_base64: base64Of('AUDIO'),
          alignment: alignmentFor('It costs five dollars.'),
        })
      )
    );

    const result = await provider.synthesize(
      { text: 'It costs 5 dollars.', voiceId: VOICE_ID, signal },
      config()
    );

    expect(result.timings).toBeDefined();
    expect(result.timings?.map(({ charStart, charEnd }) => [charStart, charEnd])).toContainEqual([
      11, 18,
    ]);
  });

  it('still aligns when only leading whitespace differs', async () => {
    server.use(
      http.post(SYNTHESIZE, () =>
        HttpResponse.json({
          audio_base64: base64Of('AUDIO'),
          alignment: alignmentFor(' Hello world'),
        })
      )
    );

    const result = await provider.synthesize(
      { text: 'Hello world', voiceId: VOICE_ID, signal },
      config()
    );

    expect(result.timings?.map(({ charStart, charEnd }) => [charStart, charEnd])).toEqual([
      [0, 5],
      [6, 11],
    ]);
  });

  it('rejects a response with no audio', async () => {
    server.use(http.post(SYNTHESIZE, () => HttpResponse.json({ alignment: alignmentFor('Hi') })));

    await expect(
      provider.synthesize({ text: 'Hi', voiceId: VOICE_ID, signal }, config())
    ).rejects.toMatchObject({ code: 'unknown', message: 'ElevenLabs returned no audio' });
  });

  it('rejects a non-object response', async () => {
    server.use(http.post(SYNTHESIZE, () => HttpResponse.json([1, 2])));

    await expect(
      provider.synthesize({ text: 'Hi', voiceId: VOICE_ID, signal }, config())
    ).rejects.toMatchObject({ message: 'ElevenLabs returned an unexpected response' });
  });

  it('requires a voice id', async () => {
    await expect(
      provider.synthesize({ text: 'Hi', voiceId: '', signal }, config())
    ).rejects.toMatchObject({ message: 'ElevenLabs requires a voice id' });
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'invalid_api_key', 'invalid-key'],
    [429, 'rate_limit_exceeded', 'rate-limit'],
    [429, 'concurrent_limit_exceeded', 'rate-limit'],
    [400, 'quota_exceeded', 'no-quota'],
    [403, 'paid_plan_required', 'service-unavailable'],
    [422, 'voice_not_found', 'unknown'],
    [500, undefined, 'service-unavailable'],
    [402, undefined, 'no-quota'],
  ])('maps HTTP %i with code %s to %s', async (status, code, expected) => {
    server.use(
      http.post(SYNTHESIZE, () =>
        HttpResponse.json({ detail: { status: code, message: 'failed' } }, { status })
      )
    );

    await expect(
      provider.synthesize({ text: 'Hi', voiceId: VOICE_ID, signal }, config())
    ).rejects.toMatchObject({ code: expected });
  });

  it('reads a string detail for the message', () => {
    const error = mapElevenLabsError(400, '{"detail":"bad request"}');

    expect(error.message).toBe('bad request');
    expect(error.code).toBe('unknown');
  });

  it('reads a top-level code', () => {
    expect(mapElevenLabsError(401, '{"code":"invalid_api_key"}').code).toBe('invalid-key');
  });

  it('ignores a non-JSON body', () => {
    expect(mapElevenLabsError(500, 'gateway exploded').code).toBe('service-unavailable');
  });

  it('maps a bare code', () => {
    expect(mapErrorCode('invalid_api_key')).toBe('invalid-key');
    expect(mapErrorCode('unheard_of')).toBeUndefined();
  });

  it('reports a transport failure as network-error', async () => {
    server.use(http.post(SYNTHESIZE, () => HttpResponse.error()));

    await expect(
      provider.synthesize({ text: 'Hi', voiceId: VOICE_ID, signal }, config())
    ).rejects.toMatchObject({ code: 'network-error' });
  });

  it('propagates an abort rather than reporting a provider failure', async () => {
    server.use(http.post(SYNTHESIZE, () => HttpResponse.json(synthesisBody('Hi'))));

    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.synthesize({ text: 'Hi', voiceId: VOICE_ID, signal: controller.signal }, config())
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('listVoices', () => {
  const voicesBody = {
    voices: [
      {
        voice_id: 'v1',
        name: 'Rachel',
        labels: { language: 'en', gender: 'female', accent: 'american' },
      },
      { voice_id: 'v2', name: 'Adam', labels: { gender: 'male' } },
      { voice_id: 'v3', name: 'NoLabels' },
      { name: 'MissingId' },
      null,
    ],
  };

  it('parses the voice list with labels', async () => {
    server.use(http.get(VOICES, () => HttpResponse.json(voicesBody)));

    await expect(provider.listVoices(config(), signal)).resolves.toEqual([
      { id: 'v1', name: 'Rachel', supportsTimings: true, lang: 'en', gender: 'female' },
      { id: 'v2', name: 'Adam', supportsTimings: true, gender: 'male' },
      { id: 'v3', name: 'NoLabels', supportsTimings: true },
    ]);
  });

  it('ignores an unrecognized gender label', async () => {
    server.use(
      http.get(VOICES, () =>
        HttpResponse.json({ voices: [{ voice_id: 'v1', name: 'X', labels: { gender: 'robot' } }] })
      )
    );

    await expect(provider.listVoices(config(), signal)).resolves.toEqual([
      { id: 'v1', name: 'X', supportsTimings: true },
    ]);
  });

  it('sends the key header', async () => {
    let seenHeaders: Headers | undefined;

    server.use(
      http.get(VOICES, ({ request }) => {
        seenHeaders = request.headers;
        return HttpResponse.json({ voices: [] });
      })
    );

    await provider.listVoices(config(), signal);

    expect(seenHeaders?.get('xi-api-key')).toBe('el-key');
  });

  it('returns nothing when the payload has no voices array', async () => {
    server.use(http.get(VOICES, () => HttpResponse.json({})));

    await expect(provider.listVoices(config(), signal)).resolves.toEqual([]);
  });

  it('reports a refused key', async () => {
    server.use(
      http.get(VOICES, () =>
        HttpResponse.json({ detail: { status: 'invalid_api_key' } }, { status: 401 })
      )
    );

    await expect(provider.listVoices(config(), signal)).rejects.toMatchObject({
      code: 'invalid-key',
    });
  });
});

describe('validate', () => {
  it('resolves when the key is accepted', async () => {
    server.use(http.get(VOICES, () => HttpResponse.json({ voices: [] })));

    await expect(provider.validate(config(), signal)).resolves.toBeUndefined();
  });

  it('rejects when the key is refused', async () => {
    server.use(
      http.get(VOICES, () =>
        HttpResponse.json({ detail: { status: 'invalid_api_key' } }, { status: 401 })
      )
    );

    await expect(provider.validate(config(), signal)).rejects.toMatchObject({
      code: 'invalid-key',
    });
  });

  it('reports a transport failure as network-error', async () => {
    server.use(http.get(VOICES, () => HttpResponse.error()));

    await expect(provider.validate(config(), signal)).rejects.toMatchObject({
      code: 'network-error',
    });
  });
});
