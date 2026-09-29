/**
 * Volcengine (火山引擎豆包) adapter (spec §2.3).
 *
 * Transport is HTTP POST with a chunked-JSON body: the service streams one
 * JSON object per frame, each carrying a base64 `data` field of audio. Word
 * timings arrive on the `TTSSentenceEnd` frame and — per the spec — only from
 * the TTS 1.0 model, so `capabilities().timings` is `'none'` for 2.0.
 *
 * Wire-format assumptions that Phase 4 must confirm against the live API are
 * marked "assumed" below. Where the service's own vocabulary is ambiguous the
 * parser accepts aliases, so a mismatch degrades to sentence-level highlight
 * rather than losing the audio.
 */

import { alignTimings } from './align-timings';
import { errorFromStatus, messageFromBody, ProviderError, type ProviderErrorCode } from './errors';
import {
  concatChunks,
  decodeBase64,
  isRecord,
  parseJsonChunks,
  readArray,
  readFirstNumber,
  readFirstString,
  readRecord,
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

/** assumed: the streaming TTS endpoint. */
const DEFAULT_BASE_URL = 'https://openspeech.bytedance.com';
const SYNTHESIZE_PATH = '/api/v1/tts';

/** assumed: the resource id that grants TTS 1.0. */
const DEFAULT_RESOURCE_ID = 'volc.service_type.10029';

const AUDIO_FORMAT = 'mp3';
const AUDIO_MIME = 'audio/mpeg';
const SAMPLE_RATE = 24000;

/**
 * Protocol event codes (assumed).
 *
 * Timings ride on the sentence-end frame, which some revisions send as the
 * number and others as the symbolic name, so both are accepted.
 */
export const EVENT_SENTENCE_START = 350;
export const EVENT_SENTENCE_END = 351;
export const EVENT_RESPONSE = 352;
export const EVENT_SESSION_END = 359;

/** Default model. 1.0 is the only revision that reports word timings. */
const DEFAULT_MODEL = 'tts-1.0';

const DEFAULT_VOICE = 'zh_female_shuangkuaisisi_moon_bigtts';

/** assumed: the per-request character cap. */
const MAX_CHARS = 1000;

const CONCURRENCY = 2;

/** A sample of the voices the big-model TTS service ships with. */
const VOICES: Voice[] = [
  { id: 'zh_female_shuangkuaisisi_moon_bigtts', name: '爽快思思', lang: 'zh-CN', gender: 'female' },
  { id: 'zh_male_wennuanahu_moon_bigtts', name: '温暖阿虎', lang: 'zh-CN', gender: 'male' },
  { id: 'zh_male_shaonianzixin_moon_bigtts', name: '少年梓辛', lang: 'zh-CN', gender: 'male' },
  { id: 'zh_female_cancan_mars_bigtts', name: '灿灿', lang: 'zh-CN', gender: 'female' },
  { id: 'zh_male_beijingxiaoye_moon_bigtts', name: '北京小爷', lang: 'zh-CN', gender: 'male' },
  { id: 'zh_female_wanwanxiaohe_moon_bigtts', name: '湾湾小何', lang: 'zh-CN', gender: 'female' },
  { id: 'en_female_amanda_moon_bigtts', name: 'Amanda', lang: 'en-US', gender: 'female' },
  { id: 'en_male_jackson_moon_bigtts', name: 'Jackson', lang: 'en-US', gender: 'male' },
];

/**
 * Volcengine's own error vocabulary (assumed).
 *
 * 45000030 is the "service not activated" code the spec calls out; it shares
 * a bucket with the generic unavailable codes because the user-facing fix is
 * the same (open the console and enable the service).
 */
const ERROR_CODES: Record<number, ProviderErrorCode> = {
  3001: 'unknown',
  3002: 'unknown',
  3003: 'invalid-key',
  3004: 'no-quota',
  3005: 'rate-limit',
  3006: 'service-unavailable',
  45000030: 'service-unavailable',
};

/** Success codes: the legacy endpoint answers 3000, the newer one 0. */
const SUCCESS_CODES = new Set([0, 3000]);

/** True when `model` reports word timings. */
export function supportsTimings(model: string): boolean {
  return model === 'tts-1.0';
}

/** True when a frame's `event` field marks the end of a sentence. */
export function isSentenceEnd(event: unknown): boolean {
  return event === EVENT_SENTENCE_END || event === 'TTSSentenceEnd';
}

/** Map a Volcengine code to a unified one, or `undefined` if unknown. */
export function mapErrorCode(code: number): ProviderErrorCode | undefined {
  return ERROR_CODES[code];
}

/**
 * Map a non-2xx response to a `ProviderError`, preferring the service's own
 * code over the HTTP status when the body carries one.
 */
export function mapVolcengineError(status: number, body: string): ProviderError {
  const message = messageFromBody(body, `HTTP ${status}`);
  const code = readErrorCode(body);
  const details = { status, code, body };

  if (code !== undefined) {
    const mapped = mapErrorCode(code);
    if (mapped) return new ProviderError(mapped, message, details);
  }

  return errorFromStatus(status, message, details);
}

/** Read a numeric `code` out of a Volcengine body. */
function readErrorCode(body: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;
    return readFirstNumber(parsed, ['code', 'status_code', 'StatusCode']);
  } catch {
    return undefined;
  }
}

interface Word {
  text: string;
  startMs: number;
  endMs: number;
}

interface StreamResult {
  chunks: ArrayBuffer[];
  words: Word[];
  error?: { code?: number; message: string };
}

export class VolcengineProvider implements Provider {
  readonly id = 'volcengine' as const;
  readonly name = '火山引擎豆包 TTS';

