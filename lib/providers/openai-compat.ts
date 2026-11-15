/**
 * OpenAI-compatible adapter.
 *
 * Covers every server that speaks the OpenAI speech API — OpenAI itself,
 * LocalAI, LM Studio, Kokoro-FastAPI and friends. Two modes:
 *
 * - standard: `POST {baseUrl}/audio/speech` returns raw audio bytes and no
 *   timings, so highlight stays at sentence level.
 * - captioned: Kokoro-FastAPI's `POST {baseUrl}/dev/captioned_speech` returns
 *   `{ audio: base64, timestamps: [...] }`, which is the only way to get word
 *   timings from an OpenAI-shaped server.
 *
 * Voices come from `GET {baseUrl}/audio/voices` when the server implements it
 * (Kokoro does; OpenAI does not) and otherwise from the user's own list in
 * `config.voices`.
 */

import { alignTimings, maxEndMs } from './align-timings';
import {
  isAbortError,
  mapHttpError,
  ProviderError,
  type ProviderErrorCode,
  readBodyText,
} from './errors';
import {
  decodeBase64,
  isRecord,
  normalizeBaseUrl,
  readArray,
  readFirstString,
  readJsonBody,
  readRecord,
  readString,
  readTimeMs,
  sendRequest,
} from './http';
import type {
  OpenAiCompatConfig,
  Provider,
  ProviderCapabilities,
  ProviderConfig,
  SynthesisResult,
  SynthesizeRequest,
  Voice,
  WordTiming,
} from './types';
import { requireConfig, VALIDATION_PROBE_TEXT } from './types';

const SPEECH_PATH = '/audio/speech';
const CAPTIONED_SPEECH_PATH = '/dev/captioned_speech';
const VOICES_PATH = '/audio/voices';

const AUDIO_FORMAT = 'mp3';

/** Media type per `response_format`, used when the server sends no Content-Type. */
const MIME_BY_FORMAT: Record<string, string> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  pcm: 'audio/L16',
};

/** OpenAI's own speech models are the safest default. */
const DEFAULT_MODEL = 'tts-1';

/** OpenAI's built-in voices; also a valid fallback for compat servers. */
const DEFAULT_VOICE = 'alloy';

/** OpenAI rejects input longer than 4096 characters. */
const MAX_CHARS = 4000;

/** A local server synthesizes on one thread; a hosted one handles more. */
const REMOTE_CONCURRENCY = 2;
const LOCAL_CONCURRENCY = 1;

/**
 * Server error vocabulary, from the `error.code` / `error.type` fields.
 */
const ERROR_CODES: Record<string, ProviderErrorCode> = {
  invalid_api_key: 'invalid-key',
  invalid_authentication: 'invalid-key',
  insufficient_quota: 'no-quota',
  quota_exceeded: 'no-quota',
  rate_limit_exceeded: 'rate-limit',
  requests: 'rate-limit',
  tokens: 'rate-limit',
};

/** True when the server is on this machine. */
export function isLocalServer(baseUrl: string): boolean {
  try {
    const { hostname } = new URL(baseUrl);
    return (
      hostname === 'localhost' ||
      hostname === '127.0.0.1' ||
      hostname === '::1' ||
      hostname.endsWith('.localhost')
    );
  } catch {
    return false;
  }
}

/** Map a server error code to a unified one, or `undefined` if unknown. */
export function mapErrorCode(code: string): ProviderErrorCode | undefined {
  return ERROR_CODES[code];
}

/**
 * Map a non-2xx response to a `ProviderError`.
 *
 * OpenAI-shaped errors carry the useful detail in `error.code` / `error.type`;
 * the HTTP status alone cannot separate a rejected key from a missing model.
 */
export function mapOpenAiError(status: number, body: string): ProviderError {
  return mapHttpError(status, body, { readCode: readErrorCode, mapCode: mapErrorCode });
}

