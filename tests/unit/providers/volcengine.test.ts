// @vitest-environment node
// MSW patches Node's global fetch; happy-dom's fetch is not intercepted.
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { ProviderConfig, VolcengineConfig } from '~/lib/providers/types';
import {
  DEFAULT_BASE_URL,
  DEFAULT_RESOURCE_ID,
  END_CODE,
  mapErrorCode,
  mapVolcengineError,
  supportsTimings,
  VolcengineProvider,
} from '~/lib/providers/volcengine';
import { base64Of, server, useMswServer } from './server';

useMswServer();

const ENDPOINT = `${DEFAULT_BASE_URL}/api/v3/tts/unidirectional`;

const provider = new VolcengineProvider();
const signal = new AbortController().signal;

function config(overrides: Partial<VolcengineConfig> = {}): ProviderConfig {
  return {
    provider: 'volcengine',
    apiKey: 'key-1',
    resourceId: 'seed-tts-1.0',
    ...overrides,
  };
}

/** The service streams one JSON object per line, without an SSE prefix. */
function ndjson(...frames: unknown[]): string {
  return frames.map((frame) => JSON.stringify(frame)).join('\n');
}

/** An audio frame. */
function audio(text: string): unknown {
  return { code: 0, message: '', data: base64Of(text) };
}

/** The verified timing frame: a `sentence` object with seconds-based words. */
function sentence(words: Array<{ word: string; startTime: number; endTime: number }>): unknown {
  return { code: 0, message: '', sentence: { text: '', words } };
}

/** The frame the service ends a stream with (spec §6 V9). */
function end(): unknown {
  return { code: END_CODE, message: '', data: null };
}

describe('capabilities', () => {
  it('reports exact timings for the 1.0 resource', () => {
    expect(provider.capabilities(config({ resourceId: 'seed-tts-1.0' }))).toEqual({
      timings: 'exact',
      maxChars: 1000,
      concurrency: 2,
    });
  });

  it.each(['seed-tts-2.0', 'seed-icl-2.0'] as const)(
    'reports no timings for %s, which returns an empty word list',
    (resourceId) => {
      expect(provider.capabilities(config({ resourceId })).timings).toBe('none');
    }
  );

  it('defaults to the timing-capable resource', () => {
    expect(provider.capabilities({ provider: 'volcengine', apiKey: 'k' })).toMatchObject({
      timings: 'exact',
    });
  });

  it('rejects a config for another provider', () => {
    expect(() => provider.capabilities({ provider: 'browser' })).toThrowError(
      /expected a volcengine/
    );
  });
});

describe('protocol helpers', () => {
  it('supportsTimings only for the 1.0 resource', () => {
    expect(supportsTimings('seed-tts-1.0')).toBe(true);
    expect(supportsTimings('seed-tts-2.0')).toBe(false);
    expect(supportsTimings('seed-icl-2.0')).toBe(false);
  });

  it('maps the documented codes', () => {
    expect(mapErrorCode(45000030)).toBe('service-unavailable');
    expect(mapErrorCode(55000000)).toBe('voice-mismatch');
    expect(mapErrorCode(3003)).toBe('invalid-key');
    expect(mapErrorCode(3004)).toBe('no-quota');
    expect(mapErrorCode(3005)).toBe('rate-limit');
    expect(mapErrorCode(3006)).toBe('service-unavailable');
    expect(mapErrorCode(9999)).toBeUndefined();
  });
});

