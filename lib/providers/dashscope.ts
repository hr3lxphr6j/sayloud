/**
 * DashScope (阿里云百炼) adapter — CosyVoice / Qwen-TTS (spec §2.2, §6 V4).
 *
 * Transport is HTTP + SSE: the request sets `X-DashScope-SSE: enable` and the
 * service answers with `text/event-stream`, one JSON object per frame, whose
 * `output.audio.data` carries base64 audio chunks.
 *
 * Verified against the live API with real keys on 2026-09-29 (spec §6 V4),
 * using `cosyvoice-v3-flash` + voice `longanyang`, `cosyvoice-v3-plus` and
 * `qwen-audio-3.0-tts-flash`, on both the workspace-scoped and the general
 * host, with the first packet arriving in about 0.35–0.7 s:
 *
 * - SSE is standard framing (`id:` / `event:` / `:HTTP_STATUS` / `data:`, a
 *   blank line ends a frame) with `sentence-begin` / `sentence-synthesis` /
 *   `sentence-end` events.
 * - Word timings require `word_timestamp_enabled` in `parameters` and are only
 *   available in streaming mode. Each word carries `begin_index` / `end_index`
 *   together with `begin_time` / `end_time`.
 * - `begin_index` / `end_index` are **word ordinals, not character offsets**:
 *   Chinese is split per character, English per word, and an English word
 *   carries its leading space (`' quick'`). The words are therefore located in
 *   the sentence by their own text, in reading order — `sequential-words`, the
 *   same alignment Kokoro uses — never by reading the ordinals as offsets.
 * - The service normalizes what it speaks: "1.27" is read as "一点二七", "35%"
 *   as "百分之三十五", and a URL as "H T T P S". A word that is not a verbatim
 *   substring of the sentence is skipped rather than estimated.
 * - The service splits sentences on its own, and delivers `words` incrementally
 *   across frames, so the stream is de-duplicated on
 *   `(sentence.index, begin_index)` and concatenated. The times are absolute
 *   against the whole audio. `maxChars` is 200, which keeps one request to one
 *   sentence, but several `sentence.index` values are still merged.
 * - `cosyvoice-v3.5-flash` plus a system voice answers 400 ("Engine return
 *   error code: 418"), so the voice catalogue is filtered by model.
 * - `qwen3-tts-flash` streams WAV chunks and puts a download `url` on its last
 *   frame; it reports no timings at all.
 *
 * What the spike did not record is marked `assumed:` below: the request body's
 * field names, the unit of `begin_time` / `end_time`, the name of the field
 * that carries each word's text, and the form of the workspace host on the
 * international region. Where the shape is ambiguous the parser accepts field
 * aliases, so a mismatch degrades to sentence-level highlight instead of
 * losing the audio.
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

/**
 * The general host for each region the spec offers (spec §2.2).
 *
 * `ap-southeast-1` is the spec's name for the Singapore region, whose host is
 * the international one — §2.2 gives the general Qwen-TTS endpoint as
 * `https://dashscope.aliyuncs.com/...` with the parenthetical "国际站用
 * `dashscope-intl`", so the two names describe one host and the region value
 * follows the spec's own vocabulary.
 */
const REGION_BASE_URLS = {
  'cn-beijing': 'https://dashscope.aliyuncs.com',
  'ap-southeast-1': 'https://dashscope-intl.aliyuncs.com',
} as const;

/** DashScope's default region, and the one CosyVoice's HTTP API is open in. */
export const DEFAULT_REGION = 'cn-beijing';

/**
 * The default region's host, exported so the settings schema can offer it as
 * the form's default without keeping a second copy of the URL.
 */
export const DEFAULT_BASE_URL: string = REGION_BASE_URLS[DEFAULT_REGION];

