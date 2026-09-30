/**
 * DashScope (阿里云百炼) adapter — CosyVoice / Qwen-TTS (spec §2.3).
 *
 * Transport is HTTP + SSE: the request sets `X-DashScope-SSE: enable` and the
 * service answers with `text/event-stream`, one JSON object per event, whose
 * `output.audio.data` carries base64 audio chunks. CosyVoice v3+ additionally
 * reports per-word timings under `output.sentence.words`, which is the only
 * way to get word-level highlight on this service.
 *
 * Wire-format assumptions that Phase 4 must confirm against the live API are
 * marked "assumed" below; the parser accepts field aliases where the shape is
 * ambiguous so a small mismatch does not lose the audio.
 */

import { alignTimings } from './align-timings';
import { errorFromStatus, messageFromBody, ProviderError, type ProviderErrorCode } from './errors';
import {
  concatChunks,
  decodeBase64,
  isRecord,
  parseSse,
  readArray,
  readFirstNumber,
  readFirstString,
  readRecord,
  readString,
  sendRequest,
} from './http';
import type {
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  SynthesisResult,
  SynthesizeRequest,
  Voice,
  WordTiming,
} from './types';
import { requireConfig } from './types';

const REGION_BASE_URLS = {
  'cn-beijing': 'https://dashscope.aliyuncs.com',
  intl: 'https://dashscope-intl.aliyuncs.com',
} as const;

/**
 * The default region's host, exported so the settings schema can offer it as
 * the form's default without keeping a second copy of the URL.
 */
export const DEFAULT_BASE_URL: string = REGION_BASE_URLS['cn-beijing'];

/** assumed: the SpeechSynthesizer service path. */
const SYNTHESIZE_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';

/** mp3 is the format every CosyVoice revision supports. */
const AUDIO_FORMAT = 'mp3';
const AUDIO_MIME = 'audio/mpeg';
const SAMPLE_RATE = 22050;

/**
 * Default model. v3 is the oldest revision that reports word timings, and
 * word-level highlight is the point of the cloud providers — an account
 * without v3 gets a clear `service-unavailable` naming the model.
 */
const DEFAULT_MODEL = 'cosyvoice-v3';

/** Used by `validate()` and as a fallback when a caller passes no voice. */
const DEFAULT_VOICE = 'longxiaochun';

/** CosyVoice caps a single request at 2000 characters. */
const MAX_CHARS = 2000;

/** DashScope tolerates more, but two in flight keeps first-sentence latency low. */
const CONCURRENCY = 2;

/**
 * The voices CosyVoice ships with.
 *
 * DashScope exposes no voice-listing endpoint for SpeechSynthesizer, so the
 * catalogue is maintained here. It feeds the P3 voice picker; a user with
 * access to other voices can still type a voice id there.
 */
const VOICES: Voice[] = [
  { id: 'longxiaochun', name: '龙小淳', lang: 'zh-CN', gender: 'female' },
  { id: 'longxiaoxia', name: '龙小夏', lang: 'zh-CN', gender: 'female' },
  { id: 'longxiaobai', name: '龙小白', lang: 'zh-CN', gender: 'female' },
  { id: 'longxiaocheng', name: '龙小诚', lang: 'zh-CN', gender: 'male' },
  { id: 'longlaotie', name: '龙老铁', lang: 'zh-CN', gender: 'male' },
  { id: 'longshu', name: '龙书', lang: 'zh-CN', gender: 'male' },
  { id: 'longshuo', name: '龙硕', lang: 'zh-CN', gender: 'male' },
  { id: 'longjing', name: '龙婧', lang: 'zh-CN', gender: 'female' },
  { id: 'longmiao', name: '龙妙', lang: 'zh-CN', gender: 'female' },
  { id: 'longyue', name: '龙悦', lang: 'zh-CN', gender: 'female' },
  { id: 'longyuan', name: '龙媛', lang: 'zh-CN', gender: 'female' },
  { id: 'longfei', name: '龙飞', lang: 'zh-CN', gender: 'male' },
  { id: 'longtong', name: '龙彤', lang: 'zh-CN', gender: 'female' },
  { id: 'longxiang', name: '龙祥', lang: 'zh-CN', gender: 'male' },
  { id: 'loongstella', name: 'Stella', lang: 'en-US', gender: 'female' },
  { id: 'loongbella', name: 'Bella', lang: 'en-US', gender: 'female' },
];

/**
 * DashScope's own error vocabulary.
 *
 * Codes arrive with a dotted detail (`Throttling.RateQuota`), so matching
 * falls back to the leading segment.
 */
