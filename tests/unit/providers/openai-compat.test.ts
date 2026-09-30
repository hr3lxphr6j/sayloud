// @vitest-environment node
// MSW patches Node's global fetch; happy-dom's fetch is not intercepted.
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  isLocalServer,
  mapErrorCode,
  mapOpenAiError,
  OpenAiCompatProvider,
} from '~/lib/providers/openai-compat';
import type { OpenAiCompatConfig, ProviderConfig } from '~/lib/providers/types';
import { base64Of, server, useMswServer } from './server';

useMswServer();

const BASE_URL = 'https://api.test/v1';
const SPEECH = `${BASE_URL}/audio/speech`;
const CAPTIONED = `${BASE_URL}/dev/captioned_speech`;
const VOICES = `${BASE_URL}/audio/voices`;

const provider = new OpenAiCompatProvider();
const signal = new AbortController().signal;

function config(overrides: Partial<OpenAiCompatConfig> = {}): ProviderConfig {
  return { provider: 'openai-compat', baseUrl: BASE_URL, apiKey: 'sk-test', ...overrides };
}

/** Raw audio bytes, as the standard endpoint returns them. */
function audioResponse(bytes: number[], contentType = 'audio/mpeg') {
  return HttpResponse.arrayBuffer(new Uint8Array(bytes).buffer, {
    headers: { 'Content-Type': contentType },
  });
}

describe('capabilities', () => {
  it('reports exact timings only for the captioned endpoint', () => {
    expect(provider.capabilities(config({ captionedSpeech: true }))).toEqual({
      timings: 'exact',
      maxChars: 4000,
      concurrency: 2,
    });
    expect(provider.capabilities(config()).timings).toBe('none');
  });

  it('recommends one in-flight request for a local server', () => {
    expect(provider.capabilities(config({ baseUrl: 'http://localhost:8880/v1' })).concurrency).toBe(
      1
    );
    expect(provider.capabilities(config({ baseUrl: 'http://127.0.0.1:8880/v1' })).concurrency).toBe(
      1
    );
  });

  it('rejects a config for another provider', () => {
    expect(() => provider.capabilities({ provider: 'browser' })).toThrowError(
      /expected a openai-compat/
    );
  });
});

describe('isLocalServer', () => {
  it.each([
    ['http://localhost:8880/v1', true],
    ['http://127.0.0.1:8880/v1', true],
    ['https://api.openai.com/v1', false],
    ['not a url', false],
  ])('classifies %s as %s', (url, expected) => {
    expect(isLocalServer(url)).toBe(expected);
  });
});

describe('synthesize (standard endpoint)', () => {
  it('returns the raw audio and no timings', async () => {
    server.use(http.post(SPEECH, () => audioResponse([1, 2, 3])));

    const result = await provider.synthesize(
      { text: 'Hello world.', voiceId: 'alloy', signal },
      config()
    );

    expect(Array.from(new Uint8Array(result.audio))).toEqual([1, 2, 3]);
    expect(result.mime).toBe('audio/mpeg');
    expect(result.timings).toBeUndefined();
    expect(result.durationMs).toBe(0);
  });

  it('sends the documented body and bearer token', async () => {
    let seenHeaders: Headers | undefined;
    let seenBody: unknown;

    server.use(
      http.post(SPEECH, async ({ request }) => {
        seenHeaders = request.headers;
        seenBody = await request.json();
        return audioResponse([1]);
      })
    );

    await provider.synthesize(
      { text: 'Hello.', voiceId: 'nova', signal },
      config({ model: 'tts-1-hd' })
    );

    expect(seenHeaders?.get('authorization')).toBe('Bearer sk-test');
    expect(seenBody).toEqual({
      model: 'tts-1-hd',
      input: 'Hello.',
      voice: 'nova',
      response_format: 'mp3',
    });
  });

  it('omits the Authorization header for a server with no key', async () => {
    let seenHeaders: Headers | undefined;

    server.use(
      http.post(SPEECH, ({ request }) => {
        seenHeaders = request.headers;
        return audioResponse([1]);
      })
    );

    await provider.synthesize(
      { text: 'Hello.', voiceId: 'alloy', signal },
      config({ apiKey: undefined })
    );

    expect(seenHeaders?.get('authorization')).toBeNull();
  });

  it('merges the configured extra headers', async () => {
    let seenHeaders: Headers | undefined;

    server.use(
      http.post(SPEECH, ({ request }) => {
        seenHeaders = request.headers;
        return audioResponse([1]);
      })
    );

    await provider.synthesize(
      { text: 'Hello.', voiceId: 'alloy', signal },
      config({ headers: { 'X-Gateway': 'edge' } })
    );

    expect(seenHeaders?.get('x-gateway')).toBe('edge');
    expect(seenHeaders?.get('authorization')).toBe('Bearer sk-test');
  });

  it('tolerates a trailing slash on baseUrl', async () => {
    server.use(http.post(SPEECH, () => audioResponse([7])));

    const result = await provider.synthesize(
      { text: 'Hello.', voiceId: 'alloy', signal },
      config({ baseUrl: `${BASE_URL}/` })
    );

    expect(Array.from(new Uint8Array(result.audio))).toEqual([7]);
  });

  it('prefers the server Content-Type over the requested format', async () => {
    server.use(http.post(SPEECH, () => audioResponse([1], 'audio/wav')));

    const result = await provider.synthesize(
      { text: 'Hello.', voiceId: 'alloy', signal },
      config()
    );

    expect(result.mime).toBe('audio/wav');
  });

  it('rejects empty audio', async () => {
    server.use(http.post(SPEECH, () => audioResponse([])));

    await expect(
      provider.synthesize({ text: 'Hello.', voiceId: 'alloy', signal }, config())
    ).rejects.toMatchObject({ code: 'unknown', message: 'server returned empty audio' });
  });
});

