/** Structural view of the parts of `chrome.tts` this module uses. */
export interface TtsEventLike {
  type: string;
  charIndex?: number;
  length?: number;
  errorMessage?: string;
}

export interface TtsVoiceLike {
  voiceName?: string;
  lang?: string;
  eventTypes?: string[];
  remote?: boolean;
}

export interface TtsSpeakOptions {
  voiceName?: string;
  rate?: number;
  lang?: string;
  /** 0–1. `chrome.tts` has no louder setting and rejects anything outside. */
  volume?: number;
  enqueue?: boolean;
  onEvent?: (event: TtsEventLike) => void;
}

export interface TtsApi {
  speak(utterance: string, options: TtsSpeakOptions): unknown;
  stop(): void;
  getVoices(): Promise<TtsVoiceLike[]>;
}

export interface SpeakRequest {
  text: string;
  voice?: string;
  rate: number;
  lang: string;
  /** 0–1.5. A speaker that cannot go louder clamps it rather than refusing. */
  volume?: number;
  /**
   * Resume playback from this position within the sentence, in milliseconds.
   * Used after pause to continue from where it left off. Only supported by
   * cloud and local providers; browser voice ignores this and always starts
   * from the beginning.
   */
  resumeTimeMs?: number;
}

/** A sentence to warm in the cache before it is needed (spec §5.3). */
export interface PrefetchRequest {
  text: string;
  voice?: string;
}

/** Word span in sentence-relative character offsets. */
export interface WordSpan {
  charStart: number;
  charEnd: number;
}

export interface SpeakerEvents {
  start: undefined;
  word: WordSpan;
  end: undefined;
  error: string;
  /** Emitted when playback is paused, with the current position in milliseconds. */
  paused: number;
}

export interface Speaker {
  speak(request: SpeakRequest): void;
  /**
   * Warm the cache for sentences expected to play soon. Optional: the browser
   * voice has nothing to warm, and leaving it undefined is what makes the
   * engine's `speaker.prefetch?.(...)` a no-op for it.
   */
  prefetch?(requests: readonly PrefetchRequest[]): void;
  /**
   * Change the loudness of the sentence that is playing. Optional: `chrome.tts`
   * takes the volume per utterance, so the browser voice has nothing to change
   * live and reads the next request's instead.
   */
  setVolume?(volume: number): void;
  /**
   * Get the current playback position within the sentence, in milliseconds.
   * Optional: only meaningful for speakers that use an audio element (cloud and
   * local providers). Browser voice has no seekable position and returns undefined.
   */
  getCurrentTimeMs?(): number | undefined;
  /**
   * Pause the current utterance without stopping it completely.
   * Optional: speakers that don't support pausing (like browser voice) can use
   * stop() instead, which will restart from the beginning on resume.
   */
  pause?(): void;
  stop(): void;
  on<K extends keyof SpeakerEvents>(
    event: K,
    handler: (payload: SpeakerEvents[K]) => void
  ): () => void;
  dispose(): void;
}

type Handler = (payload: never) => void;

/**
 * Wraps `chrome.tts`.
 *
 * Every `speak()`/`stop()` bumps a generation counter and the event handler
 * captures the generation it was created with. Chrome keeps delivering queued
 * events for an utterance that was stopped or replaced, and those stale events
 * would otherwise drag the cursor backwards.
 */
export class BrowserSpeaker implements Speaker {
  private generation = 0;
  private readonly listeners = new Map<keyof SpeakerEvents, Set<Handler>>();

  constructor(private readonly tts: TtsApi) {}

  speak({ text, voice, rate, lang, volume }: SpeakRequest): void {
    const generation = ++this.generation;

    // Flush anything queued so the new sentence starts immediately.
    this.tts.stop();

    this.tts.speak(text, {
      voiceName: voice,
      rate,
      lang,
      volume: elementVolume(volume),
      enqueue: false,
      onEvent: (event) => {
        if (generation !== this.generation) return;
        this.handleEvent(event, text.length);
      },
    });
  }

  stop(): void {
    // Invalidate in-flight events before asking Chrome to stop.
    this.generation++;
    this.tts.stop();
  }

