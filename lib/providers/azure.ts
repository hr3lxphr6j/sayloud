/**
 * Azure Speech adapter.
 *
 * Azure is the odd one out: it has no HTTP TTS endpoint in this design, only
 * the Speech SDK, which opens a WebSocket and streams `WordBoundary` events
 * while it synthesizes. Those events carry a character offset and an audio
 * offset, which is exactly the `offset` timing format — so Azure gives word
 * level highlight with no text matching involved.
 *
 * The SDK itself lives behind the `AzureSpeechSdk` seam defined here and is
 * implemented in `azure-sdk.ts`, which is reachable only through a dynamic
 * `import()`. Two reasons:
 *
 * 1. The SDK is ~400KB and must never reach the content script, so
 *    it may only be loaded in the offscreen document, at synthesis time.
 * 2. Unit tests inject a fake SDK and never load the real one, which is what
 *    makes this provider testable at all — the alternative was compile-only
 *    coverage with everything deferred to E2E.
 *
 * The subscription key is appended to the WebSocket URL by the SDK. Nothing
 * here logs or includes that URL in an error: a leaked query string would leak
 * the key, so errors carry only the SDK's own code and message.
 */

import { alignTimings } from './align-timings';
import { isProviderError, ProviderError, type ProviderErrorCode } from './errors';
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
 * Output formats SayLoud offers.
 *
 * Deliberately a small, friendly vocabulary rather than the SDK's enum names,
 * which are an implementation detail of the binding layer.
 */
export type AzureOutputFormat =
  | 'mp3_24khz_48k'
  | 'mp3_16khz_32k'
  | 'wav_24khz_16bit'
  | 'ogg_16khz_opus';

export const DEFAULT_OUTPUT_FORMAT: AzureOutputFormat = 'mp3_24khz_48k';

const MIME_BY_FORMAT: Record<AzureOutputFormat, string> = {
  mp3_24khz_48k: 'audio/mpeg',
  mp3_16khz_32k: 'audio/mpeg',
  wav_24khz_16bit: 'audio/wav',
  ogg_16khz_opus: 'audio/ogg',
};

/** True when `value` is one of the formats this adapter understands. */
export function isAzureOutputFormat(value: string): value is AzureOutputFormat {
  return value in MIME_BY_FORMAT;
}

/**
 * The SDK's `CancellationErrorCode` values.
 *
 * Mirrored as plain numbers so this module never imports the SDK; `azure-sdk`
 * asserts the two stay in step.
 */
export const AZURE_CANCELLATION_CODES = {
  noError: 0,
  authenticationFailure: 1,
  badRequestParameters: 2,
  tooManyRequests: 3,
  connectionFailure: 4,
  serviceTimeout: 5,
  serviceError: 6,
  runtimeError: 7,
  /** Documented as "quota overrun on existing key". */
  forbidden: 8,
} as const;

const CODE_TO_ERROR: Record<number, ProviderErrorCode> = {
  [AZURE_CANCELLATION_CODES.authenticationFailure]: 'invalid-key',
  [AZURE_CANCELLATION_CODES.tooManyRequests]: 'rate-limit',
  [AZURE_CANCELLATION_CODES.connectionFailure]: 'network-error',
  [AZURE_CANCELLATION_CODES.serviceTimeout]: 'service-unavailable',
  [AZURE_CANCELLATION_CODES.serviceError]: 'service-unavailable',
  [AZURE_CANCELLATION_CODES.forbidden]: 'no-quota',
  [AZURE_CANCELLATION_CODES.badRequestParameters]: 'unknown',
  [AZURE_CANCELLATION_CODES.runtimeError]: 'unknown',
};

/**
 * Map an SDK cancellation code to a unified one.
 *
 * `details` carries only the code and message: the SDK's error details can
 * echo the request URL, which contains the subscription key.
 */
export function mapCancellationError(code: number | undefined, message: string): ProviderError {
  const mapped = code === undefined ? undefined : CODE_TO_ERROR[code];
  return new ProviderError(mapped ?? 'unknown', message, { code });
}

/** One `WordBoundary` event, converted out of the SDK's units. */
export interface AzureWordBoundary {
  /** Offset into the text passed to `speak()`. */
  textOffset: number;
  /** Offset from the start of the audio. */
  audioOffsetMs: number;
  durationMs: number;
}

export interface AzureSpeakResult {
  audio: ArrayBuffer;
  /** 0 when the SDK reports no duration. */
  durationMs: number;
}

/** What `AzureProvider` needs from the SDK, per request. */
export interface AzureSynthesizer {
  speak(
    text: string,
    onWordBoundary: (boundary: AzureWordBoundary) => void,
    signal: AbortSignal
  ): Promise<AzureSpeakResult>;
  listVoices(locale: string | undefined, signal: AbortSignal): Promise<Voice[]>;
  /** Releases the WebSocket. Safe to call more than once. */
  close(): void;
}

export interface AzureSynthesizerOptions {
  subscriptionKey: string;
  region: string;
  /** Only needed for synthesis; voice listing and key validation omit it. */
  voiceName?: string;
  outputFormat: AzureOutputFormat;
  /** BCP-47 hint; the SDK infers the language from the voice name when omitted. */
  lang?: string;
}

