// @vitest-environment node
// MSW patches Node's global fetch; happy-dom's fetch is not intercepted.
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig, VolcengineConfig } from '~/lib/providers/types';
import {
  EVENT_SENTENCE_END,
  EVENT_SESSION_END,
  isSentenceEnd,
  mapErrorCode,
  mapVolcengineError,
  supportsTimings,
  VolcengineProvider,
} from '~/lib/providers/volcengine';
import { base64Of, server, useMswServer } from './server';

useMswServer();

const ENDPOINT = 'https://openspeech.bytedance.com/api/v1/tts';

const provider = new VolcengineProvider();
const signal = new AbortController().signal;

function config(overrides: Partial<VolcengineConfig> = {}): ProviderConfig {
  return {
    provider: 'volcengine',
    appId: 'app-1',
    accessToken: 'token-1',
    model: 'tts-1.0',
    ...overrides,
  };
}

/** The service streams one JSON object per frame. */
function ndjson(...frames: unknown[]): string {
  return frames.map((frame) => JSON.stringify(frame)).join('\n');
}

/** A stream with two audio frames and a sentence-end frame carrying timings. */
function streamBody(): string {
  return ndjson(
    { code: 3000, data: base64Of('AUDIO-1'), sequence: 1 },
    {
      code: 3000,
      event: EVENT_SENTENCE_END,
      payload: {
        word_list: [
          { text: '你好', start_time: 0, end_time: 0.4 },
          { text: '世界', start_time: 0.4, end_time: 0.9 },
        ],
      },
      sequence: 2,
    },
    { code: 3000, event: EVENT_SESSION_END, sequence: 3 }
  );
}

describe('capabilities', () => {
  it('reports exact timings for TTS 1.0', () => {
    expect(provider.capabilities(config({ model: 'tts-1.0' }))).toEqual({
      timings: 'exact',
      maxChars: 1000,
      concurrency: 2,
    });
  });

  it('reports no timings for TTS 2.0', () => {
    expect(provider.capabilities(config({ model: 'tts-2.0' })).timings).toBe('none');
  });

  it('defaults to the timing-capable model', () => {
    expect(
      provider.capabilities({ provider: 'volcengine', appId: 'a', accessToken: 't' })
    ).toMatchObject({ timings: 'exact' });
  });

  it('rejects a config for another provider', () => {
    expect(() => provider.capabilities({ provider: 'browser' })).toThrowError(
      /expected a volcengine/
    );
  });
});

describe('protocol helpers', () => {
  it('supportsTimings only for 1.0', () => {
    expect(supportsTimings('tts-1.0')).toBe(true);
    expect(supportsTimings('tts-2.0')).toBe(false);
  });

  it('recognizes the sentence-end event by code or name', () => {
    expect(isSentenceEnd(EVENT_SENTENCE_END)).toBe(true);
    expect(isSentenceEnd('TTSSentenceEnd')).toBe(true);
    expect(isSentenceEnd(EVENT_SESSION_END)).toBe(false);
    expect(isSentenceEnd(undefined)).toBe(false);
  });

  it('maps the documented codes', () => {
    expect(mapErrorCode(45000030)).toBe('service-unavailable');
    expect(mapErrorCode(3003)).toBe('invalid-key');
    expect(mapErrorCode(3004)).toBe('no-quota');
    expect(mapErrorCode(3005)).toBe('rate-limit');
    expect(mapErrorCode(3006)).toBe('service-unavailable');
    expect(mapErrorCode(9999)).toBeUndefined();
  });
});