describe('voice resolution', () => {
  it('falls back to the first configured voice', async () => {
    let seenBody: { voice?: string } | undefined;

    server.use(
      http.post(SPEECH, async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return audioResponse([1]);
      })
    );

    await provider.synthesize(
      { text: 'Hello.', voiceId: '', signal },
      config({ voices: [{ id: 'af_bella', name: 'Bella' }] })
    );

    expect(seenBody?.voice).toBe('af_bella');
  });

  it('falls back to the OpenAI default voice', async () => {
    let seenBody: { voice?: string } | undefined;

    server.use(
      http.post(SPEECH, async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return audioResponse([1]);
      })
    );

    await provider.synthesize({ text: 'Hello.', voiceId: '', signal }, config());

    expect(seenBody?.voice).toBe('alloy');
  });
});

describe('synthesize (captioned endpoint)', () => {
  const captionedBody = {
    audio: base64Of('KOKORO-AUDIO'),
    timestamps: [
      { word: 'Hello', start_time: 0, end_time: 0.4 },
      { word: 'world', start_time: 0.4, end_time: 0.9 },
    ],
  };

  it('decodes the audio and aligns the word timestamps', async () => {
    server.use(http.post(CAPTIONED, () => HttpResponse.json(captionedBody)));

    const result = await provider.synthesize(
      { text: 'Hello world', voiceId: 'af_bella', signal },
      config({ captionedSpeech: true })
    );

    expect(new TextDecoder().decode(result.audio)).toBe('KOKORO-AUDIO');
    expect(result.mime).toBe('audio/mpeg');
    expect(result.durationMs).toBe(900);
    expect(result.timings).toEqual([
      { charStart: 0, charEnd: 5, startMs: 0, endMs: 400 },
      { charStart: 6, charEnd: 11, startMs: 400, endMs: 900 },
    ]);
  });

  it('requests timestamps and posts to the captioned path', async () => {
    let seenBody: unknown;

    server.use(
      http.post(CAPTIONED, async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.json(captionedBody);
      })
    );

    await provider.synthesize(
      { text: 'Hello world', voiceId: 'af_bella', signal },
      config({ captionedSpeech: true })
    );

    // V7: the request is the OpenAI body plus `stream: false`; without it
    // Kokoro streams audio chunks instead of answering with one JSON body.
    expect(seenBody).toMatchObject({ stream: false, voice: 'af_bella', input: 'Hello world' });
    expect(seenBody).not.toHaveProperty('return_timestamps');
  });

  it('reads the audio format Kokoro reports in audio_format', async () => {
    server.use(
      http.post(CAPTIONED, () =>
        HttpResponse.json({ audio: base64Of('AUDIO'), audio_format: 'wav', timestamps: [] })
      )
    );

    const result = await provider.synthesize(
      { text: 'Hello', voiceId: 'af_bella', signal },
      config({ captionedSpeech: true })
    );

    expect(result.mime).toBe('audio/wav');
  });

  it('reads millisecond fields when the server sends them', async () => {
    server.use(
      http.post(CAPTIONED, () =>
        HttpResponse.json({
          audio: base64Of('AUDIO'),
          timestamps: [{ word: 'Hello', start_ms: 100, end_ms: 500 }],
        })
      )
    );

    const result = await provider.synthesize(
      { text: 'Hello', voiceId: 'af_bella', signal },
      config({ captionedSpeech: true })
    );

    expect(result.timings).toEqual([{ charStart: 0, charEnd: 5, startMs: 100, endMs: 500 }]);
  });

  it('accepts the audio_base64 alias', async () => {
    server.use(http.post(CAPTIONED, () => HttpResponse.json({ audio_base64: base64Of('ALIAS') })));

    const result = await provider.synthesize(
      { text: 'Hello', voiceId: 'af_bella', signal },
      config({ captionedSpeech: true })
    );

    expect(new TextDecoder().decode(result.audio)).toBe('ALIAS');
  });

  it('drops timings the sentence cannot support instead of guessing', async () => {
    server.use(
      http.post(CAPTIONED, () =>
        HttpResponse.json({
          audio: base64Of('AUDIO'),
          timestamps: [{ word: 'five', start_time: 0, end_time: 0.4 }],
        })
      )
    );

    const result = await provider.synthesize(
      { text: 'It costs 5.', voiceId: 'af_bella', signal },
      config({ captionedSpeech: true })
    );

    expect(result.timings).toBeUndefined();
  });

  it('rejects a response with no audio', async () => {
    server.use(http.post(CAPTIONED, () => HttpResponse.json({ timestamps: [] })));

    await expect(
      provider.synthesize(
        { text: 'Hello', voiceId: 'af_bella', signal },
        config({ captionedSpeech: true })
      )
    ).rejects.toMatchObject({ code: 'unknown', message: 'server returned no audio' });
  });

  it('rejects a non-object response', async () => {
    server.use(http.post(CAPTIONED, () => HttpResponse.json([1, 2])));

    await expect(
      provider.synthesize(
        { text: 'Hello', voiceId: 'af_bella', signal },
        config({ captionedSpeech: true })
      )
    ).rejects.toMatchObject({ message: 'server returned an unexpected captioned response' });
  });
});