/** The seam: everything `AzureProvider` uses from the Speech SDK. */
export interface AzureSpeechSdk {
  createSynthesizer(options: AzureSynthesizerOptions): Promise<AzureSynthesizer>;
}

export type AzureSdkFactory = () => Promise<AzureSpeechSdk>;

/**
 * Load the real SDK.
 *
 * The dynamic specifier keeps the SDK in its own chunk: nothing that merely
 * imports this module pays for it.
 */
async function loadAzureSpeechSdk(): Promise<AzureSpeechSdk> {
  const module = await import('./azure-sdk');
  return module.createAzureSpeechSdk();
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** assumed: the per-request character cap. */
const MAX_CHARS = 5000;

const CONCURRENCY = 2;

export class AzureProvider implements Provider {
  readonly id = 'azure' as const;
  readonly name = 'Azure Speech';

  constructor(private readonly loadSdk: AzureSdkFactory = loadAzureSpeechSdk) {}

  capabilities(config: ProviderConfig): ProviderCapabilities {
    requireConfig(config, 'azure');

    return {
      // The SDK always reports WordBoundary events when they are requested.
      timings: 'exact',
      maxChars: MAX_CHARS,
      concurrency: CONCURRENCY,
    };
  }

  /**
   * Verify the key and region against the voices endpoint.
   *
   * This costs no synthesis quota, and unlike a probe synthesis it fails
   * cleanly for a wrong region rather than a wrong voice.
   */
  async validate(config: ProviderConfig, signal: AbortSignal): Promise<void> {
    const { synthesizer } = await this.open(config);
    try {
      await synthesizer.listVoices(requireConfig(config, 'azure').lang, signal);
    } finally {
      synthesizer.close();
    }
  }

  async listVoices(config: ProviderConfig, signal: AbortSignal): Promise<Voice[]> {
    const { synthesizer } = await this.open(config);
    try {
      return await synthesizer.listVoices(requireConfig(config, 'azure').lang, signal);
    } finally {
      synthesizer.close();
    }
  }

  async synthesize(request: SynthesizeRequest, config: ProviderConfig): Promise<SynthesisResult> {
    if (!request.voiceId) {
      throw new ProviderError('unknown', 'Azure requires a voice id');
    }

    const { synthesizer, outputFormat } = await this.open(config, request.voiceId);

    try {
      const boundaries: AzureWordBoundary[] = [];
      const result = await synthesizer.speak(
        request.text,
        (boundary) => boundaries.push(boundary),
        request.signal
      );

      const durationMs = result.durationMs > 0 ? result.durationMs : lastBoundaryEnd(boundaries);

      return {
        audio: result.audio,
        mime: MIME_BY_FORMAT[outputFormat],
        durationMs,
        timings: resolveTimings(request.text, boundaries, durationMs),
      };
    } finally {
      // Every call opens a WebSocket, and a leaked one is a memory leak, so
      // the synthesizer is always released.
      synthesizer.close();
    }
  }

  /**
   * Open a synthesizer for a config.
   *
   * `voiceName` is only meaningful for synthesis; voice listing and key
   * validation open a synthesizer without one.
   */
  private async open(
    config: ProviderConfig,
    voiceName?: string
  ): Promise<{ synthesizer: AzureSynthesizer; outputFormat: AzureOutputFormat }> {
    const azure = requireConfig(config, 'azure');
    const outputFormat = resolveOutputFormat(azure.outputFormat);

    let sdk: AzureSpeechSdk;
    try {
      sdk = await this.loadSdk();
    } catch (error) {
      // A failed chunk load is the user-visible failure mode of lazy loading,
      // so it is reported as a provider problem rather than a raw throw.
      if (isProviderError(error)) throw error;
      throw new ProviderError(
        'service-unavailable',
        `Azure Speech SDK could not be loaded: ${describe(error)}`,
        error
      );
    }

    return {
      outputFormat,
      synthesizer: await sdk.createSynthesizer({
        subscriptionKey: azure.subscriptionKey,
        region: azure.region,
        outputFormat,
        ...(voiceName ? { voiceName } : {}),
        ...(azure.lang ? { lang: azure.lang } : {}),
      }),
    };
  }
}

/** Narrow a config value, falling back to the default for an unknown format. */
function resolveOutputFormat(value: string | undefined): AzureOutputFormat {
  return value !== undefined && isAzureOutputFormat(value) ? value : DEFAULT_OUTPUT_FORMAT;
}

/**
 * Align the boundary events.
 *
 * Azure reports a character offset and an audio offset per word, so the marks
 * map straight onto the sentence — no text matching, and no chance of a
 * normalized-text mismatch.
 */
function resolveTimings(
  sentenceText: string,
  boundaries: AzureWordBoundary[],
  durationMs: number
): WordTiming[] | undefined {
  if (boundaries.length === 0 || durationMs <= 0) return undefined;

  const marks = boundaries.map((boundary) => ({
    charIndex: boundary.textOffset,
    timeMs: boundary.audioOffsetMs,
  }));

  return alignTimings(sentenceText, { kind: 'offset', marks }, durationMs);
}

/** End of the last boundary, used when the SDK reports no duration. */
function lastBoundaryEnd(boundaries: AzureWordBoundary[]): number {
  let last = 0;
  for (const boundary of boundaries) {
    const end = boundary.audioOffsetMs + boundary.durationMs;
    if (end > last) last = end;
  }
  return last;
}
