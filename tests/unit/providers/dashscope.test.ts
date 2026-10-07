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
import { base64Of, server, useMswServer } from './server';

useMswServer();

const ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const INTL_ENDPOINT =
  'https://dashscope-intl.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';
const WORKSPACE_ENDPOINT =
  'https://ws-1.cn-beijing.maas.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer';

const provider = new DashscopeProvider();

function config(overrides: Partial<DashscopeConfig> = {}): ProviderConfig {
  return { provider: 'dashscope', apiKey: 'test-key', model: 'cosyvoice-v3-flash', ...overrides };
}

/**
 * One SSE frame in the framing the service sends: `id:` and `event:` lines, a
 * `:HTTP_STATUS` comment, the JSON payload, then the blank line that ends the
 * frame.
 */
function frame(event: string, payload: unknown): string {
  return `id:1\nevent:${event}\n:HTTP_STATUS/200\ndata:${JSON.stringify(payload)}\n\n`;
}

/** A word entry in the shape the service sends. */
function word(text: string, ordinal: number, startMs: number, endMs: number): unknown {
  return {
    text,
    begin_index: ordinal,
    end_index: ordinal,
    begin_time: startMs,
    end_time: endMs,
  };
}

/** A successful stream: two audio chunks and the CosyVoice word frame. */
function synthesisBody(): string {
  return (
    frame('sentence-begin', { request_id: 'r1', output: { sentence: { index: 0 } } }) +
    frame('sentence-synthesis', {
      request_id: 'r1',
      output: {
        audio: { data: base64Of('AUDIO-1') },
        sentence: { index: 0, words: [word('你好', 0, 0, 400)] },
      },
    }) +
    frame('sentence-synthesis', {
      request_id: 'r1',
      output: {
        audio: { data: base64Of('-2') },
        sentence: { index: 0, words: [word('世界', 1, 400, 900)] },
      },
    }) +
    frame('sentence-end', {
      request_id: 'r1',
      output: { sentence: { index: 0 }, finish_reason: 'stop' },
    })
  );
}

const signal = new AbortController().signal;

