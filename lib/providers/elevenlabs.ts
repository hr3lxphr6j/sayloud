/**
 * ElevenLabs adapter.
 *
 * `POST /v1/text-to-speech/{voice}/with-timestamps` returns the audio as
 * base64 together with a character-level alignment: three parallel arrays of
 * characters and their start/end times. That is a `chars` timing format, so
 * `alignTimings()` merges the characters into words via `Intl.Segmenter`.
 *
 * ElevenLabs aligns against the text it actually speaks. When that text is
 * normalized differently from the request (numbers expanded, abbreviations
 * resolved) the character array no longer lines up with the sentence, and
 * `alignTimings()` rejects it rather than misplacing highlights.
 */

import { alignTimings } from './align-timings';
import { errorFromStatus, messageFromBody, ProviderError, type ProviderErrorCode } from './errors';
import {
  decodeBase64,
  isRecord,
  readArray,
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

/**
 * The public host, exported so the settings schema can offer it as the form's
 * default without keeping a second copy of the URL.
 */
export const DEFAULT_BASE_URL = 'https://api.elevenlabs.io';
const API_PREFIX = '/v1';
const VOICES_PATH = `${API_PREFIX}/voices`;

/** ElevenLabs' multilingual model is the best default for a zh/en reader. */
const DEFAULT_MODEL = 'eleven_multilingual_v2';

/** `mp3_44100_128` is the API's own default and is universally playable. */
const DEFAULT_OUTPUT_FORMAT = 'mp3_44100_128';

/** assumed: the per-request character cap for the multilingual model. */
const MAX_CHARS = 5000;

const CONCURRENCY = 2;

/** Media type per `output_format` prefix. */
const MIME_BY_PREFIX: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  pcm: 'audio/L16',
  ulaw: 'audio/basic',
  alaw: 'audio/basic',
};

/**
 * Server error vocabulary, from `detail.status` / `detail.code`.
 */
const ERROR_CODES: Record<string, ProviderErrorCode> = {
  invalid_api_key: 'invalid-key',
  authentication_error: 'invalid-key',
  quota_exceeded: 'no-quota',
  rate_limit_exceeded: 'rate-limit',
  concurrent_limit_exceeded: 'rate-limit',
  subscription_required: 'not-activated',
  paid_plan_required: 'not-activated',
};

/** Map an ElevenLabs error code to a unified one, or `undefined`. */
export function mapErrorCode(code: string): ProviderErrorCode | undefined {
  return ERROR_CODES[code];
}

/**
 * Map a non-2xx response to a `ProviderError`.
 *
 * ElevenLabs wraps failures in `detail`, which is either an object with a
 * `status` code or a plain string; the status code is what distinguishes a
 * rejected key from a missing voice.
 */
export function mapElevenLabsError(status: number, body: string): ProviderError {
  const message = messageFromBody(body, `HTTP ${status}`);
  const code = readErrorCode(body);
  const details = { status, code, body };

  if (code) {
    const mapped = mapErrorCode(code);
    if (mapped) return new ProviderError(mapped, message, details);
  }

  return errorFromStatus(status, message, details);
}

/** Read `detail.status`, `detail.code` or a top-level `code`. */
function readErrorCode(body: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(body);
    if (!isRecord(parsed)) return undefined;

    const detail = readRecord(parsed, 'detail');
    if (detail) return readFirstString(detail, ['status', 'code', 'type']);

    return readFirstString(parsed, ['code', 'status']);
  } catch {
    return undefined;
  }
}

/** Media type for an `output_format`, e.g. `mp3_44100_128`. */
function mimeFor(outputFormat: string): string {
  const prefix = outputFormat.split('_')[0];
  return (prefix && MIME_BY_PREFIX[prefix]) || 'audio/mpeg';
}

export class ElevenLabsProvider implements Provider {
  readonly id = 'elevenlabs' as const;
  readonly name = 'ElevenLabs';

  capabilities(config: ProviderConfig): ProviderCapabilities {
    requireConfig(config, 'elevenlabs');

    return {
      // `with-timestamps` always returns an alignment; when it cannot be
      // mapped to the sentence, `alignTimings()` degrades to sentence level.
      timings: 'exact',
      maxChars: MAX_CHARS,
      concurrency: CONCURRENCY,
    };
  }

  /**
   * Verify the key against the voices endpoint.
   *
   * Unlike a probe synthesis this costs no quota, and it exercises the same
   * credential the synthesis path uses.
   */
  async validate(config: ProviderConfig, signal: AbortSignal): Promise<void> {
    await this.fetchVoices(config, signal);
  }

  async listVoices(config: ProviderConfig, signal: AbortSignal): Promise<Voice[]> {
    const payload = await this.fetchVoices(config, signal);

    const list = readArray(payload, 'voices');
    if (!list) return [];

    const voices: Voice[] = [];
    for (const entry of list) {
      if (!isRecord(entry)) continue;

      const id = readFirstString(entry, ['voice_id', 'voiceId', 'id']);
      if (!id) continue;

      const labels = readRecord(entry, 'labels');
      const gender = parseGender(labels ? readString(labels, 'gender') : undefined);
      const lang = labels ? readFirstString(labels, ['language', 'locale']) : undefined;

      voices.push({
        id,
        name: readFirstString(entry, ['name', 'voice_id']) ?? id,
        supportsTimings: true,
        ...(lang ? { lang } : {}),
        ...(gender ? { gender } : {}),
      });
    }

    return voices;
  }