describe('synthesize', () => {
  it('concatenates the audio frames and aligns the sentence-end timings', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(streamBody())));

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'zh_female_shuangkuaisisi_moon_bigtts', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO-1');
    expect(result.mime).toBe('audio/mpeg');
    expect(result.durationMs).toBe(900);
    expect(result.timings).toEqual([
      { charStart: 0, charEnd: 2, startMs: 0, endMs: 400 },
      { charStart: 2, charEnd: 4, startMs: 400, endMs: 900 },
    ]);
  });

  it('sends the documented headers and body', async () => {
    let seenHeaders: Headers | undefined;
    let seenBody: unknown;

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        seenHeaders = request.headers;
        seenBody = await request.json();
        return HttpResponse.text(streamBody());
      })
    );

    await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config({ resourceId: 'volc.custom' })
    );

    expect(seenHeaders?.get('x-api-app-id')).toBe('app-1');
    expect(seenHeaders?.get('x-api-key')).toBe('token-1');
    expect(seenHeaders?.get('x-api-access-key')).toBe('token-1');
    expect(seenHeaders?.get('x-api-resource-id')).toBe('volc.custom');
    expect(seenHeaders?.get('x-api-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    expect(seenBody).toEqual({
      user: { uid: 'sayloud' },
      req_params: {
        text: '你好世界',
        speaker: 'voice-1',
        model: 'tts-1.0',
        audio_params: { format: 'mp3', sample_rate: 24000 },
      },
    });
  });

  it('defaults the resource id and voice', async () => {
    let seenHeaders: Headers | undefined;
    let seenBody: { req_params?: { speaker?: string } } | undefined;

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        seenHeaders = request.headers;
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.text(streamBody());
      })
    );

    await provider.synthesize({ text: '你好', voiceId: '', signal }, config());

    expect(seenHeaders?.get('x-api-resource-id')).toBe('volc.service_type.10029');
    expect(seenBody?.req_params?.speaker).toBe('zh_female_shuangkuaisisi_moon_bigtts');
  });

  it('honours a baseUrl override', async () => {
    server.use(http.post('https://proxy.test/api/v1/tts', () => HttpResponse.text(streamBody())));

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config({ baseUrl: 'https://proxy.test' })
    );

    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  it('omits timings for TTS 2.0', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(ndjson({ code: 0, data: base64Of('AUDIO'), sequence: 1 }))
      )
    );

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config({ model: 'tts-2.0' })
    );

    expect(result.timings).toBeUndefined();
    expect(result.durationMs).toBe(0);
  });

  it('reads millisecond fields when the service sends them', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          ndjson(
            { code: 0, data: base64Of('AUDIO') },
            {
              code: 0,
              event: EVENT_SENTENCE_END,
              payload: { words: [{ word: '你好', start_ms: 0, end_ms: 250 }] },
            }
          )
        )
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'voice-1', signal },
      config()
    );

    expect(result.timings).toEqual([{ charStart: 0, charEnd: 2, startMs: 0, endMs: 250 }]);
  });

  it('reads words from the frame root as well as from payload', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          ndjson(
            { code: 0, data: base64Of('AUDIO') },
            {
              code: 0,
              event: EVENT_SENTENCE_END,
              words: [{ text: '你好', start_ms: 0, end_ms: 300 }],
            }
          )
        )
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'voice-1', signal },
      config()
    );

    expect(result.timings).toEqual([{ charStart: 0, charEnd: 2, startMs: 0, endMs: 300 }]);
  });

  it('accepts the symbolic sentence-end event name', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          ndjson(
            { code: 0, data: base64Of('AUDIO') },
            {
              code: 0,
              event: 'TTSSentenceEnd',
              payload: { word_list: [{ text: '你好', start_ms: 0, end_ms: 300 }] },
            }
          )
        )
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'voice-1', signal },
      config()
    );

    expect(result.timings).toHaveLength(1);
  });

  it('parses frames that arrive concatenated without separators', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          `${JSON.stringify({ code: 0, data: base64Of('A-') })}${JSON.stringify({
            code: 0,
            data: base64Of('B'),
          })}`
        )
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'voice-1', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('A-B');
  });

  it('skips a malformed frame without discarding the audio', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(`{not json\n${JSON.stringify({ code: 0, data: base64Of('AUDIO') })}`)
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'voice-1', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO');
  });

  it('drops timings the sentence cannot support instead of guessing', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          ndjson(
            { code: 0, data: base64Of('AUDIO') },
            {
              code: 0,
              event: EVENT_SENTENCE_END,
              payload: { word_list: [{ text: 'five', start_ms: 0, end_ms: 400 }] },
            }
          )
        )
      )
    );

    const result = await provider.synthesize(
      { text: 'It costs 5.', voiceId: 'voice-1', signal },
      config()
    );

    expect(result.timings).toBeUndefined();
  });

  it('rejects a stream with no audio', async () => {
    server.use(
      http.post(ENDPOINT, () => HttpResponse.text(ndjson({ code: 0, event: EVENT_SESSION_END })))
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'voice-1', signal }, config())
    ).rejects.toMatchObject({ code: 'unknown', message: 'Volcengine returned no audio' });
  });

  it('propagates an abort rather than reporting a provider failure', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(streamBody())));

    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'voice-1', signal: controller.signal }, config())
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('error mapping', () => {
  it.each([
    [401, undefined, 'invalid-key'],
    [403, undefined, 'invalid-key'],
    [400, 45000030, 'service-unavailable'],
    [500, 3006, 'service-unavailable'],
    [429, 3005, 'rate-limit'],
    [402, 3004, 'no-quota'],
    [400, 3002, 'unknown'],
    [400, 9999, 'unknown'],
  ])('maps HTTP %i with code %s to %s', async (status, code, expected) => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.json({ code, message: `failed: ${code ?? status}` }, { status })
      )
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'voice-1', signal }, config())
    ).rejects.toMatchObject({ code: expected });
  });

  it('falls back to the status when the body carries no code', async () => {
    server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 503 })));

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'voice-1', signal }, config())
    ).rejects.toMatchObject({ code: 'service-unavailable' });
  });

  it('reads the legacy StatusCode field', () => {
    const error = mapVolcengineError(400, '{"StatusCode":45000030,"Message":"not activated"}');

    expect(error.code).toBe('service-unavailable');
    expect(error.message).toBe('not activated');
    expect(error.details).toMatchObject({ status: 400, code: 45000030 });
  });

  it('ignores a non-JSON body', () => {
    expect(mapVolcengineError(500, 'gateway exploded').code).toBe('service-unavailable');
  });

  it('surfaces a failure frame delivered inside an HTTP 200 stream', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(ndjson({ code: 45000030, message: 'service not activated' }))
      )
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'voice-1', signal }, config())
    ).rejects.toMatchObject({ code: 'service-unavailable', message: 'service not activated' });
  });

  it('reports an unrecognized in-stream code as unknown', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(ndjson({ code: 424242 }))));

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'voice-1', signal }, config())
    ).rejects.toMatchObject({ code: 'unknown', message: 'Volcengine error 424242' });
  });

  it('reports a transport failure as network-error', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.error()));

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'voice-1', signal }, config())
    ).rejects.toMatchObject({ code: 'network-error' });
  });
});

describe('validate', () => {
  it('resolves when a probe synthesis succeeds', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(streamBody())));

    await expect(provider.validate(config(), signal)).resolves.toBeUndefined();
  });

  it('rejects when the token is refused', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.json({ code: 3003 }, { status: 401 })));

    await expect(provider.validate(config(), signal)).rejects.toMatchObject({
      code: 'invalid-key',
    });
  });
});

describe('listVoices', () => {
  it('returns the catalogue with the model timing capability', async () => {
    const voices = await provider.listVoices(config({ model: 'tts-1.0' }), signal);

    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toMatchObject({ lang: 'zh-CN', supportsTimings: true });
  });

  it('marks voices as timing-less for TTS 2.0', async () => {
    const voices = await provider.listVoices(config({ model: 'tts-2.0' }), signal);

    expect(voices.every((voice) => voice.supportsTimings === false)).toBe(true);
  });
});
