import { pickVoice, type TtsApi, type TtsVoiceLike } from './speaker';

/**
 * Bridges `chrome.tts.getVoices()` (async) to the engine's synchronous
 * `VoiceResolver`.
 *
 * The engine resolves a voice per sentence, so calling `getVoices()` each time
 * would be wasteful; the cache is refreshed once at startup and again whenever
 * Chrome reports the voice list changed.
 */
export class VoiceCache {
  private voices: TtsVoiceLike[] = [];
  private inFlight: Promise<void> | null = null;

  constructor(private readonly tts: TtsApi) {}

  /** Refresh from the browser; concurrent callers share one request. */
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;

    this.inFlight = this.tts
      .getVoices()
      .then((voices) => {
        this.voices = voices;
      })
      .catch(() => {
        // Keep the previous list: a transient failure should not disable playback.
      })
      .finally(() => {
        this.inFlight = null;
      });

    return this.inFlight;
  }

  get size(): number {
    return this.voices.length;
  }

  /** True before the first successful refresh. */
  get isEmpty(): boolean {
    return this.voices.length === 0;
  }

  /**
   * Returns undefined when no supported voice exists, and an empty string when
   * the chosen voice is unnamed — `chrome.tts` reads that as "any available".
   */
  resolve(lang: string): string | undefined {
    const voice = pickVoice(this.voices, lang);
    if (!voice) return undefined;
    return voice.voiceName ?? '';
  }
}