/** Read `error.code` or `error.type` from an OpenAI-shaped error body. */
function readErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;

    const error = readRecord(parsed, 'error');
    if (!error) return readString(parsed, 'code');

    return readFirstString(error, ['code', 'type']);
  } catch {
    return undefined;
  }
}

/** Media type for a `response_format`. */
function mimeFor(format: string): string {
  return MIME_BY_FORMAT[format] ?? 'audio/mpeg';
}

interface Timestamp {
  text: string;
  startMs: number;
  endMs: number;
}

export class OpenAiCompatProvider implements Provider {
  readonly id = 'openai-compat' as const;
  readonly name = 'OpenAI-compatible';

  capabilities(config: ProviderConfig): ProviderCapabilities {
    const { baseUrl, captionedSpeech } = requireConfig(config, 'openai-compat');

    return {
      // Only the captioned endpoint reports timestamps; the standard one
      // returns raw audio with no alignment data at all.
      timings: captionedSpeech ? 'exact' : 'none',
      maxChars: MAX_CHARS,
      concurrency: isLocalServer(baseUrl) ? LOCAL_CONCURRENCY : REMOTE_CONCURRENCY,
    };
  }

  /** Verify the server and key by synthesizing two characters. */
  async validate(config: ProviderConfig, signal: AbortSignal): Promise<void> {
    await this.synthesize({ text: VALIDATION_PROBE_TEXT, voiceId: '', signal }, config);
  }

  /**
   * List the server's voices, falling back to the user's list.
   *
   * The endpoint is optional — OpenAI itself has none — so a missing or
   * failing endpoint is not an error: the configured list is returned instead,
   * and an empty list when there is none.
   */
  async listVoices(config: ProviderConfig, signal: AbortSignal): Promise<Voice[]> {
    const { baseUrl, apiKey, headers, voices } = requireConfig(config, 'openai-compat');
    const fallback = voices ?? [];

    try {
      const response = await sendRequest(`${normalizeBaseUrl(baseUrl)}${VOICES_PATH}`, {
        method: 'GET',
        headers: authHeaders(apiKey, headers),
        signal,
      });
      if (!response.ok) return fallback;

      const parsed = parseVoices(await response.json());
      return parsed.length > 0 ? parsed : fallback;
    } catch (error) {
      // An abort is the caller's decision and must still propagate.
      if (isAbortError(error)) throw error;
      return fallback;
    }
  }