describe('synthesize', () => {
  it('posts to the v3 unidirectional endpoint with only the new-console headers', async () => {
    let seenUrl: string | undefined;
    let seenHeaders: Headers | undefined;

    server.use(
      http.post(ENDPOINT, ({ request }) => {
        seenUrl = request.url;
        seenHeaders = request.headers;
        return HttpResponse.text(ndjson(audio('AUDIO'), end()));
      })
    );

    await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config({ resourceId: 'seed-tts-2.0' })
    );

    expect(seenUrl).toBe('https://openspeech.bytedance.com/api/v3/tts/unidirectional');
    expect(seenHeaders?.get('x-api-key')).toBe('key-1');
    expect(seenHeaders?.get('x-api-resource-id')).toBe('seed-tts-2.0');
    expect(seenHeaders?.get('content-type')).toContain('application/json');
    expect(seenHeaders?.get('x-api-request-id')).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
    // The old console's credentials are not a supported auth path (spec §2.2),
    // so neither header may be sent.
    expect(seenHeaders?.get('x-api-app-id')).toBeNull();
    expect(seenHeaders?.get('x-api-access-key')).toBeNull();
  });

  it('sends the assumed request body', async () => {
    // assumed: the spike recorded the response but not the request body, so
    // this test pins the shape Phase 4 has to confirm against a live key.
    let seenBody: unknown;

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        seenBody = await request.json();
        return HttpResponse.text(ndjson(audio('AUDIO'), end()));
      })
    );

    await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config({ resourceId: 'seed-tts-1.0' })
    );

    expect(seenBody).toEqual({
      user: { uid: 'sayloud' },
      req_params: {
        text: '你好世界',
        speaker: 'voice-1',
        audio_params: { format: 'mp3', sample_rate: 24000 },
        enable_timestamp: true,
      },
    });
  });

  it('asks for timestamps only on the timing-capable resource', async () => {
    const bodies: Array<{ req_params?: Record<string, unknown> }> = [];

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        bodies.push((await request.json()) as (typeof bodies)[number]);
        return HttpResponse.text(ndjson(audio('AUDIO'), end()));
      })
    );

    await provider.synthesize(
      { text: '你好', voiceId: 'voice-1', signal },
      config({ resourceId: 'seed-tts-1.0' })
    );
    await provider.synthesize(
      { text: '你好', voiceId: 'voice-1', signal },
      config({ resourceId: 'seed-tts-2.0' })
    );

    expect(bodies[0]?.req_params?.enable_timestamp).toBe(true);
    expect(bodies[1]?.req_params).not.toHaveProperty('enable_timestamp');
  });

  it('assembles the audio from the per-line base64 frames', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(ndjson(audio('AUDIO-1'), audio('AUDIO-2'), end()))
      )
    );

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO-1AUDIO-2');
    expect(result.mime).toBe('audio/mpeg');
  });

  it('treats 20000000 as the end frame rather than a failure', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(ndjson(audio('AUDIO'), end()))));

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO');
  });

  it('reads the timings from sentence.words and converts seconds to milliseconds', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          ndjson(
            audio('AUDIO'),
            sentence([
              { word: '你好', startTime: 0, endTime: 0.4 },
              { word: '世界', startTime: 0.4, endTime: 0.9 },
            ]),
            end()
          )
        )
      )
    );

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config()
    );

    expect(result.timings).toEqual([
      { charStart: 0, charEnd: 2, startMs: 0, endMs: 400 },
      { charStart: 2, charEnd: 4, startMs: 400, endMs: 900 },
    ]);
    expect(result.durationMs).toBe(900);
  });

  it('still reads a sentence nested under payload', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          ndjson(
            audio('AUDIO'),
            {
              code: 0,
              payload: { sentence: { words: [{ word: '你好', startTime: 0, endTime: 0.3 }] } },
            },
            end()
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

  it('skips a normalized word and keeps the timings that do line up', async () => {
    // The provider normalized "5" to "five", so that word cannot be placed.
    // Spec §2.1 / V9: skip it rather than discarding the sentence — otherwise
    // every sentence containing a number would lose word-level highlight.
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          ndjson(
            audio('AUDIO'),
            sentence([
              { word: 'It', startTime: 0, endTime: 0.1 },
              { word: 'costs', startTime: 0.1, endTime: 0.3 },
              { word: 'five', startTime: 0.3, endTime: 0.5 },
            ]),
            end()
          )
        )
      )
    );

    const result = await provider.synthesize(
      { text: 'It costs 5.', voiceId: 'voice-1', signal },
      config()
    );

    // "It" [0,2) and "costs" [3,8); "5" is left unhighlighted, never guessed.
    expect(result.timings?.map(({ charStart, charEnd }) => [charStart, charEnd])).toEqual([
      [0, 2],
      [3, 8],
    ]);
  });

  it('returns no timings for a resource whose word list is empty', async () => {
    server.use(
      http.post(ENDPOINT, () => HttpResponse.text(ndjson(audio('AUDIO'), sentence([]), end())))
    );

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config({ resourceId: 'seed-tts-2.0' })
    );

    expect(result.timings).toBeUndefined();
    expect(result.durationMs).toBe(0);
  });

  it('defaults the resource id and the voice', async () => {
    let seenHeaders: Headers | undefined;
    let seenBody: { req_params?: { speaker?: string } } | undefined;

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        seenHeaders = request.headers;
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.text(ndjson(audio('AUDIO'), end()));
      })
    );

    await provider.synthesize(
      { text: '你好', voiceId: '', signal },
      { provider: 'volcengine', apiKey: 'k' }
    );

    expect(seenHeaders?.get('x-api-resource-id')).toBe(DEFAULT_RESOURCE_ID);
    expect(seenBody?.req_params?.speaker).toBe('zh_female_shuangkuaisisi_moon_bigtts');
  });

  it('honours a baseUrl override', async () => {
    server.use(
      http.post('https://proxy.test/api/v3/tts/unidirectional', () =>
        HttpResponse.text(ndjson(audio('AUDIO'), end()))
      )
    );

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'voice-1', signal },
      config({ baseUrl: 'https://proxy.test' })
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO');
  });

  it('parses frames that arrive concatenated without separators', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          `${JSON.stringify(audio('A-'))}${JSON.stringify(audio('B'))}${JSON.stringify(end())}`
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
      http.post(ENDPOINT, () => HttpResponse.text(`{not json\n${JSON.stringify(audio('AUDIO'))}`))
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'voice-1', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO');
  });

  it('rejects a stream with no audio', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(ndjson(end()))));

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'voice-1', signal }, config())
    ).rejects.toMatchObject({ code: 'unknown', message: 'Volcengine returned no audio' });
  });

  it('propagates an abort rather than reporting a provider failure', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(ndjson(audio('AUDIO'), end()))));

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
    [400, 55000000, 'voice-mismatch'],
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

  it('surfaces a voice/resource mismatch as its own code', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          ndjson({
            code: 55000000,
            message: 'resource ID is mismatched with speaker related resource',
          })
        )
      )
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'voice-1', signal }, config())
    ).rejects.toMatchObject({
      code: 'voice-mismatch',
      message: 'resource ID is mismatched with speaker related resource',
    });
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
    server.use(http.post(ENDPOINT, () => HttpResponse.text(ndjson(audio('AUDIO'), end()))));

    await expect(provider.validate(config(), signal)).resolves.toBeUndefined();
  });

  it('rejects when the key is refused', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.json({ code: 3003 }, { status: 401 })));

    await expect(provider.validate(config(), signal)).rejects.toMatchObject({
      code: 'invalid-key',
    });
  });
});

describe('listVoices', () => {
  it('returns the catalogue with the resource timing capability', async () => {
    const voices = await provider.listVoices(config({ resourceId: 'seed-tts-1.0' }), signal);

    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toMatchObject({ lang: 'zh-CN', supportsTimings: true });
    expect(voices.map((voice) => voice.id)).toContain('zh_female_shuangkuaisisi_moon_bigtts');
    expect(voices.map((voice) => voice.id)).toContain('zh_male_wennuanahu_moon_bigtts');
  });

  it('marks voices as timing-less for the 2.0 resources', async () => {
    const voices = await provider.listVoices(config({ resourceId: 'seed-tts-2.0' }), signal);

    expect(voices.every((voice) => voice.supportsTimings === false)).toBe(true);
  });
});