const ERROR_CODES: Record<string, ProviderErrorCode> = {
  InvalidApiKey: 'invalid-key',
  InvalidApiKeyError: 'invalid-key',
  AuthenticationError: 'invalid-key',
  Arrearage: 'no-quota',
  QuotaExhausted: 'no-quota',
  AllocationQuotaExhausted: 'no-quota',
  Throttling: 'rate-limit',
  LimitRequests: 'rate-limit',
  ModelNotOpen: 'service-unavailable',
  ModelNotAvailable: 'service-unavailable',
  ServiceUnavailable: 'service-unavailable',
  InternalError: 'service-unavailable',
};

/** True when `model` reports word timings (CosyVoice v3 and v3.5). */
export function supportsTimings(model: string): boolean {
  return model.startsWith('cosyvoice-v3');
}

/** Map a DashScope error code to a unified one, or `undefined` if unknown. */
export function mapErrorCode(code: string): ProviderErrorCode | undefined {
  const exact = ERROR_CODES[code];
  if (exact) return exact;

  const head = code.split('.')[0];
  return head ? ERROR_CODES[head] : undefined;
}

/**
 * Map a non-2xx response to a `ProviderError`, preferring DashScope's own code
 * over the HTTP status: the service reports "model not activated" as a 400 and
 * "key rejected" as a 401, and only the code distinguishes them.
 */
export function mapDashscopeError(status: number, body: string): ProviderError {
  const message = messageFromBody(body, `HTTP ${status}`);
  const code = readErrorCode(body);
  const details = { status, code, body };

  const mapped = code ? mapErrorCode(code) : undefined;
  if (mapped) return new ProviderError(mapped, message, details);

  return errorFromStatus(status, message, details);
}

/** Pull `code` out of a DashScope error body, including the nested shape. */
function readErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;

    const direct = readString(parsed, 'code');
    if (direct) return direct;

    const nested = readRecord(parsed, 'error');
    return nested ? readString(nested, 'code') : undefined;
  } catch {
    return undefined;
  }
}

interface StreamResult {
  chunks: ArrayBuffer[];
  /** Present when the model answered with a download URL instead of base64. */
  audioUrl?: string;
  words: Array<{ text: string; startMs: number; endMs: number }>;
  error?: { code?: string; message: string };
}

export class DashscopeProvider implements Provider {
  readonly id = 'dashscope' as const;
  readonly name = 'DashScope (阿里云百炼)';

  capabilities(config: ProviderConfig): ProviderCapabilities {
    const { model = DEFAULT_MODEL } = requireConfig(config, 'dashscope');

    return {
      timings: supportsTimings(model) ? 'exact' : 'none',
      maxChars: MAX_CHARS,
      concurrency: CONCURRENCY,
    };
  }

  /**
   * Verify the key by synthesizing two characters.
   *
   * DashScope has no credential-only endpoint for this service, and a
   * synthesis is the only check that also proves the model is activated.
   */
  async validate(config: ProviderConfig, signal: AbortSignal): Promise<void> {
    await this.synthesize({ text: '你好', voiceId: DEFAULT_VOICE, signal }, config);
  }

  async listVoices(config: ProviderConfig, _signal: AbortSignal): Promise<Voice[]> {
    const { model = DEFAULT_MODEL } = requireConfig(config, 'dashscope');
    const timings = supportsTimings(model);

    return VOICES.map((voice) => ({ ...voice, supportsTimings: timings }));
  }

  async synthesize(request: SynthesizeRequest, config: ProviderConfig): Promise<SynthesisResult> {
    const {
      apiKey,
      workspaceId,
      region = 'cn-beijing',
      model = DEFAULT_MODEL,
      baseUrl,
    } = requireConfig(config, 'dashscope');

    const url = `${baseUrl ?? REGION_BASE_URLS[region]}${SYNTHESIZE_PATH}`;
    const response = await sendRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'enable',
        ...(workspaceId ? { 'X-DashScope-WorkSpace': workspaceId } : {}),
      },
      body: JSON.stringify({
        model,
        input: { text: request.text, voice: request.voiceId || DEFAULT_VOICE },
        parameters: { text_type: 'PlainText', format: AUDIO_FORMAT, sample_rate: SAMPLE_RATE },
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      throw mapDashscopeError(response.status, await response.text());
    }

    const stream = parseStream(await response.text());
    if (stream.error) {
      // DashScope reports some failures as HTTP 200 with an error body, so the
      // stream itself has to be checked, not just the status line.
      const mapped = stream.error.code ? mapErrorCode(stream.error.code) : undefined;
      throw new ProviderError(mapped ?? 'unknown', stream.error.message, {
        code: stream.error.code,
      });
    }

    const { audio, mime } = await resolveAudio(stream, request.signal);
    const timings = resolveTimings(request.text, stream.words);

    return {
      audio,
      mime,
      durationMs: lastEndMs(timings),
      timings,
    };
  }
}