  async synthesize(request: SynthesizeRequest, config: ProviderConfig): Promise<SynthesisResult> {
    const resolved = requireConfig(config, 'openai-compat');
    const { baseUrl, apiKey, model = DEFAULT_MODEL, headers } = resolved;
    const voiceId = resolveVoice(request.voiceId, resolved);

    const body = {
      model,
      input: request.text,
      voice: voiceId,
      response_format: AUDIO_FORMAT,
      // Kokoro's captioned endpoint streams audio chunks unless told not to;
      // with `stream: false` it answers with one JSON body.
      ...(resolved.captionedSpeech ? { stream: false } : {}),
    };

    const response = await sendRequest(
      `${normalizeBaseUrl(baseUrl)}${resolved.captionedSpeech ? CAPTIONED_SPEECH_PATH : SPEECH_PATH}`,
      {
        method: 'POST',
        headers: { ...authHeaders(apiKey, headers), 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: request.signal,
      }
    );

    if (!response.ok) {
      throw mapOpenAiError(response.status, await readBodyText(response));
    }

    if (resolved.captionedSpeech) {
      // A proxy answering with an HTML page where the JSON should be is
      // reported as a provider failure, not as a raw SyntaxError.
      return this.readCaptioned(
        await readJsonBody(response, 'server returned an unexpected captioned response'),
        request.text
      );
    }

    const audio = await response.arrayBuffer();
    if (audio.byteLength === 0) {
      throw new ProviderError('unknown', 'server returned empty audio');
    }

    return {
      audio,
      mime: response.headers.get('content-type')?.split(';')[0]?.trim() || mimeFor(AUDIO_FORMAT),
      durationMs: 0,
    };
  }

  /** Turn a `captioned_speech` body into a result. */
  private readCaptioned(payload: unknown, sentenceText: string): SynthesisResult {
    if (!isRecord(payload)) {
      throw new ProviderError('unknown', 'server returned an unexpected captioned response');
    }

    const base64 = readFirstString(payload, ['audio', 'audio_base64']);
    if (!base64) {
      throw new ProviderError('unknown', 'server returned no audio');
    }

    const timings = resolveTimings(sentenceText, parseTimestamps(payload));

    return {
      audio: decodeBase64(base64),
      // Kokoro names the format `audio_format`.
      mime: mimeFor(readFirstString(payload, ['audio_format', 'response_format']) ?? AUDIO_FORMAT),
      durationMs: maxEndMs(timings),
      timings,
    };
  }
}

/** `Authorization` plus the caller's extra headers, when a key is configured. */
function authHeaders(
  apiKey: string | undefined,
  extra: Record<string, string> | undefined
): Record<string, string> {
  return {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...extra,
  };
}

/**
 * The voice to use: the caller's choice, then the first configured voice, then
 * the OpenAI default. A captioned local server may have no voices configured
 * at all, and a request without a voice is rejected by every implementation.
 */
function resolveVoice(voiceId: string, config: OpenAiCompatConfig): string {
  if (voiceId) return voiceId;
  return config.voices?.[0]?.id ?? DEFAULT_VOICE;
}

/**
 * Read a voice list from either shape servers use: Kokoro answers with an
 * array of ids under `voices`, OpenAI-shaped servers with objects under
 * `data`.
 */
function parseVoices(payload: unknown): Voice[] {
  if (!isRecord(payload)) return [];

  const list = readArray(payload, 'voices') ?? readArray(payload, 'data');
  if (!list) return [];

  const voices: Voice[] = [];
  for (const entry of list) {
    if (typeof entry === 'string') {
      voices.push({ id: entry, name: entry });
      continue;
    }
    if (!isRecord(entry)) continue;

    const id = readFirstString(entry, ['id', 'voice', 'name']);
    if (!id) continue;

    const lang = readFirstString(entry, ['lang', 'language', 'locale']);
    voices.push({
      id,
      name: readFirstString(entry, ['name', 'id']) ?? id,
      ...(lang ? { lang } : {}),
    });
  }

  return voices;
}

/**
 * Read word timestamps from a captioned response.
 *
 * Kokoro reports seconds as floats in `start_time` / `end_time`; a
 * millisecond field wins when a server sends one instead.
 */
function parseTimestamps(payload: Record<string, unknown>): Timestamp[] {
  const list = readArray(payload, 'timestamps') ?? readArray(payload, 'words');
  if (!list) return [];

  const timestamps: Timestamp[] = [];
  for (const entry of list) {
    if (!isRecord(entry)) continue;

    const text = readFirstString(entry, ['word', 'text']);
    const startMs = readTimeMs(entry, ['start_ms', 'startMs'], ['start_time', 'start']);
    const endMs = readTimeMs(entry, ['end_ms', 'endMs'], ['end_time', 'end']);
    if (!text || startMs === undefined || endMs === undefined) continue;

    timestamps.push({ text, startMs, endMs });
  }

  return timestamps;
}

/** Align word timings, or `undefined` so the caller highlights the sentence. */
function resolveTimings(sentenceText: string, timestamps: Timestamp[]): WordTiming[] | undefined {
  // `alignTimings` rejects the 0 duration an empty timestamp list produces,
  // so the empty case needs no guard here.
  return alignTimings(
    sentenceText,
    { kind: 'sequential-words', words: timestamps },
    maxEndMs(timestamps)
  );
}