describe('capabilities', () => {
  it('reports exact timings and the 200-character cap for CosyVoice v3', () => {
    expect(provider.capabilities(config({ model: 'cosyvoice-v3-flash' }))).toEqual({
      timings: 'exact',
      maxChars: 200,
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
  it('accepts every v3 revision that reports timings', () => {
    // cosyvoice-v3-flash and cosyvoice-v3-plus report timings, and so does v3.5.
    expect(supportsTimings('cosyvoice-v3-flash')).toBe(true);
    expect(supportsTimings('cosyvoice-v3-plus')).toBe(true);
    expect(supportsTimings('cosyvoice-v3')).toBe(true);
    expect(supportsTimings('cosyvoice-v3.5-flash')).toBe(true);
  });

  it('rejects everything else, including the Qwen models', () => {
    expect(supportsTimings('cosyvoice-v2')).toBe(false);
    expect(supportsTimings('cosyvoice-v1')).toBe(false);
    expect(supportsTimings('qwen3-tts-flash')).toBe(false);
    expect(supportsTimings('qwen-audio-3.0-tts-flash')).toBe(false);
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
      { text: '你好世界', voiceId: 'longanyang', signal },
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
      http.post(WORKSPACE_ENDPOINT, async ({ request }) => {
        seenHeaders = request.headers;
        seenBody = await request.json();
        return HttpResponse.text(synthesisBody());
      })
    );

    await provider.synthesize(
      { text: '你好世界', voiceId: 'longanyang', signal },
      config({ workspaceId: 'ws-1' })
    );

    expect(seenHeaders?.get('authorization')).toBe('Bearer test-key');
    expect(seenHeaders?.get('x-dashscope-sse')).toBe('enable');
    expect(seenHeaders?.get('x-dashscope-workspace')).toBe('ws-1');
    expect(seenBody).toEqual({
      model: 'cosyvoice-v3-flash',
      input: { text: '你好世界', voice: 'longanyang' },
      parameters: {
        text_type: 'PlainText',
        format: 'mp3',
        sample_rate: 22050,
        word_timestamp_enabled: true,
      },
    });
  });

  it('uses the workspace-scoped host when a workspace id is set', async () => {
    server.use(http.post(WORKSPACE_ENDPOINT, () => HttpResponse.text(synthesisBody())));

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'longanyang', signal },
      config({ workspaceId: 'ws-1' })
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO-1-2');
  });

  it('omits the workspace header when no workspace is configured', async () => {
    let seenHeaders: Headers | undefined;

    server.use(
      http.post(ENDPOINT, ({ request }) => {
        seenHeaders = request.headers;
        return HttpResponse.text(synthesisBody());
      })
    );

    await provider.synthesize({ text: '你好', voiceId: 'longanyang', signal }, config());

    expect(seenHeaders?.get('x-dashscope-workspace')).toBeNull();
  });

  it('uses the international host for the ap-southeast-1 region', async () => {
    server.use(http.post(INTL_ENDPOINT, () => HttpResponse.text(synthesisBody())));

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'longanyang', signal },
      config({ region: 'ap-southeast-1' })
    );

    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  it('lets an explicit base URL override both hosts', async () => {
    server.use(
      http.post('https://proxy.test/api/v1/services/audio/tts/SpeechSynthesizer', () =>
        HttpResponse.text(synthesisBody())
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'longanyang', signal },
      config({ workspaceId: 'ws-1', baseUrl: 'https://proxy.test' })
    );

    expect(result.audio.byteLength).toBeGreaterThan(0);
  });

  it('sends word_timestamp_enabled only for a model that reports timings', async () => {
    const bodies: Array<{ parameters?: Record<string, unknown> }> = [];

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        bodies.push((await request.json()) as (typeof bodies)[number]);
        return HttpResponse.text(synthesisBody());
      })
    );

    await provider.synthesize(
      { text: '你好世界', voiceId: 'longanyang', signal },
      config({ model: 'cosyvoice-v3-flash' })
    );
    await provider.synthesize(
      { text: '你好世界', voiceId: 'longxiaochun', signal },
      config({ model: 'cosyvoice-v1' })
    );

    // Without the flag the service never sends the word frame.
    expect(bodies[0]?.parameters?.word_timestamp_enabled).toBe(true);
    expect(bodies[1]?.parameters).not.toHaveProperty('word_timestamp_enabled');
  });

  it('falls back to the voice that matches the configured model', async () => {
    const voices: Array<string | undefined> = [];

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { input?: { voice?: string } };
        voices.push(body.input?.voice);
        return HttpResponse.text(synthesisBody());
      })
    );

    await provider.synthesize({ text: '你好', voiceId: '', signal }, config());
    await provider.synthesize(
      { text: '你好', voiceId: '', signal },
      config({ model: 'cosyvoice-v1' })
    );

    expect(voices).toEqual(['longanyang', 'longxiaochun']);
  });

  it('aligns words by ordinal, not by reading begin_index as a character offset', async () => {
    // begin_index is a word ordinal and an English word keeps its leading
    // space. Treated as offsets these ordinals would produce spans at 0/1/2/3.
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          frame('sentence-synthesis', {
            output: {
              audio: { data: base64Of('AUDIO') },
              sentence: {
                index: 0,
                words: [
                  word('The', 0, 0, 300),
                  word(' quick', 1, 300, 700),
                  word('brown', 2, 700, 1100),
                  word('fox', 3, 1100, 1400),
                ],
              },
            },
          })
        )
      )
    );

    const result = await provider.synthesize(
      { text: 'The quick brown fox', voiceId: 'longanyang', signal },
      config()
    );

    expect(result.timings).toEqual([
      { charStart: 0, charEnd: 3, startMs: 0, endMs: 300 },
      { charStart: 4, charEnd: 9, startMs: 300, endMs: 700 },
      { charStart: 10, charEnd: 15, startMs: 700, endMs: 1100 },
      { charStart: 16, charEnd: 19, startMs: 1100, endMs: 1400 },
    ]);
  });

  it('skips a normalized word and keeps the words around it aligned', async () => {
    // The service reads "1.27" as "一点二七", so those words do not appear
    // in the sentence. They are skipped, not estimated, and the rest still line
    // up.
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          frame('sentence-synthesis', {
            output: {
              audio: { data: base64Of('AUDIO') },
              sentence: {
                index: 0,
                words: [
                  word('It', 0, 0, 200),
                  word('costs', 1, 200, 600),
                  word('一', 2, 600, 700),
                  word('点', 3, 700, 800),
                  word('二', 4, 800, 900),
                  word('七', 5, 900, 1000),
                  word('yuan', 6, 1000, 1300),
                ],
              },
            },
          })
        )
      )
    );

    const result = await provider.synthesize(
      { text: 'It costs 1.27 yuan', voiceId: 'longanyang', signal },
      config()
    );

    expect(result.timings).toEqual([
      { charStart: 0, charEnd: 2, startMs: 0, endMs: 200 },
      { charStart: 3, charEnd: 8, startMs: 200, endMs: 600 },
      { charStart: 14, charEnd: 18, startMs: 1000, endMs: 1300 },
    ]);
  });

  it('merges two sentences and drops the word repeated across the frame boundary', async () => {
    // The service splits sentences itself and repeats words as it
    // delivers them incrementally, so the stream is de-duplicated on
    // (sentence.index, begin_index) and the two sentences' words are
    // concatenated in order. Ordinals restart at 0 for the second sentence, so
    // the sentence index has to be part of the key.
    const body =
      frame('sentence-synthesis', {
        output: {
          audio: { data: base64Of('AUDIO') },
          sentence: { index: 0, words: [word('好', 0, 0, 300), word('的', 1, 300, 600)] },
        },
      }) +
      // The same word again in the next frame — a duplicate, not a new word.
      frame('sentence-synthesis', {
        output: { sentence: { index: 0, words: [word('的', 1, 300, 600)] } },
      }) +
      frame('sentence-synthesis', {
        output: {
          audio: { data: base64Of('-2') },
          sentence: {
            index: 1,
            words: [word('好', 0, 600, 900), word('的', 1, 900, 1200), word('再见', 2, 1200, 1600)],
          },
        },
      });

    server.use(http.post(ENDPOINT, () => HttpResponse.text(body)));

    const result = await provider.synthesize(
      { text: '好的好的再见', voiceId: 'longanyang', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO-2');
    expect(result.timings).toEqual([
      { charStart: 0, charEnd: 1, startMs: 0, endMs: 300 },
      { charStart: 1, charEnd: 2, startMs: 300, endMs: 600 },
      { charStart: 2, charEnd: 3, startMs: 600, endMs: 900 },
      { charStart: 3, charEnd: 4, startMs: 900, endMs: 1200 },
      { charStart: 4, charEnd: 6, startMs: 1200, endMs: 1600 },
    ]);
  });

  it('tolerates the `original_text` alias for a word', async () => {
    // `original_text` appears in the stream but not on a fixed object, so it is
    // accepted as a last alias rather than required.
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          frame('sentence-synthesis', {
            output: {
              audio: { data: base64Of('AUDIO') },
              sentence: {
                index: 0,
                words: [{ original_text: '你好', begin_index: 0, begin_time: 0, end_time: 400 }],
              },
            },
          })
        )
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'longanyang', signal },
      config()
    );

    expect(result.timings).toEqual([{ charStart: 0, charEnd: 2, startMs: 0, endMs: 400 }]);
  });

  it('omits timings for a model that does not report them', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          frame('sentence-synthesis', { output: { audio: { data: base64Of('AUDIO') } } })
        )
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
    // Every word was normalized upstream, so none of them appear in the text.
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          frame('sentence-synthesis', {
            output: {
              audio: { data: base64Of('AUDIO') },
              sentence: { index: 0, words: [word('five', 0, 0, 400)] },
            },
          })
        )
      )
    );

    const result = await provider.synthesize(
      { text: 'It costs 5.', voiceId: 'longanyang', signal },
      config()
    );

    expect(result.timings).toBeUndefined();
  });

  it('ignores non-JSON and keep-alive frames without losing the audio', async () => {
    const body = [
      ': keep-alive',
      '',
      'not json at all',
      '',
      frame('sentence-synthesis', { output: { audio: { data: base64Of('AUDIO') } } }),
      'data: [DONE]',
      '',
    ].join('\n');

    server.use(http.post(ENDPOINT, () => HttpResponse.text(body)));

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'longanyang', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('AUDIO');
  });

  it('downloads the audio when the model answers with a URL instead of chunks', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          frame('sentence-synthesis', { output: { audio: { url: 'https://cdn.test/out.mp3' } } })
        )
      ),
      http.get('https://cdn.test/out.mp3', () =>
        HttpResponse.text('URL-AUDIO', {
          headers: { 'Content-Type': 'audio/mpeg; charset=binary' },
        })
      )
    );

    const result = await provider.synthesize(
      { text: '你好', voiceId: 'longanyang', signal },
      config()
    );

    expect(new TextDecoder().decode(result.audio)).toBe('URL-AUDIO');
    expect(result.mime).toBe('audio/mpeg');
  });

  it('returns the streamed WAV chunks of qwen3-tts-flash without timings', async () => {
    // qwen3-tts-flash streams WAV chunks and puts a download url on its
    // last frame, and reports no timings at all. The chunks win over the url,
    // so no second request is made (an unhandled one would fail this test).
    const body =
      frame('sentence-synthesis', { output: { audio: { data: base64Of('RIFF-1') } } }) +
      frame('sentence-synthesis', { output: { audio: { data: base64Of('-2') } } }) +
      frame('sentence-end', {
        output: { audio: { url: 'https://cdn.test/out.wav' }, sentence: { index: 0 } },
      });

    server.use(http.post(ENDPOINT, () => HttpResponse.text(body)));

    const result = await provider.synthesize(
      { text: '你好世界', voiceId: 'Cherry', signal },
      config({ model: 'qwen3-tts-flash' })
    );

    expect(new TextDecoder().decode(result.audio)).toBe('RIFF-1-2');
    expect(result.timings).toBeUndefined();
    expect(result.durationMs).toBe(0);
  });

  it('maps a failed audio download', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(
          frame('sentence-synthesis', { output: { audio: { url: 'https://cdn.test/out.mp3' } } })
        )
      ),
      http.get('https://cdn.test/out.mp3', () => new HttpResponse(null, { status: 403 }))
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longanyang', signal }, config())
    ).rejects.toMatchObject({ code: 'service-unavailable' });
  });

  it('rejects a response that carries no audio at all', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(frame('sentence-end', { output: {} }))));

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longanyang', signal }, config())
    ).rejects.toMatchObject({ code: 'unknown', message: 'DashScope returned no audio' });
  });

  it('propagates an abort rather than reporting a provider failure', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(synthesisBody())));

    const controller = new AbortController();
    controller.abort();

    await expect(
      provider.synthesize(
        { text: '你好', voiceId: 'longanyang', signal: controller.signal },
        config()
      )
    ).rejects.toMatchObject({ name: 'AbortError' });
  });
});

