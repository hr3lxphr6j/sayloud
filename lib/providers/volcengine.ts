/**
 * Volcengine (火山引擎豆包) adapter.
 *
 * Verified against the live API with a real key on 2026-09-29 and
 * 2026-10-02 (word timings fix):
 *
 * - `POST {baseUrl}/api/v3/tts/unidirectional`, authenticated with the new
 *   console's `X-Api-Key` plus `X-Api-Resource-Id`. The old console's AppId +
 *   Access Token pair is deliberately not sent: it is a different auth path
 *   this project does not support.
 * - The body is HTTP chunked, one JSON object per line — **not** SSE, so there
 *   is no `data:` prefix to strip. Every frame is `{code, message, data}` with
 *   `data` holding base64 audio, and the stream ends on `code: 20000000`.
 * - With `enable_timestamp: true` inside `audio_params`, the service adds a frame
 *   carrying `{sentence: {text, words: [{word, startTime, endTime, confidence}]}}`.
 *   Times are in **seconds** and there are no character offsets, so the words
 *   are located by text. Only `seed-tts-1.0` reports them; 2.0 synthesizes but
 *   returns an empty `words` array, which leaves sentence-level highlight.
 *   **CRITICAL**: `enable_timestamp` must be inside `audio_params`, not at the
 *   `req_params` level — the wrong position causes the API to return an empty
 *   `words` array even for seed-tts-1.0.
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
  VolcengineResourceId,
  WordTiming,
} from './types';
import { requireConfig } from './types';

/** The public host; also the settings form's default. */
export const DEFAULT_BASE_URL = 'https://openspeech.bytedance.com';

/** The streaming TTS path. */
const SYNTHESIZE_PATH = '/api/v3/tts/unidirectional';

/** The character-billed 1.0 resource, and the only one that reports timings. */
export const DEFAULT_RESOURCE_ID: VolcengineResourceId = 'seed-tts-1.0';

/** The code the service sends on its last frame. */
export const END_CODE = 20000000;

const AUDIO_FORMAT = 'mp3';
const AUDIO_MIME = 'audio/mpeg';
const SAMPLE_RATE = 24000;

/** assumed: the per-request character cap. */
const MAX_CHARS = 1000;

const CONCURRENCY = 2;

/**
 * The voice each resource falls back to, and the one `validate()` probes.
 *
 * A voice only works on its own resource: a 1.0 voice on `seed-tts-2.0` is
 * rejected with 55000000 (confirmed on a live key). These are the
 * first entries of the catalogue in `volcengine-voices.ts`, kept here so
 * synthesis does not have to load it.
 */
const DEFAULT_VOICES: Record<VolcengineResourceId, string> = {
  'seed-tts-1.0': 'zh_female_shuangkuaisisi_moon_bigtts',
  'seed-tts-2.0': 'zh_female_vv_uranus_bigtts',
};

export function defaultVoice(resourceId: VolcengineResourceId): string {
  return DEFAULT_VOICES[resourceId];
}

/**
 * Volcengine's error vocabulary.
 *
 * `45000030` ("requested resource not granted") is the "service not activated"
 * case, and `55000000` is the voice/resource mismatch, which maps to the
 * `voice-mismatch` code so the panel can tell the user to pick a voice that
 * belongs to the resource. The three- and four-digit codes below come from the
 * older endpoint and are kept so a service that still answers with them is not
 * reported as an unknown failure.
 */
const ERROR_CODES: Record<number, ProviderErrorCode> = {
  3001: 'unknown',
  3002: 'unknown',
  3003: 'invalid-key',
  3004: 'no-quota',
  3005: 'rate-limit',
  3006: 'service-unavailable',
  45000030: 'not-activated',
  55000000: 'voice-mismatch',
};

/**
 * Codes that mean "this frame is payload, not a failure".
 *
 * `20000000` is the verified end-of-stream frame; the audio frames
 * before it carry `0`.
 */
const SUCCESS_CODES = new Set([0, END_CODE]);

/** True when this resource reports word timings. */
export function supportsTimings(resourceId: VolcengineResourceId): boolean {
  return resourceId === 'seed-tts-1.0';
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
  const message = readHeaderMessage(body) ?? messageFromBody(body, `HTTP ${status}`);
  const code = readErrorCode(body);
  const details = { status, code, body };

  if (code !== undefined) {
    const mapped = mapErrorCode(code);
    if (mapped) return new ProviderError(mapped, message, details);
  }

  return errorFromStatus(status, message, details);
}

/**
 * Where a Volcengine error body keeps its code and message.
 *
 * Non-2xx answers wrap them in `header` (`{header: {reqid, code, message}}`,
 * seen live for 45000030); stream frames keep them at the root.
 */
function errorRecord(parsed: Record<string, unknown>): Record<string, unknown> {
  return readRecord(parsed, 'header') ?? parsed;
}

function readHeaderMessage(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;
    const header = readRecord(parsed, 'header');
    return header ? readFirstString(header, ['message', 'Message']) : undefined;
  } catch {
    return undefined;
  }
}