/**
 * The workspace-scoped host for CosyVoice and Qwen-Audio-TTS (spec §2.2).
 *
 * V4 measured the workspace domain and the general domain both working, so
 * either is valid; the workspace host is used when a workspace id is set
 * because it names the workspace explicitly, and the general host stays the
 * default so a workspace-less config is unaffected. The `{region}` segment is
 * the spec's own placeholder, so the international region resolves to
 * `{WorkspaceId}.ap-southeast-1.maas.aliyuncs.com`; V4 exercised the workspace
 * domain on the Beijing region only, so that form is `assumed:`.
 */
const WORKSPACE_HOST = (workspaceId: string, region: string): string =>
  `https://${workspaceId}.${region}.maas.aliyuncs.com`;

/** assumed: the SpeechSynthesizer service path (the host above is from §2.2). */
const SYNTHESIZE_PATH = '/api/v1/services/audio/tts/SpeechSynthesizer';

/** mp3 is the format every CosyVoice revision supports. */
const AUDIO_FORMAT = 'mp3';
const AUDIO_MIME = 'audio/mpeg';
const SAMPLE_RATE = 22050;

/**
 * Default model: the revision V4 actually exercised (spec §6 V4).
 *
 * v3 is the oldest family that reports word timings, and word-level highlight
 * is the point of the cloud providers, so the default has to be one that can
 * produce it — and one whose voice catalogue is known.
 */
export const DEFAULT_MODEL = 'cosyvoice-v3-flash';

/**
 * The voice V4 exercised against `cosyvoice-v3-flash` and `cosyvoice-v3-plus`
 * (spec §6 V4).
 */
const V3_DEFAULT_VOICE = 'longanyang';

/** The v1/v2 catalogue's first entry, used as the fallback for older models. */
const V1_DEFAULT_VOICE = 'longxiaochun';

/**
 * The engine's per-request character cap (spec §2.2, §6 V4).
 *
 * CosyVoice itself allows 600 characters, but the service splits sentences on
 * its own — V4 measured a 310-character request coming back as `sentence.index`
 * 0 and 1 — so 200 keeps one request to one sentence and the alignment simple.
 * The adapter still merges several `sentence.index` values in case one slips
 * through.
 */
const MAX_CHARS = 200;

/** DashScope tolerates more, but two in flight keeps first-sentence latency low. */
const CONCURRENCY = 2;

/**
 * The CosyVoice v3 system voices.
 *
 * Only `longanyang` is here: V4 exercised it against `cosyvoice-v3-flash` and
 * `cosyvoice-v3-plus` (spec §6 V4). The rest of the v3 catalogue was not
 * recorded by the spike, and voice ids cannot be derived from anything in the
 * repository, so they are deliberately not guessed at — Phase 4 has to confirm
 * them. The display name is the id for the same reason.
 *
 * `cosyvoice-v3.5-flash` takes no system voice at all: V4 measured a 400
 * ("Engine return error code: 418") for exactly that combination, so it is
 * offered no catalogue (see `voicesForModel`).
 */
const V3_VOICES: Voice[] = [{ id: 'longanyang', name: 'longanyang', lang: 'zh-CN' }];

/**
 * The v1/v2 system voices the adapter has always shipped.
 *
 * V4 re-verified none of these — it exercised the v3 family only — so they are
 * kept for the v1/v2 models this adapter still accepts, and they never report
 * timings. DashScope exposes no voice-listing endpoint for SpeechSynthesizer,
 * so the catalogue is maintained here; a user with access to other voices can
 * still type a voice id in the P3 picker.
 */