describe('error mapping', () => {
  it.each([
    [401, 'InvalidApiKey', 'invalid-key'],
    [403, 'AuthenticationError', 'invalid-key'],
    [400, 'ModelNotOpen', 'not-activated'],
    [500, 'InternalError', 'service-unavailable'],
    [429, 'Throttling.RateQuota', 'rate-limit'],
    [402, 'Arrearage', 'no-quota'],
    [400, 'SomethingNew', 'unknown'],
  ])('maps HTTP %i with code %s to %s', async (status, code, expected) => {
    server.use(
      http.post(ENDPOINT, () => HttpResponse.json({ code, message: `failed: ${code}` }, { status }))
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longanyang', signal }, config())
    ).rejects.toMatchObject({ code: expected, message: `failed: ${code}` });
  });

  it('falls back to the status when the body has no code', async () => {
    server.use(http.post(ENDPOINT, () => new HttpResponse(null, { status: 503 })));

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longanyang', signal }, config())
    ).rejects.toMatchObject({ code: 'service-unavailable' });
  });

  it('reads a code nested under error', () => {
    const error = mapDashscopeError(400, '{"error":{"code":"ModelNotAvailable"}}');

    expect(error.code).toBe('not-activated');
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
        HttpResponse.text(
          frame('sentence-end', { code: 'ModelNotOpen', message: 'model not activated' })
        )
      )
    );

    await expect(
      provider.synthesize({ text: '你好', voiceId: 'longanyang', signal }, config())
    ).rejects.toMatchObject({ code: 'not-activated', message: 'model not activated' });
  });

  it('reports an unrecognized in-stream error code as unknown', async () => {
    server.use(
      http.post(ENDPOINT, () =>
        HttpResponse.text(frame('sentence-end', { code: 'BrandNewFailure' }))
      )
    );

    const error = await provider
      .synthesize({ text: '你好', voiceId: 'longanyang', signal }, config())
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
      provider.synthesize({ text: '你好', voiceId: 'longanyang', signal }, config())
    ).rejects.toMatchObject({ code: 'network-error' });
  });
});