/**
 * Read every SSE event into audio chunks, words and an optional error.
 *
 * A chunk that is not JSON is skipped rather than fatal: DashScope emits
 * keep-alive and usage events alongside the audio, and losing the whole
 * sentence because one frame was unexpected would be worse than ignoring it.
 */
function parseStream(body: string): StreamResult {
  const chunks: ArrayBuffer[] = [];
  const words: StreamResult['words'] = [];
  let audioUrl: string | undefined;
  let error: StreamResult['error'];

  for (const event of parseSse(body)) {
    const data = event.data.trim();
    if (data.length === 0 || data === '[DONE]') continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      continue;
    }
    if (!isRecord(parsed)) continue;

    const code = readString(parsed, 'code');
    if (code && code !== '0' && code !== 'Success') {
      error = {
        code,
        message: readString(parsed, 'message') ?? `DashScope error ${code}`,
      };
      continue;
    }

    const output = readRecord(parsed, 'output');
    if (!output) continue;

    const audio = readRecord(output, 'audio');
    if (audio) {
      const base64 = readFirstString(audio, ['data', 'audio_data']);
      if (base64) chunks.push(decodeBase64(base64));
      audioUrl ??= readString(audio, 'url');
    }

    collectWords(output, words);
  }

  return { chunks, audioUrl, words, error };
}

/** Collect word timings from the shapes DashScope uses for them. */
function collectWords(output: Record<string, unknown>, into: StreamResult['words']): void {
  const containers: Array<unknown[] | undefined> = [
    readArray(output, 'words'),
    readArray(readRecord(output, 'sentence') ?? {}, 'words'),
  ];

  for (const container of containers) {
    if (!container) continue;
    for (const entry of container) {
      if (!isRecord(entry)) continue;

      const text = readFirstString(entry, ['text', 'word']);
      // assumed: `begin_time` / `end_time` are milliseconds from audio start.
      const startMs = readFirstNumber(entry, ['begin_time', 'beginTime', 'startMs']);
      const endMs = readFirstNumber(entry, ['end_time', 'endTime', 'endMs']);
      if (!text || startMs === undefined || endMs === undefined) continue;

      into.push({ text, startMs, endMs });
    }
  }
}

/**
 * Produce the audio bytes.
 *
 * Streaming models answer with base64 chunks. Models without SSE support fall
 * back to a JSON body carrying a signed download URL, which is fetched here so
 * the rest of the extension sees one uniform `ArrayBuffer`.
 */
async function resolveAudio(
  stream: StreamResult,
  signal: AbortSignal
): Promise<{ audio: ArrayBuffer; mime: string }> {
  if (stream.chunks.length > 0) {
    return { audio: concatChunks(stream.chunks), mime: AUDIO_MIME };
  }

  if (stream.audioUrl) {
    const response = await sendRequest(stream.audioUrl, { signal });
    if (!response.ok) {
      throw new ProviderError(
        'service-unavailable',
        `audio download failed: HTTP ${response.status}`,
        {
          status: response.status,
        }
      );
    }
    return {
      audio: await response.arrayBuffer(),
      mime: response.headers.get('content-type')?.split(';')[0] ?? AUDIO_MIME,
    };
  }

  throw new ProviderError('unknown', 'DashScope returned no audio');
}

/** Align word timings, or `undefined` so the caller highlights the sentence. */
function resolveTimings(
  sentenceText: string,
  words: StreamResult['words']
): WordTiming[] | undefined {
  if (words.length === 0) return undefined;

  // The API reports no separate duration; the last word's end is the closest
  // honest value, and `alignTimings` needs it to close the final span.
  let durationMs = 0;
  for (const word of words) {
    if (word.endMs > durationMs) durationMs = word.endMs;
  }
  if (durationMs <= 0) return undefined;

  // CosyVoice reports word text without reliable character offsets, so the
  // words are located in the sentence in order (spec §2.2).
  return alignTimings(sentenceText, { kind: 'sequential-words', words }, durationMs);
}

/** End of the last timing, used as the audio duration when the API omits one. */
function lastEndMs(timings: WordTiming[] | undefined): number {
  let last = 0;
  for (const timing of timings ?? []) {
    if (timing.endMs > last) last = timing.endMs;
  }
  return last;
}