describe('listVoices', () => {
  it('reads a Kokoro-style list of ids', async () => {
    server.use(http.get(VOICES, () => HttpResponse.json({ voices: ['af_bella', 'am_adam'] })));

    await expect(provider.listVoices(config(), signal)).resolves.toEqual([
      { id: 'af_bella', name: 'af_bella' },
      { id: 'am_adam', name: 'am_adam' },
    ]);
  });

  it('reads an OpenAI-style list of objects', async () => {
    server.use(
      http.get(VOICES, () =>
        HttpResponse.json({
          data: [{ id: 'alloy', name: 'Alloy', language: 'en-US' }, { name: 'NoId' }, 'nova'],
        })
      )
    );

    // A name-only entry becomes its own id: compat servers take the voice
    // name in the request, so the name is the identifier that works.
    await expect(provider.listVoices(config(), signal)).resolves.toEqual([
      { id: 'alloy', name: 'Alloy', lang: 'en-US' },
      { id: 'NoId', name: 'NoId' },
      { id: 'nova', name: 'nova' },
    ]);
  });

  it('skips entries with no usable identifier', async () => {
    server.use(http.get(VOICES, () => HttpResponse.json({ data: [null, 42, {}] })));

    await expect(provider.listVoices(config(), signal)).resolves.toEqual([]);
  });

  it('sends the bearer token', async () => {
    let seenHeaders: Headers | undefined;

    server.use(
      http.get(VOICES, ({ request }) => {
        seenHeaders = request.headers;
        return HttpResponse.json({ voices: [] });
      })
    );

    await provider.listVoices(config(), signal);

    expect(seenHeaders?.get('authorization')).toBe('Bearer sk-test');
  });

  it('falls back to the configured list when the endpoint is missing', async () => {
    server.use(http.get(VOICES, () => new HttpResponse(null, { status: 404 })));

    const voices = await provider.listVoices(
      config({ voices: [{ id: 'af_bella', name: 'Bella' }] }),
      signal
    );

    expect(voices).toEqual([{ id: 'af_bella', name: 'Bella' }]);
  });

  it('falls back to the configured list when the endpoint errors', async () => {
    server.use(http.get(VOICES, () => HttpResponse.error()));

    const voices = await provider.listVoices(
      config({ voices: [{ id: 'af_bella', name: 'Bella' }] }),
      signal
    );

    expect(voices).toEqual([{ id: 'af_bella', name: 'Bella' }]);
  });

  it('falls back when the endpoint answers with an empty list', async () => {
    server.use(http.get(VOICES, () => HttpResponse.json({ voices: [] })));

    const voices = await provider.listVoices(
      config({ voices: [{ id: 'af_bella', name: 'Bella' }] }),
      signal
    );

    expect(voices).toEqual([{ id: 'af_bella', name: 'Bella' }]);
  });

  it('returns an empty list when there is nothing to fall back to', async () => {
    server.use(http.get(VOICES, () => new HttpResponse(null, { status: 404 })));

    await expect(provider.listVoices(config(), signal)).resolves.toEqual([]);
  });

  it('propagates an abort rather than reporting an empty list', async () => {
    server.use(http.get(VOICES, () => HttpResponse.json({ voices: ['af_bella'] })));

    const controller = new AbortController();
    controller.abort();

    await expect(provider.listVoices(config(), controller.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'invalid_api_key', 'invalid-key'],
    [400, 'invalid_request_error', 'unknown'],
    [429, 'rate_limit_exceeded', 'rate-limit'],
    [429, 'insufficient_quota', 'no-quota'],
    [500, undefined, 'service-unavailable'],
    [403, undefined, 'invalid-key'],
    [402, undefined, 'no-quota'],
  ])('maps HTTP %i with code %s to %s', async (status, code, expected) => {
    server.use(
      http.post(SPEECH, () => HttpResponse.json({ error: { message: 'failed', code } }, { status }))
    );

    await expect(
      provider.synthesize({ text: 'Hello.', voiceId: 'alloy', signal }, config())
    ).rejects.toMatchObject({ code: expected });
  });

  it('reads the error type when there is no code', () => {
    const error = mapOpenAiError(400, '{"error":{"type":"invalid_api_key"}}');

    expect(error.code).toBe('invalid-key');
    expect(error.details).toMatchObject({ status: 400, code: 'invalid_api_key' });
  });

  it('ignores a non-JSON body', () => {
    expect(mapOpenAiError(500, 'gateway exploded').code).toBe('service-unavailable');
  });

  it('maps a bare code', () => {
    expect(mapErrorCode('invalid_api_key')).toBe('invalid-key');
    expect(mapErrorCode('insufficient_quota')).toBe('no-quota');
    expect(mapErrorCode('unheard_of')).toBeUndefined();
  });

  it('reports a transport failure as network-error', async () => {
    server.use(http.post(SPEECH, () => HttpResponse.error()));

    await expect(
      provider.synthesize({ text: 'Hello.', voiceId: 'alloy', signal }, config())
    ).rejects.toMatchObject({ code: 'network-error' });
  });

  it('propagates an abort rather than reporting a provider failure', async () => {
    server.use(http.post(SPEECH, () => audioResponse([1])));

    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.synthesize({ text: 'Hello.', voiceId: 'alloy', signal: controller.signal }, config())
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('validate', () => {
  it('resolves when a probe synthesis succeeds', async () => {
    server.use(http.post(SPEECH, () => audioResponse([1])));

    await expect(provider.validate(config(), signal)).resolves.toBeUndefined();
  });

  it('rejects when the key is refused', async () => {
    server.use(
      http.post(SPEECH, () =>
        HttpResponse.json({ error: { code: 'invalid_api_key' } }, { status: 401 })
      )
    );

    await expect(provider.validate(config(), signal)).rejects.toMatchObject({
      code: 'invalid-key',
    });
  });
});