describe('validate', () => {
  it('resolves when a probe synthesis succeeds', async () => {
    server.use(http.post(ENDPOINT, () => HttpResponse.text(synthesisBody())));

    await expect(provider.validate(config(), signal)).resolves.toBeUndefined();
  });

  it('probes with a voice that belongs to the configured model', async () => {
    const voices: Array<string | undefined> = [];

    server.use(
      http.post(ENDPOINT, async ({ request }) => {
        const body = (await request.json()) as { input?: { voice?: string } };
        voices.push(body.input?.voice);
        return HttpResponse.text(synthesisBody());
      })
    );

    await provider.validate(config(), signal);
    await provider.validate(config({ model: 'cosyvoice-v1' }), signal);

    // A v1 voice on a v3 model is a mismatch, and the service answers 400.
    expect(voices).toEqual(['longanyang', 'longxiaochun']);
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
  it('offers the v3 catalogue, with timings, for a v3 model', async () => {
    const voices = await provider.listVoices(config({ model: 'cosyvoice-v3-flash' }), signal);

    // This is the one voice the v3 catalogue returns for this model.
    expect(voices).toEqual([
      { id: 'longanyang', name: 'longanyang', lang: 'zh-CN', supportsTimings: true },
    ]);
  });

  it('offers the v1/v2 catalogue, without timings, for an older model', async () => {
    const voices = await provider.listVoices(config({ model: 'cosyvoice-v1' }), signal);

    expect(voices.length).toBeGreaterThan(0);
    expect(voices[0]).toMatchObject({ id: 'longxiaochun', lang: 'zh-CN', supportsTimings: false });
    expect(voices.every((voice) => voice.supportsTimings === false)).toBe(true);
  });

  it('offers no system voice for v3.5, which rejects them', async () => {
    // cosyvoice-v3.5-flash + a system voice answers 400 (code 418).
    expect(await provider.listVoices(config({ model: 'cosyvoice-v3.5-flash' }), signal)).toEqual(
      []
    );
  });

  it('offers no voice for a model whose catalogue the spike did not record', async () => {
    expect(await provider.listVoices(config({ model: 'qwen3-tts-flash' }), signal)).toEqual([]);
  });
});
