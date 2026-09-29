// @vitest-environment node
// MSW patches Node's global fetch; happy-dom's fetch is not intercepted.
import { HttpResponse, http } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  DashscopeProvider,
  mapDashscopeError,
  mapErrorCode,
  supportsTimings,
} from '~/lib/providers/dashscope';
import { isProviderError } from '~/lib/providers/errors';
import type { DashscopeConfig, ProviderConfig } from '~/lib/providers/types';
import { base64Of, server, sse, useMswServer } from './server';

useMswServer();

const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const INTL_ENDPOINT =
  'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

const provider = new DashscopeProvider();

function config(overrides: Partial<DashscopeConfig> = {}): ProviderConfig {
  return { provider: 'dashscope', apiKey: 'test-key', model: 'cosyvoice-v3', ...overrides };
}

/** A successful SSE body with two audio chunks and CosyVoice word timings. */
function synthesisBody(): string {
  return sse(
    { request_id: 'r1', output: { audio: { data: base64Of('AUDIO-1') } } },
    {
      request_id: 'r1',
      output: {
        audio: { data: base64Of('-2') },
        sentence: {
          words: [
            { text: '你好', begin_time: 0, end_time: 400 },
            { text: '世界', begin_time: 400, end_time: 900 },
          ],
        },
        finish_reason: 'stop',
      },
    }
  );
}

const signal = new AbortController().signal;

describe('capabilities', () => {
  it('reports exact timings for CosyVoice v3', () => {
    expect(provider.capabilities(config({ model: 'cosyvoice-v3' }))).toEqual({
      timings: 'exact',
      maxChars: 2000,
      concurrency: 2,
    });
  });

  it('reports no timings for earlier revisions', () => {
    expect(provider.capabilities(config({ model: 'cosyvoice-v1' })).timings).toBe('none');
    expect(provider.capabilities(config({ model: 'qwen-tts' })).timings).toBe('none');
  });

  it('defaults to a timing-capable model', () => {
    expect(provider.capabilities({ provider: 'dashscope', apiKey: 'k' })).toMatchObject({
      timings: 'exact',
    });
  });

  it('rejects a config for another provider', () => {
    expect(() => provider.capabilities({ provider: 'browser' })).toThrowError(
      /expected a dashscope/
    );
  });
});

describe('supportsTimings', () => {
  it('accepts v3 and v3.5 only', () => {
    expect(supportsTimings('cosyvoice-v3')).toBe(true);
    expect(supportsTimings('cosyvoice-v3.5')).toBe(true);
    expect(supportsTimings('cosyvoice-v2')).toBe(false);
    expect(supportsTimings('cosyvoice-v1')).toBe(false);
  });
});