  on<K extends keyof SpeakerEvents>(
    event: K,
    handler: (payload: SpeakerEvents[K]) => void
  ): () => void {
    let handlers = this.listeners.get(event);
    if (!handlers) {
      handlers = new Set();
      this.listeners.set(event, handlers);
    }
    handlers.add(handler as Handler);
    return () => {
      handlers.delete(handler as Handler);
    };
  }

  dispose(): void {
    this.stop();
    this.listeners.clear();
  }

  private handleEvent(event: TtsEventLike, textLength: number): void {
    switch (event.type) {
      case 'start':
        this.emit('start', undefined);
        return;
      case 'end':
        this.emit('end', undefined);
        return;
      case 'error':
        this.emit('error', event.errorMessage ?? 'browser voice failed');
        return;
      case 'word': {
        const span = wordSpan(event, textLength);
        // No usable length means we cannot place the word without guessing,
        // and the spec forbids estimating timings. Sentence highlight carries on.
        if (span) this.emit('word', span);
        return;
      }
      default:
        // interrupted / cancelled / sentence / marker / pause / resume
        return;
    }
  }

  private emit<K extends keyof SpeakerEvents>(event: K, payload: SpeakerEvents[K]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      (handler as (value: SpeakerEvents[K]) => void)(payload);
    }
  }
}

/**
 * A volume `chrome.tts` can take, or undefined to leave its own default.
 *
 * The API's maximum is 1 and a value outside the range is an error rather than
 * something it clamps, so the top of the extension's 0–150% range is dropped
 * here instead of being passed through.
 */
function elementVolume(volume: number | undefined): number | undefined {
  if (volume === undefined || !Number.isFinite(volume)) return undefined;
  return Math.min(1, Math.max(0, volume));
}

/**
 * Chrome reports the word event at a word boundary with `charIndex` at the
 * start of the word about to be spoken and `length` its length, so the span is
 * the word currently being spoken.
 */
function wordSpan(event: TtsEventLike, textLength: number): WordSpan | null {
  const charStart = event.charIndex;
  const length = event.length;
  if (typeof charStart !== 'number' || charStart < 0 || charStart >= textLength) return null;
  if (typeof length !== 'number' || length <= 0) return null;

  const charEnd = Math.min(charStart + length, textLength);
  return charEnd > charStart ? { charStart, charEnd } : null;
}

/** Primary subtags SayLoud offers for the browser voice. */
const SUPPORTED_LANGS = ['zh', 'en', 'ja'];

/** True when a voice speaks one of the languages P1 supports. */
export function isSupportedVoice(voice: TtsVoiceLike): boolean {
  const lang = voice.lang?.toLowerCase() ?? '';
  return SUPPORTED_LANGS.some((prefix) => lang === prefix || lang.startsWith(`${prefix}-`));
}

/** Primary subtag of a BCP-47 tag, lowercased. */
function primarySubtag(tag: string): string {
  return tag.split('-')[0] ?? tag;
}

function tagOf(voice: TtsVoiceLike): string {
  return voice.lang?.toLowerCase() ?? '';
}

/**
 * Choose a voice for `lang`.
 *
 * Only voices for the languages P1 supports are eligible, so a page in an
 * unsupported language still reads with a voice we can drive. Within those,
 * an exact tag match wins, then the same primary subtag, then English as the
 * universal fallback, then any supported voice. Local voices win ties: they
 * start faster, and P1 promises instant playback with zero configuration.
 */
export function pickVoice(voices: TtsVoiceLike[], lang: string): TtsVoiceLike | null {
  const candidates = voices.filter(isSupportedVoice);
  if (candidates.length === 0) return null;

  const wanted = lang.toLowerCase();
  const wantedPrimary = primarySubtag(wanted);

  const tiers: Array<(voice: TtsVoiceLike) => boolean> = [
    (voice) => tagOf(voice) === wanted,
    (voice) => primarySubtag(tagOf(voice)) === wantedPrimary,
    (voice) => primarySubtag(tagOf(voice)) === 'en',
  ];

  for (const matches of tiers) {
    const tier = candidates.filter(matches);
    const local = tier.find((voice) => !voice.remote);
    if (local) return local;
    if (tier[0]) return tier[0];
  }

  return candidates.find((voice) => !voice.remote) ?? candidates[0] ?? null;
}

/** All voices SayLoud can use, for the voice list in a later phase. */
export function supportedVoices(voices: TtsVoiceLike[]): TtsVoiceLike[] {
  return voices.filter(isSupportedVoice);
}