  async synthesize(request: SynthesizeRequest, config: ProviderConfig): Promise<SynthesisResult> {
    const {
      apiKey,
      model = DEFAULT_MODEL,
      voiceSettings,
      outputFormat = DEFAULT_OUTPUT_FORMAT,
      baseUrl = DEFAULT_BASE_URL,
    } = requireConfig(config, 'elevenlabs');

    if (!request.voiceId) {
      throw new ProviderError('unknown', 'ElevenLabs requires a voice id');
    }

    const query = `?output_format=${encodeURIComponent(outputFormat)}`;
    const url = `${baseUrl}${API_PREFIX}/text-to-speech/${encodeURIComponent(
      request.voiceId
    )}/with-timestamps${query}`;

    const response = await sendRequest(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': apiKey },
      body: JSON.stringify({
        text: request.text,
        model_id: model,
        ...(voiceSettings ? { voice_settings: voiceSettings } : {}),
      }),
      signal: request.signal,
    });

    if (!response.ok) {
      throw mapElevenLabsError(response.status, await response.text());
    }

    const payload: unknown = await response.json();
    if (!isRecord(payload)) {
      throw new ProviderError('unknown', 'ElevenLabs returned an unexpected response');
    }

    const base64 = readFirstString(payload, ['audio_base64', 'audio']);
    if (!base64) {
      throw new ProviderError('unknown', 'ElevenLabs returned no audio');
    }

    const timings = resolveTimings(request.text, payload);

    return {
      audio: decodeBase64(base64),
      mime: mimeFor(outputFormat),
      durationMs: lastEndMs(timings),
      timings,
    };
  }

  /** `GET /v1/voices`, with the key validated by the caller's status handling. */
  private async fetchVoices(
    config: ProviderConfig,
    signal: AbortSignal
  ): Promise<Record<string, unknown>> {
    const { apiKey, baseUrl = DEFAULT_BASE_URL } = requireConfig(config, 'elevenlabs');

    const response = await sendRequest(`${baseUrl}${VOICES_PATH}`, {
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
      signal,
    });

    if (!response.ok) {
      throw mapElevenLabsError(response.status, await response.text());
    }

    const payload: unknown = await response.json();
    return isRecord(payload) ? payload : {};
  }
}

/** Narrow a labels value to a known gender. */
function parseGender(value: string | undefined): Voice['gender'] {
  return value === 'male' || value === 'female' || value === 'neutral' ? value : undefined;
}

interface CharTiming {
  char: string;
  startMs: number;
  endMs: number;
}

/**
 * Align the response's character timings, or `undefined` for sentence-level
 * highlight.
 *
 * `alignment` is preferred because it indexes the text that was sent;
 * `normalized_alignment` is only a fallback, since it indexes the text
 * ElevenLabs actually spoke and therefore often fails to line up.
 */
function resolveTimings(
  sentenceText: string,
  payload: Record<string, unknown>
): WordTiming[] | undefined {
  const chars =
    readAlignment(readRecord(payload, 'alignment')) ??
    readAlignment(readRecord(payload, 'normalized_alignment'));
  if (!chars) return undefined;

  let durationMs = 0;
  for (const char of chars) {
    if (char.endMs > durationMs) durationMs = char.endMs;
  }
  if (durationMs <= 0) return undefined;

  return alignTimings(sentenceText, { kind: 'chars', chars }, durationMs);
}

/**
 * Read the three parallel alignment arrays into per-character timings.
 *
 * Seconds are converted to milliseconds here so the rest of the extension
 * only ever deals in one unit.
 */
function readAlignment(source: Record<string, unknown> | undefined): CharTiming[] | undefined {
  if (!source) return undefined;

  const characters = readArray(source, 'characters');
  const starts = readArray(source, 'character_start_times_seconds');
  const ends = readArray(source, 'character_end_times_seconds');
  if (!characters || !starts || !ends) return undefined;

  // Mismatched lengths mean the alignment does not describe this audio.
  if (characters.length !== starts.length || characters.length !== ends.length) return undefined;
  if (characters.length === 0) return undefined;

  const chars: CharTiming[] = [];
  for (let index = 0; index < characters.length; index++) {
    const char = characters[index];
    const start = starts[index];
    const end = ends[index];
    if (typeof char !== 'string' || typeof start !== 'number' || typeof end !== 'number') {
      return undefined;
    }
    chars.push({ char, startMs: start * 1000, endMs: end * 1000 });
  }

  return chars;
}

/** End of the last timing, used as the audio duration when the API omits one. */
function lastEndMs(timings: WordTiming[] | undefined): number {
  let last = 0;
  for (const timing of timings ?? []) {
    if (timing.endMs > last) last = timing.endMs;
  }
  return last;
}