const V1_VOICES: Voice[] = [
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
 * The catalogue for a model.
 *
 * Voice and model have to match, so the catalogue follows the model rather
 * than being one list for all of them: v3.5 rejects every system voice (V4 ④)
 * and the Qwen models' voice ids were not recorded by the spike, so both get an
 * empty list instead of ids that would only earn a 400.
 */
function voicesForModel(model: string): Voice[] {
  if (model.startsWith('cosyvoice-v3.5')) return [];
  if (model.startsWith('cosyvoice-v3')) return V3_VOICES;
  if (model.startsWith('cosyvoice-')) return V1_VOICES;
  return [];
}

/**
 * The voice a request uses when the caller names none, matched to the model so
 * the two cannot disagree — V4 ④ is exactly a voice/model mismatch.
 */
function defaultVoiceFor(model: string): string {
  return model.startsWith('cosyvoice-v3') ? V3_DEFAULT_VOICE : V1_DEFAULT_VOICE;
}

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
  ModelNotOpen: 'not-activated',
  ModelNotAvailable: 'not-activated',
  ServiceUnavailable: 'service-unavailable',
  InternalError: 'service-unavailable',
};

/**
 * True when `model` reports word timings (spec §2.2, §6 V4).
 *
 * The v3 family does: V4 measured `cosyvoice-v3-flash` and `cosyvoice-v3-plus`
 * answering with `words`, and §2.2 records v3.5 reporting them too. Nothing
 * else is claimed — in particular `qwen3-tts-flash` returns no timings at all
 * (V4).
 */
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
  words: Word[];
  error?: { code?: string; message: string };
}

/** One word as the service reports it: its own text plus an audio span. */
interface Word {
  text: string;
  startMs: number;
  endMs: number;
}

/**
 * What the stream accumulates while its frames are read.
 *
 * `sentenceIndex` carries the last `sentence.index` seen, because V4 records the
 * words being delivered incrementally: a frame that repeats only `words` does
 * not have to repeat the index, and reusing it keeps one sentence's words from
 * colliding with the next sentence's ordinals.
 */
interface WordCollector {
  words: Word[];
  seen: Set<string>;
  sentenceIndex: number;
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
   * synthesis is the only check that also proves the model is activated. The
   * probe voice follows the configured model, since a mismatch is rejected
   * before the key is ever judged (spec §6 V4 ④).
   */
  async validate(config: ProviderConfig, signal: AbortSignal): Promise<void> {
    const { model = DEFAULT_MODEL } = requireConfig(config, 'dashscope');
    await this.synthesize({ text: '你好', voiceId: defaultVoiceFor(model), signal }, config);
  }

  async listVoices(config: ProviderConfig, _signal: AbortSignal): Promise<Voice[]> {
    const { model = DEFAULT_MODEL } = requireConfig(config, 'dashscope');
    const timings = supportsTimings(model);

    return voicesForModel(model).map((voice) => ({ ...voice, supportsTimings: timings }));
  }