/** Read a numeric `code` out of a Volcengine body. */
function readErrorCode(body: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;
    return readFirstNumber(errorRecord(parsed), ['code', 'status_code', 'StatusCode']);
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
    const { resourceId = DEFAULT_RESOURCE_ID } = requireConfig(config, 'volcengine');

    return {
      timings: supportsTimings(resourceId) ? 'exact' : 'none',
      maxChars: MAX_CHARS,
      concurrency: CONCURRENCY,
    };
  }

  /** Verify the credentials by synthesizing two characters. */
  async validate(config: ProviderConfig, signal: AbortSignal): Promise<void> {
    // The probe voice has to belong to the resource, or a valid key would be
    // reported as a voice mismatch.
    const { resourceId = DEFAULT_RESOURCE_ID } = requireConfig(config, 'volcengine');
    await this.synthesize({ text: '你好', voiceId: defaultVoice(resourceId), signal }, config);
  }

  async listVoices(config: ProviderConfig, _signal: AbortSignal): Promise<Voice[]> {
    const { resourceId = DEFAULT_RESOURCE_ID } = requireConfig(config, 'volcengine');
    const timings = supportsTimings(resourceId);

    // Several hundred entries: loaded on demand so the offscreen document,
    // which only synthesizes, never carries them.
    const { VOICES_1_0, VOICES_2_0 } = await import('./volcengine-voices');
    const voices = resourceId === 'seed-tts-2.0' ? VOICES_2_0 : VOICES_1_0;
    return voices.map((voice) => ({ ...voice, supportsTimings: timings }));
  }

  async synthesize(request: SynthesizeRequest, config: ProviderConfig): Promise<SynthesisResult> {
    const {
      apiKey,
      resourceId = DEFAULT_RESOURCE_ID,
      baseUrl = DEFAULT_BASE_URL,
    } = requireConfig(config, 'volcengine');

    const response = await sendRequest(`${baseUrl}${SYNTHESIZE_PATH}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // The new console's auth, and nothing else: sending the old console's
        // AppId / Access Token alongside it would leave the service two
        // credentials to choose from, and this project supports only the new
        // console's path.
        'X-Api-Key': apiKey,
        'X-Api-Resource-Id': resourceId,
        'X-Api-Request-Id': crypto.randomUUID(),
      },
      // Confirmed on 2026-10-02: enable_timestamp must be inside audio_params.
      // Placing it at req_params level causes the API to return empty words arrays.
      body: JSON.stringify({
        user: { uid: 'sayloud' },
        req_params: {
          text: request.text,
          speaker: request.voiceId || defaultVoice(resourceId),
          audio_params: {
            format: AUDIO_FORMAT,
            sample_rate: SAMPLE_RATE,
            // Only 1.0 can answer with timings, so asking the other resources for
            // them would only add a frame that carries nothing.
            // CRITICAL: enable_timestamp must be inside audio_params, not req_params!
            ...(supportsTimings(resourceId) ? { enable_timestamp: true } : {}),
          },
        },
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      throw mapVolcengineError(response.status, await response.text());
    }

    const responseText = await response.text();
    const stream = parseStream(responseText);

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
 * bookkeeping frames alongside the audio, and one unexpected frame should not
 * discard the sentence.
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

    // Timings ride on their own frame, and the verified shape is a `sentence`
    // object at the frame's root. A `payload` wrapper and a bare
    // `words` list are kept as tolerances for revisions that nest differently.
    collectWords(frame, words);
    const payload = readRecord(frame, 'payload');
    if (payload) collectWords(payload, words);
  }

  return { chunks, words, error };
}

/** Collect the word timings a frame carries, wherever it nests them. */
function collectWords(source: Record<string, unknown>, into: Word[]): void {
  const sentence = readRecord(source, 'sentence');
  const list =
    (sentence && (readArray(sentence, 'words') ?? readArray(sentence, 'word_list'))) ??
    readArray(source, 'words') ??
    readArray(source, 'word_list');
  if (!list) return;

  for (const entry of list) {
    if (!isRecord(entry)) continue;

    const text = readFirstString(entry, ['word', 'text']);
    const startMs = readTimeMs(entry, ['start_ms', 'startMs'], ['startTime', 'start_time']);
    const endMs = readTimeMs(entry, ['end_ms', 'endMs'], ['endTime', 'end_time']);
    if (!text || startMs === undefined || endMs === undefined) continue;

    into.push({ text, startMs, endMs });
  }
}

/**
 * Read a time as milliseconds, from a millisecond or a seconds field.
 *
 * The verified fields are `startTime` / `endTime` in **seconds**;
 * the millisecond aliases are kept from the older endpoint so a revision that
 * still reports them is not misread as seconds.
 */
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

  // The words are normalized on the way back ("1.27" is spoken as "一 点 二 七"),
  // so they are located by text. A word the sentence does not contain is never
  // placed by estimation — that is a hard constraint, not a heuristic.
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