describe('synthesize', () => {
  it('concatenates the base64 audio chunks and aligns word timings', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(synthesisBody(), { headers: { 'Content-Type': 'text/event-stream' } })
      )
    );

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'longxiaochun', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO-1-2');
    expect(result.mime).toBe('audio/mpeg');
    expect(result.durationMs).toBe(900);
    expect(result.timings).toEqual([
      { charStart: 0, charEnd: 2, startMs: 0, endMs: 400 },
      { charStart: 2, charEnd: 4, startMs: 400, endMs: 900 },
    ]);
  });

  it('sends the auth, SSE and workspace headers with the documented body', async () => {
    let seenHeaders: Headers | undefined;
    let seenBody: unknown;

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        seenHeaders = request.headers;
        seenBody = await request.json();
        return HttpResponse.text(synthesisBody());
      })
    );

    await provider.synthesize(
      { text: '你好世界', voiceId: 'longxiaochun', signal },
      config({ workspaceId: 'ws-1' })
    );

    expect(seenHeaders?.get('authorization')).toBe('Bearer test-key');
    expect(seenHeaders?.get('x-dashscope-sse')).toBe('enable');
    expect(seenHeaders?.get('x-dashscope-workspace')).toBe('ws-1');
    expect(seenBody).toEqual({
      model: 'cosyvoice-v3',
      input: { text: '你好世界', voice: 'longxiaochun' },
      parameters: { text_type: 'PlainText', format: 'mp3', sample_rate: 22050 },
    });
  });

  it('omits the workspace header when no workspace is configured', async () => {
    let seenHeaders: Headers | undefined;

    server.use(
      http.post(ENDPOINT, ({ request }) => {
        seenHeaders = request.headers;
        return HttpResponse.text(synthesisBody());
      })
    );

    await provider.synthesize({ text: '你好', voiceId: 'longxiaochun', signal }, config());

    expect(seenHeaders?.get('x-dashscope-workspace')).toBeNull();
  });

  it('uses the international host for the intl region', async () => {
    server.use(http.post(INTL_ENDPOINT, () => HttpResponse.text(synthesisBody())));

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'longxiaochun', signal },
      config({ region: 'intl' })
    );

    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  it('falls back to the default voice when none is given', async () => {
    let seenBody: { input?: { voice?: string } } | undefined;

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        seenBody = (await request.json()) as typeof seenBody;
        return HttpResponse.text(synthesisBody());
      })
    );

    await provider.synthesize({ text: '你好', voiceId: '', signal }, config());

    expect(seenBody?.input?.voice).toBe('longxiaochun');
  });

  it('omits timings for a model that does not report them', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(sse({ output: { audio: { data: base64Of('AUDIO') } } }))
      )
    );

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'longxiaochun', signal },
      config({ model: 'cosyvoice-v1' })
    );

    expect(result.timings).toBeUndefined();
    expect(result.durationMs).toBe(0);
  });

  it('drops timings the sentence cannot support instead of guessing', async () => {
    // The words were normalized upstream, so they do not appear in the text.
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          sse({
            output: {
              audio: { data: base64Of('AUDIO') },
              sentence: { words: [{ text: 'five', begin_time: 0, end_time: 400 }] },
            },
          })
        )
      )
    );

    const result = await provider.synthesize(
      { text: 'It costs 5.', voiceId: 'longxiaochun', signal },
      config()
    );

    expect(result.timings).toBeUndefined();
  });

  it('ignores non-JSON and keep-alive frames without losing the audio', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          sse(
            ': keep-alive',
            'not json at all',
            { output: { audio: { data: base64Of('AUDIO') } } },
            '[DONE]'
          )
        )
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'longxiaochun', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO');
  });

  it('downloads the audio when the model answers with a URL instead of chunks', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(sse({ output: { audio: { url: 'https://cdn.test/out.mp3' } } }))
      ),
      http.get('https://cdn.test/out.mp3', () =>
        HttpResponse.text('URL-AUDIO', {
          headers: { 'Content-Type': 'audio/mpeg; charset=binary' },
        })
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'longxiaochun', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('URL-AUDIO');
    expect(result.mime).toBe('audio/mpeg');
  });

  it('maps a failed audio download', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(sse({ output: { audio: { url: 'https://cdn.test/out.mp3' } } }))
      ),
      http.get('https://cdn.test/out.mp3', () => new HttpResponse(null, { status: 403 }))
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longxiaochun', signal }, config())
    ).rejects.toMatchObject({ code: 'service-unavailable' });
  });

  it('rejects a response that carries no audio at all', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(sse({ output: {} }))));

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longxiaochun', signal }, config())
    ).rejects.toMatchObject({ code: 'unknown', message: 'DashScope returned no audio' });
  });

  it('propagates an abort rather than reporting a provider failure', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(synthesisBody())));

    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.synthesize(
        { text: '你好', voiceId: 'longxiaochun', signal: controller.signal },
        config()
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'InvalidApiKey', 'invalid-key'],
    [403, 'AuthenticationError', 'invalid-key'],
    [400, 'ModelNotOpen', 'service-unavailable'],
    [500, 'InternalError', 'service-unavailable'],
    [429, 'Throttling.RateQuota', 'rate-limit'],
    [402, 'Arrearage', 'no-quota'],
    [400, 'SomethingNew', 'unknown'],
  ])('maps HTTP %i with code %s to %s', async (status, code, expected) => {
    server.use(
      http.post(ENDPOINT, () => HttpResponse.json({ code, message: `failed: ${code}` }, { status }))
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longxiaochun', signal }, config())
    ).rejects.toMatchObject({ code: expected, message: `failed: ${code}` });
  });

  it('falls back to the status when the body has no code', async () => {
    server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 503 })));

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longxiaochun', signal }, config())
    ).rejects.toMatchObject({ code: 'service-unavailable' });
  });

  it('reads a code nested under error', () => {
    const error = mapDashscopeError(400, '{"error":{"code":"ModelNotAvailable"}}');

    expect(error.code).toBe('service-unavailable');
    expect(error.details).toMatchObject({ status: 400, code: 'ModelNotAvailable' });
  });

  it('ignores a non-JSON body', () => {
    expect(mapDashscopeError(500, 'gateway exploded').code).toBe('service-unavailable');
  });

  it('maps a bare code', () => {
    expect(mapErrorCode('InvalidApiKey')).toBe('invalid-key');
    expect(mapErrorCode('Throttling.RateQuota')).toBe('rate-limit');
    expect(mapErrorCode('Unheard')).toBeUndefined();
  });

  it('surfaces an error event delivered inside an HTTP 200 stream', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(sse({ code: 'ModelNotOpen', message: 'model not activated' }))
      )
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longxiaochun', signal }, config())
    ).rejects.toMatchObject({ code: 'service-unavailable', message: 'model not activated' });
  });

  it('reports an unrecognized in-stream error code as unknown', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(sse({ code: 'BrandNewFailure' }))));

    const error = await provider
      .synthesize({ text: '你好', voiceId: 'longxiaochun', signal }, config())
      .catch((caught: unknown) => caught);

    expect(isProviderError(error)).toBe(true);
    expect(error).toMatchObject({
      code: 'unknown',
      message: 'DashScope error BrandNewFailure',
    });
  });

  it('reports a transport failure as network-error', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.error()));

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longxiaochun', signal }, config())
    ).rejects.toMatchObject({ code: 'network-error' });
  });
});

describe('validate', () => {
  it('resolves when a probe synthesis succeeds', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(synthesisBody())));

    await expect(provider.validate(config(), signal)).resolves.toBeUndefined();
  });

  it('rejects when the key is refused', async () => {
    server.use(
      http.post(ENDPOINT, () => HttpResponse.json({ code: 'InvalidApiKey' }, { status: 401 }))
    );

    await expect(provider.validate(config(), signal)).rejects.toMatchObject({
      code: 'invalid-key',
    });
  });
});

describe('listVoices', () => {
  it('returns the catalogue with the model timing capability', async () => {
    const voices = await provider.listVoices(config({ model: 'cosyvoice-v3' }), signal);

    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toMatchObject({ id: 'longxiaochun', lang: 'zh-CN', supportsTimings: true });
    expect(voices.every((voice) => voice.supportsTimings === true)).toBe(true);
  });

  it('marks voices as timing-less for an older model', async () => {
    const voices = await provider.listVoices(config({ model: 'cosyvoice-v1' }), signal);

    expect(voices.every((voice) => voice.supportsTimings === false)).toBe(true);
  });
});
