/**
 * Provider-neutral TTS types (spec §2.1).
 *
 * Nothing here mentions a wire format: adapters translate their service's
 * protocol into these shapes, and the playback engine only ever sees these.
 * Character offsets are always relative to the text handed to
 * `Provider.synthesize`, never to the page.
 */
import { ProviderError } from './errors';

/** A voice offered by a provider. */
export interface Voice {
  /** Provider-scoped id, passed back as `SynthesizeRequest.voiceId`. */
  id: string;
  /** Human-readable label for the P3 voice picker. */
  name: string;
  /** BCP-47 tag, e.g. `zh-CN`, `en-US`. */
  lang?: string;
  gender?: 'male' | 'female' | 'neutral';
  /**
   * Whether this voice yields word timings.
   *
   * `undefined` means the provider does not advertise it per voice; the
   * authoritative answer is `capabilities().timings`.
   */
  supportsTimings?: boolean;
}

/** One word, located in both character space and audio time. */
export interface WordTiming {
  /** Offset into the text passed to `synthesize()`. */
  charStart: number;
  charEnd: number;
  /** Offset from the start of the returned audio. */
  startMs: number;
  endMs: number;
}

/** The audio for one sentence, plus timings when the provider supplies them. */
export interface SynthesisResult {
  audio: ArrayBuffer;
  /** IANA media type of `audio`, e.g. `audio/mpeg`, `audio/ogg`, `audio/wav`. */
  mime: string;
  durationMs: number;
  /**
   * Absent when the provider returns no usable timestamps, or when
   * `alignTimings()` rejected them. The caller then highlights the whole
   * sentence instead — SayLoud never estimates word positions.
   */
  timings?: WordTiming[];
}

/** DashScope (阿里云百炼) — CosyVoice / Qwen-TTS over HTTP + SSE. */
export interface DashscopeConfig {
  provider: 'dashscope';
  apiKey: string;
  /** 百炼 workspace (business space) id; required for workspace-scoped keys. */
  workspaceId?: string;
  /** DashScope region. Defaults to `cn-beijing`. */
  region?: 'cn-beijing' | 'intl';
  /** TTS model, e.g. `cosyvoice-v3`. Word timings require CosyVoice v3+. */
  model?: string;
  /** Override for tests or a proxy. Defaults to the region's public host. */
  baseUrl?: string;
}

/** Volcengine (火山引擎豆包) — chunked-JSON HTTP TTS. */
export interface VolcengineConfig {
  provider: 'volcengine';
  /** Volcengine application id (`X-Api-App-Id`). */
  appId: string;
  /** Access token, sent as both `X-Api-Key` and `X-Api-Access-Key`. */
  accessToken: string;
  /** Resource id (`X-Api-Resource-Id`), e.g. `volc.service_type.10029`. */
  resourceId?: string;
  /** Model generation. Only `tts-1.0` reports sentence timings. */
  model?: 'tts-1.0' | 'tts-2.0';
  baseUrl?: string;
}

/** Any OpenAI-compatible speech endpoint, including Kokoro-FastAPI. */
export interface OpenAiCompatConfig {
  provider: 'openai-compat';
  /** Server root, e.g. `https://api.openai.com/v1` or `http://localhost:8880/v1`. */
  baseUrl: string;
  /** Omitted for a local server that needs no auth. */
  apiKey?: string;
  /** Model name sent in the request body. */
  model?: string;
  /**
   * Use Kokoro-FastAPI's `POST /dev/captioned_speech`, which returns the audio
   * and word timestamps in one JSON body instead of raw audio bytes.
   */
  captionedSpeech?: boolean;
  /**
   * Voice list for servers with no `/audio/voices` endpoint. Used by
   * `listVoices()` when the server cannot enumerate its own voices.
   */
  voices?: Voice[];
  /** Extra headers, e.g. for a self-hosted gateway. */
  headers?: Record<string, string>;
}

/** ElevenLabs — `with-timestamps` returns audio plus character alignment. */
export interface ElevenLabsConfig {
  provider: 'elevenlabs';
  apiKey: string;
  /** Model id, e.g. `eleven_multilingual_v2`. */
  model?: string;
  /** Voice settings forwarded verbatim. */
  voiceSettings?: Record<string, unknown>;
  baseUrl?: string;
}

/**
 * Azure Speech.
 *
 * The subscription key is appended to the WebSocket URL by the Speech SDK, so
 * anything that logs a config or a URL must redact `subscriptionKey`.
 */
export interface AzureConfig {
  provider: 'azure';
  subscriptionKey: string;
  /** Azure region slug, e.g. `eastasia`. */
  region: string;
  /** Output format, e.g. `audio-24khz-48kbitrate-mono-mp3`. */
  outputFormat?: string;
  /** Recognition language hint (BCP-47) when the voice id does not imply one. */
  lang?: string;
}

/** The P1 browser voice, kept in the union so config can select it uniformly. */
export interface BrowserConfig {
  provider: 'browser';
  /** Preferred BCP-47 language; `BrowserSpeaker` resolves the actual voice. */
  lang?: string;
}

/** Config variants keyed by provider id. */
export interface ProviderConfigMap {
  dashscope: DashscopeConfig;
  volcengine: VolcengineConfig;
  'openai-compat': OpenAiCompatConfig;
  elevenlabs: ElevenLabsConfig;
  azure: AzureConfig;
  browser: BrowserConfig;
}

export type ProviderId = keyof ProviderConfigMap;

/** Discriminated union of every provider's configuration. */
export type ProviderConfig = ProviderConfigMap[ProviderId];

/** What a provider can do with a given config. */
export interface ProviderCapabilities {
  /**
   * `'exact'` only when the provider returns real timestamps. There is no
   * `'estimated'` — SayLoud degrades to sentence-level highlight instead.
   */
  timings: 'exact' | 'none';
  /** Maximum characters accepted by one `synthesize()` call. */
  maxChars: number;
  /** Suggested in-flight request count for the Phase 2 prefetcher. */
  concurrency: number;
}

/** One sentence to synthesize. */
export interface SynthesizeRequest {
  /** Sentence text; `WordTiming` offsets are relative to this string. */
  text: string;
  voiceId: string;
  /** Cancels the request when the user seeks, stops, or changes voice. */
  signal: AbortSignal;
}

/** A cloud TTS adapter. */
export interface Provider {
  readonly id: ProviderId;
  readonly name: string;

  capabilities(config: ProviderConfig): ProviderCapabilities;

  /** Verifies credentials for the P3 "test connection" button. */
  validate(config: ProviderConfig, signal: AbortSignal): Promise<void>;

  /** Lists the voices this config can use. */
  listVoices(config: ProviderConfig, signal: AbortSignal): Promise<Voice[]>;

  /** Synthesizes one sentence. */
  synthesize(request: SynthesizeRequest, config: ProviderConfig): Promise<SynthesisResult>;
}

/**
 * Narrow a config union member to a specific provider.
 *
 * `Provider` takes the whole union so adapters stay interchangeable in a
 * registry, and each adapter calls this once at its entry points to get its
 * own config type. A mismatch means a wiring bug, not a user error, so it
 * throws rather than degrading.
 */
export function requireConfig<K extends ProviderId>(
  config: ProviderConfig,
  provider: K
): ProviderConfigMap[K] {
  if (config.provider !== provider) {
    throw new ProviderError(
      'unknown',
      `expected a ${provider} config, received ${config.provider}`
    );
  }
  return config as ProviderConfigMap[K];
}