  capabilities(config: ProviderConfig): ProviderCapabilities {
    const { model = DEFAULT_MODEL } = requireConfig(config, 'volcengine');

    return {
      timings: supportsTimings(model) ? 'exact' : 'none',
      maxChars: MAX_CHARS,
      concurrency: CONCURRENCY,
    };
  }

  /** Verify the credentials by synthesizing two characters. */
  async validate(config: ProviderConfig, signal: AbortSignal): Promise<void> {
    await this.synthesize({ text: '你好', voiceId: DEFAULT_VOICE, signal }, config);
  }

  async listVoices(config: ProviderConfig, _signal: AbortSignal): Promise<Voice[]> {
    const { model = DEFAULT_MODEL } = requireConfig(config, 'volcengine');
    const timings = supportsTimings(model);

    return VOICES.map((voice) => ({ ...voice, supportsTimings: timings }));
  }

  async synthesize(request: SynthesizeRequest, config: ProviderConfig): Promise<SynthesisResult> {
    const {
      appId,
      accessToken,
      resourceId = DEFAULT_RESOURCE_ID,
      model = DEFAULT_MODEL,
      baseUrl = DEFAULT_BASE_URL,
    } = requireConfig(config, 'volcengine');

    const response = await sendRequest(`${baseUrl}${SYNTHESIZE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-App-Id': appId,
        // The spec names `X-Api-Key`; the live service documents
        // `X-Api-Access-Key`. Both carry the same token so the adapter works
        // either way — Phase 4 should confirm and drop the redundant one.
        'X-Api-Key': accessToken,
        'X-Api-Access-Key': accessToken,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
      },
      body: JSON.stringify({
        user: { uid: 'sayloud' },
        req_params: {
          text: request.text,
          speaker: request.voiceId || DEFAULT_VOICE,
          model,
          audio_params: { format: AUDIO_FORMAT, sample_rate: SAMPLE_RATE },
        },
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      throw mapVolcengineError(response.status, await response.text());
    }

    const stream = parseStream(await response.text());
    if (stream.error) {
      // The service also reports failures as a 200 whose frames carry a
      // non-success code, so the stream has to be checked too.
      const mapped = stream.error.code === undefined ? undefined : mapErrorCode(stream.error.code);
      throw new ProviderError(mapped ?? 'unknown', stream.error.message, {
        code: stream.error.code,
      });
    }

    if (stream.chunks.length === 0) {
      throw new ProviderError('unknown', 'Volcengine returned no audio');
    }

    const timings = resolveTimings(request.text, stream.words);

    return {
      audio: concatChunks(stream.chunks),
      mime: AUDIO_MIME,
      durationMs: lastEndMs(timings),
      timings,
    };
  }
}

/**
 * Read every JSON frame into audio chunks, words and an optional error.
 *
 * A frame that is not JSON is skipped rather than fatal: the stream carries
 * session bookkeeping frames alongside the audio, and one unexpected frame
 * should not discard the sentence.
 */
function parseStream(body: string): StreamResult {
  const chunks: ArrayBuffer[] = [];
  const words: Word[] = [];
  let error: StreamResult['error'];

  for (const frame of parseJsonChunks(body)) {
    if (!isRecord(frame)) continue;

    const code = readFirstNumber(frame, ['code', 'status_code', 'StatusCode']);
    if (code !== undefined && !SUCCESS_CODES.has(code)) {
      error = {
        code,
        message: readFirstString(frame, ['message', 'Message']) ?? `Volcengine error ${code}`,
      };
      continue;
    }

    const base64 = readFirstString(frame, ['data', 'audio']);
    if (base64) chunks.push(decodeBase64(base64));

    // Timings ride on the sentence-end frame, but the payload wrapper varies
    // between revisions, so both the frame and its `payload` are inspected.
    const payload = readRecord(frame, 'payload');
    if (isSentenceEnd(frame.event) || hasWords(frame) || (payload && hasWords(payload))) {
      collectWords(frame, words);
      if (payload) collectWords(payload, words);
    }
  }

  return { chunks, words, error };
}

function hasWords(record: Record<string, unknown>): boolean {
  return readArray(record, 'words') !== undefined || readArray(record, 'word_list') !== undefined;
}

/**
 * Collect word timings from a frame.
 *
 * The service reports seconds as floats in `start_time` / `end_time` and,
 * on some revisions, milliseconds in `start_ms` / `end_ms`; the millisecond
 * field wins when both are present.
 */
function collectWords(source: Record<string, unknown>, into: Word[]): void {
  const list = readArray(source, 'words') ?? readArray(source, 'word_list');
  if (!list) return;

  for (const entry of list) {
    if (!isRecord(entry)) continue;

    const text = readFirstString(entry, ['text', 'word']);
    const startMs = readTimeMs(entry, ['start_ms', 'startMs'], ['start_time', 'begin_time']);
    const endMs = readTimeMs(entry, ['end_ms', 'endMs'], ['end_time', 'endTime']);
    if (!text || startMs === undefined || endMs === undefined) continue;

    into.push({ text, startMs, endMs });
  }
}

/** Read a time as milliseconds, from a millisecond or a seconds field. */
function readTimeMs(
  record: Record<string, unknown>,
  msKeys: string[],
  secondKeys: string[]
): number | undefined {
  const milliseconds = readFirstNumber(record, msKeys);
  if (milliseconds !== undefined) return milliseconds;

  const seconds = readFirstNumber(record, secondKeys);
  return seconds === undefined ? undefined : seconds * 1000;
}

/** Align word timings, or `undefined` so the caller highlights the sentence. */
function resolveTimings(sentenceText: string, words: Word[]): WordTiming[] | undefined {
  if (words.length === 0) return undefined;

  let durationMs = 0;
  for (const word of words) {
    if (word.endMs > durationMs) durationMs = word.endMs;
  }
  if (durationMs <= 0) return undefined;

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