  async synthesize(request: SynthesizeRequest, config: ProviderConfig): Promise<SynthesisResult> {
    const {
      apiKey,
      workspaceId,
      region = DEFAULT_REGION,
      model = DEFAULT_MODEL,
      baseUrl,
    } = requireConfig(config, 'dashscope');

    const url = `${resolveBaseUrl(baseUrl, region, workspaceId)}${SYNTHESIZE_PATH}`;
    const timings = supportsTimings(model);

    const response = await sendRequest(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-DashScope-SSE': 'enable',
        ...(workspaceId ? { 'X-DashScope-WorkSpace': workspaceId } : {}),
      },
      // assumed: the body's shape. The spike recorded the response, the framing
      // and the headers, but not the request it sent, so the field names here —
      // and `word_timestamp_enabled`'s place inside `parameters` — still need a
      // live key in Phase 4. The flag's name itself is from §2.2.
      body: JSON.stringify({
        model,
        input: { text: request.text, voice: request.voiceId || defaultVoiceFor(model) },
        parameters: {
          text_type: 'PlainText',
          format: AUDIO_FORMAT,
          sample_rate: SAMPLE_RATE,
          // Without this the service never sends the word frame, so word-level
          // highlight could never work (spec §2.2, §6 V4). Asking a model that
          // cannot report timings for them would only add an empty frame.
          ...(timings ? { word_timestamp_enabled: true } : {}),
        },
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
    const aligned = resolveTimings(request.text, stream.words);

    return {
      audio,
      mime,
      durationMs: lastEndMs(aligned),
      timings: aligned,
    };
  }
}

/**
 * Pick the host a request goes to (spec §2.2, §6 V4).
 *
 * `baseUrl` wins when set, so tests and a proxy keep working. Otherwise a
 * configured `workspaceId` selects the workspace-scoped MaaS host, which V4
 * measured working alongside the general one; without one, the region's
 * general host is used.
 */
function resolveBaseUrl(
  baseUrl: string | undefined,
  region: keyof typeof REGION_BASE_URLS,
  workspaceId?: string
): string {
  if (baseUrl) return baseUrl;
  if (workspaceId) return WORKSPACE_HOST(workspaceId, region);
  return REGION_BASE_URLS[region];
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
  const collector: WordCollector = { words: [], seen: new Set(), sentenceIndex: 0 };
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

    collectWords(output, collector);
  }

  return { chunks, audioUrl, words: collector.words, error };
}

/**
 * Collect word timings from the shapes DashScope uses for them (spec §6 V4).
 *
 * The same word arrives again in a later frame — V4 records `words` being
 * delivered incrementally — so the stream is de-duplicated on
 * `(sentence.index, begin_index)`, the pair the service itself treats as a
 * word's identity. The times are absolute against the whole audio, so frames
 * only have to be concatenated, not shifted.
 */
function collectWords(output: Record<string, unknown>, collector: WordCollector): void {
  const sentence = readRecord(output, 'sentence');
  const index = sentence ? readFirstNumber(sentence, ['index']) : undefined;
  if (index !== undefined) collector.sentenceIndex = index;

  const containers: Array<unknown[] | undefined> = [
    readArray(output, 'words'),
    sentence ? readArray(sentence, 'words') : undefined,
  ];

  for (const container of containers) {
    if (!container) continue;
    for (const entry of container) {
      if (!isRecord(entry)) continue;

      // V4 records the ordinal and time fields by name; which field carries the
      // word's own text it did not, so `text` / `word` stay first and
      // `original_text` — a name V4 did record as present — is accepted last.
      const text = readFirstString(entry, ['text', 'word', 'original_text']);
      // assumed: `begin_time` / `end_time` are milliseconds from the start of
      // the audio. V4 records the field names, not their unit.
      const startMs = readFirstNumber(entry, ['begin_time', 'beginTime', 'startMs']);
      const endMs = readFirstNumber(entry, ['end_time', 'endTime', 'endMs']);
      if (text === undefined || startMs === undefined || endMs === undefined) continue;

      // V4 ①: an English word carries its leading space (`' quick'`). Trimming it
      // keeps the highlight on the word rather than on the gap before it.
      const word = text.trim();
      if (word === '') continue;

      // V4 ③: the same word is repeated across frames, so the ordinal pair is
      // used as the identity. Without an ordinal there is nothing to key on, so
      // the entry is kept as it came.
      const ordinal = readFirstNumber(entry, ['begin_index', 'beginIndex']);
      if (ordinal !== undefined) {
        const key = `${collector.sentenceIndex}:${ordinal}`;
        if (collector.seen.has(key)) continue;
        collector.seen.add(key);
      }

      collector.words.push({ text: word, startMs, endMs });
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
function resolveTimings(sentenceText: string, words: Word[]): WordTiming[] | undefined {
  if (words.length === 0) return undefined;

  // The API reports no separate duration; the last word's end is the closest
  // honest value, and `alignTimings` needs it to close the final span.
  let durationMs = 0;
  for (const word of words) {
    if (word.endMs > durationMs) durationMs = word.endMs;
  }
  if (durationMs <= 0) return undefined;

  // V4 ①: `begin_index` is a word ordinal, not a character offset, so the words
  // are located in the sentence by their text, in order — `sequential-words`
  // (spec §2.2). A word the service normalized ("1.27" read as "一点二七") does
  // not appear in the sentence and is skipped rather than estimated (V4 ②).
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
