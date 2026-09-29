/**
 * The concrete Azure Speech SDK binding.
 *
 * This module is reachable only through the dynamic `import()` in `azure.ts`,
 * so the SDK (~400KB) is code-split into its own chunk and never reaches the
 * content script. `azure.ts` owns the seam and the error vocabulary; this file
 * owns the translation to and from the SDK's types.
 *
 * Importing `./azure` here is not a load-order hazard: the only path into this
 * module is the dynamic import inside a method of `AzureProvider`, which
 * cannot run before `./azure` has finished evaluating.
 */
import {
  CancellationDetails,
  PropertyId,
  ResultReason,
  SpeechConfig,
  SpeechSynthesisBoundaryType,
  SpeechSynthesisOutputFormat,
  SpeechSynthesizer,
  SynthesisVoiceGender,
} from 'microsoft-cognitiveservices-speech-sdk';
import type {
  AzureOutputFormat,
  AzureSpeakResult,
  AzureSpeechSdk,
  AzureSynthesizer,
  AzureSynthesizerOptions,
  AzureWordBoundary,
} from './azure';
import { mapCancellationError } from './azure';
import type { Voice } from './types';

/**
 * Our format vocabulary, mapped onto the SDK's enum.
 *
 * An explicit table rather than a name transform: the SDK's identifiers
 * (`Audio24Khz48KBitRateMonoMp3`) do not round-trip from ours.
 */
const OUTPUT_FORMATS: Record<AzureOutputFormat, SpeechSynthesisOutputFormat> = {
  mp3_24khz_48k: SpeechSynthesisOutputFormat.Audio24Khz48KBitRateMonoMp3,
  mp3_16khz_32k: SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3,
  wav_24khz_16bit: SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm,
  ogg_16khz_opus: SpeechSynthesisOutputFormat.Ogg16Khz16BitMonoOpus,
};

/** The SDK measures audio positions in 100-nanosecond ticks. */
const TICKS_PER_MS = 10_000;

/** Create the real SDK binding. */
export function createAzureSpeechSdk(): AzureSpeechSdk {
  return {
    async createSynthesizer(options: AzureSynthesizerOptions): Promise<AzureSynthesizer> {
      const speechConfig = SpeechConfig.fromSubscription(options.subscriptionKey, options.region);

      if (options.voiceName) speechConfig.speechSynthesisVoiceName = options.voiceName;
      if (options.lang) speechConfig.speechSynthesisLanguage = options.lang;
      speechConfig.speechSynthesisOutputFormat = OUTPUT_FORMATS[options.outputFormat];

      // Word boundary events are off by default in the JS SDK — without this
      // property the `wordBoundary` handler never fires.
      speechConfig.setProperty(PropertyId.SpeechServiceResponse_RequestWordBoundary, 'true');
      // Punctuation boundaries are requested by default and would arrive as
      // extra "words"; SayLoud only wants word boundaries.
      speechConfig.setProperty(
        PropertyId.SpeechServiceResponse_RequestPunctuationBoundary,
        'false'
      );

      // No AudioConfig: the audio is delivered in `result.audioData`.
      return new SdkSynthesizer(new SpeechSynthesizer(speechConfig));
    },
  };
}

class SdkSynthesizer implements AzureSynthesizer {
  private closed = false;

  constructor(private readonly synthesizer: SpeechSynthesizer) {}

  speak(
    text: string,
    onWordBoundary: (boundary: AzureWordBoundary) => void,
    signal: AbortSignal
  ): Promise<AzureSpeakResult> {
    return new Promise<AzureSpeakResult>((resolve, reject) => {
      let settled = false;

      const settle = (finish: () => void): void => {
        if (settled) return;
        settled = true;
        signal.removeEventListener('abort', onAbort);
        finish();
      };

      const onAbort = (): void => {
        // The SDK exposes no cancellation API for synthesis — only
        // AvatarSynthesizer has stopSpeakingAsync — so closing the synthesizer
        // is the only way to stop the request. It also tears down the
        // WebSocket, which is what we want.
        this.close();
        settle(() => reject(abortError()));
      };

      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      this.synthesizer.wordBoundary = (_sender, event) => {
        // Punctuation boundaries are disabled above; filtering again keeps a
        // service-side change from injecting non-words into the timeline.
        if (event.boundaryType !== SpeechSynthesisBoundaryType.Word) return;

        onWordBoundary({
          textOffset: event.textOffset,
          audioOffsetMs: ticksToMs(event.audioOffset),
          durationMs: ticksToMs(event.duration),
        });
      };

      this.synthesizer.speakTextAsync(
        text,
        (result) => {
          if (result.reason === ResultReason.SynthesizingAudioCompleted) {
            settle(() =>
              resolve({
                audio: result.audioData,
                durationMs: ticksToMs(result.audioDuration),
              })
            );
            return;
          }

          const details = CancellationDetails.fromResult(result);
          settle(() =>
            reject(
              mapCancellationError(
                details.ErrorCode,
                details.errorDetails || `Azure synthesis ended with reason ${result.reason}`
              )
            )
          );
        },
        (error) => {
          settle(() => reject(mapCancellationError(undefined, error)));
        }
      );
    });
  }

  async listVoices(locale: string | undefined, signal: AbortSignal): Promise<Voice[]> {
    const result = await this.synthesizer.getVoicesAsync(locale);

    // getVoicesAsync takes no signal; honour a cancellation that landed while
    // it was in flight rather than returning a list the caller no longer wants.
    if (signal.aborted) throw abortError();

    const voices: Voice[] = [];
    for (const info of result.voices ?? []) {
      const gender = genderOf(info.gender);
      voices.push({
        id: info.name,
        name: info.localName || info.name,
        ...(info.locale ? { lang: info.locale } : {}),
        ...(gender ? { gender } : {}),
        supportsTimings: true,
      });
    }

    return voices;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.synthesizer.close();
  }
}

function ticksToMs(ticks: number): number {
  return typeof ticks === 'number' && Number.isFinite(ticks) ? ticks / TICKS_PER_MS : 0;
}

function genderOf(gender: SynthesisVoiceGender): Voice['gender'] {
  switch (gender) {
    case SynthesisVoiceGender.Female:
      return 'female';
    case SynthesisVoiceGender.Male:
      return 'male';
    case SynthesisVoiceGender.Neutral:
      return 'neutral';
    default:
      return undefined;
  }
}

/**
 * An error shaped like the one `fetch` rejects with, so the shared
 * `isAbortError` recognizes it and callers treat cancellation as their own
 * decision rather than a provider failure.
 */
function abortError(): Error {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
