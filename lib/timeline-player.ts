/**
 * Plays one synthesized sentence and reports where the playhead is (spec §3.2).
 *
 * This is the only place in the extension that touches an `<audio>` element, and
 * it is deliberately dumb about everything else: it holds one sentence at a
 * time, and it knows nothing about sessions, queues, or providers. The service
 * worker decides what to play; this decides when each word is spoken.
 *
 * Two things differ from the spec's sketch, both for correctness:
 *
 * 1. Word delays divide by `playbackRate` instead of dividing the word's own
 *    start time by it. `word.startMs` is in audio time and `currentTime` is in
 *    audio time too, so the wall-clock wait is the gap between them divided by
 *    the rate. Scaling only the word time would drift by a factor of `rate`.
 * 2. The duration comes from the media element, not from the provider. Several
 *    providers report `durationMs: 0`; the element has decoded the real length
 *    by the time `loadedmetadata` fires, and that is what a seek needs.
 */
import type { OffscreenEvent } from './offscreen-protocol';
import type { SynthesisResult, WordTiming } from './providers/types';

/**
 * The slice of `HTMLAudioElement` this module uses.
 *
 * The handler properties are typed from the DOM so a real element satisfies
 * this interface, while tests pass a plain object.
 */
export interface AudioLike {
  src: string;
  currentTime: number;
  playbackRate: number;
  duration: number;
  paused: boolean;
  play(): Promise<void>;
  pause(): void;
  /**
   * Fired once the element knows its duration, or when it cannot be decoded.
   *
   * The player only needs to know that it happened, so these take no event: a
   * test fake can call them with no arguments, and the real element's handlers
   * are wrapped by `createElement` below.
   */
  onloadedmetadata: (() => void) | null;
  onerror: (() => void) | null;
  onended: (() => void) | null;
}

export interface LoadedAudioInfo {
  /** The media element's duration when it has one, the provider's otherwise. */
  durationMs: number;
  hasTimings: boolean;
}

export interface TimelinePlayerDeps {
  /** Reports a word or the end of the sentence to the service worker. */
  emit: (event: OffscreenEvent) => void;
  createAudio?: () => AudioLike;
  createObjectUrl?: (blob: Blob) => string;
  revokeObjectUrl?: (url: string) => void;
  setTimer?: (handler: () => void, delayMs: number) => number;
  clearTimer?: (handle: number) => void;
  /** How long to wait for a decoded duration before giving up on the audio. */
  loadTimeoutMs?: number;
}

/** Long enough for a slow decode of a long sentence, short enough to fail. */
const DEFAULT_LOAD_TIMEOUT_MS = 10_000;

interface Current {
  id: string;
  audio: AudioLike;
  url: string;
  durationMs: number;
  /** Sorted by start time; empty when the provider reported no timings. */
  timings: WordTiming[];
}

export class TimelinePlayer {
  private readonly emit: (event: OffscreenEvent) => void;
  private readonly createAudio: () => AudioLike;
  private readonly createObjectUrl: (blob: Blob) => string;
  private readonly revokeObjectUrl: (url: string) => void;
  private readonly setTimer: (handler: () => void, delayMs: number) => number;
  private readonly clearTimer: (handle: number) => void;
  private readonly loadTimeoutMs: number;

  private current: Current | null = null;
  private timer: number | null = null;
  /** Index into `current.timings` of the next word to report. */
  private nextWordIndex = 0;

  constructor(deps: TimelinePlayerDeps) {
    this.emit = deps.emit;
    this.createAudio = deps.createAudio ?? (() => new Audio() as AudioLike);
    this.createObjectUrl = deps.createObjectUrl ?? ((blob) => URL.createObjectURL(blob));
    this.revokeObjectUrl = deps.revokeObjectUrl ?? ((url) => URL.revokeObjectURL(url));
    this.setTimer = deps.setTimer ?? ((handler, delayMs) => window.setTimeout(handler, delayMs));
    this.clearTimer = deps.clearTimer ?? ((handle) => window.clearTimeout(handle));
    this.loadTimeoutMs = deps.loadTimeoutMs ?? DEFAULT_LOAD_TIMEOUT_MS;
  }

  /** The id of the loaded sentence, or null. */
  get currentId(): string | null {
    return this.current?.id ?? null;
  }

  /** True while the loaded sentence is actually playing. */
  get isPlaying(): boolean {
    return this.current !== null && !this.current.audio.paused;
  }

  /**
   * Decode `result` and make it the current sentence.
   *
   * Anything already loaded is stopped first, so a sentence that is replaced
   * mid-flight cannot keep playing over its successor.
   */
  async load(id: string, result: SynthesisResult): Promise<LoadedAudioInfo> {
    this.stop();

    const url = this.createObjectUrl(new Blob([result.audio], { type: result.mime }));
    const audio = this.createAudio();

    try {
      const durationMs = await this.prepare(audio, url, result.durationMs);
      const timings = sortTimings(result.timings);
      this.current = { id, audio, url, durationMs, timings };
      return { durationMs, hasTimings: timings.length > 0 };
    } catch (error) {
      this.revokeObjectUrl(url);
      throw error;
    }
  }

  /**
   * Start playing the loaded sentence.
   *
   * `startTimeMs` is where the playhead lands; the word timeline is rebuilt from
   * there, so a seek highlights the word it landed on rather than waiting for
   * the next one.
   */
  async play(id: string, startTimeMs = 0): Promise<void> {
    const current = this.current;
    if (!current || current.id !== id) {
      throw new Error(`audio ${id} is not loaded`);
    }

    this.clearTimingTimer();
    this.nextWordIndex = 0;
    current.audio.currentTime = clampTime(startTimeMs, current.durationMs);

    // The ended handler is bound before `play()` because a zero-length clip can
    // end before the promise settles.
    current.audio.onended = () => this.onEnded(current.id);

    try {
      await current.audio.play();
    } catch (error) {
      // A rejection after the sentence was replaced or stopped is the abort of
      // a superseded utterance, not a failure to report.
      if (this.current?.id !== id) return;
      throw error;
    }

    if (this.current?.id !== id) return;
    this.scheduleNextWord();
  }

  pause(): void {
    this.clearTimingTimer();
    this.current?.audio.pause();
  }

  /** Pause and release the loaded sentence. Safe to call at any time. */
  stop(): void {
    this.clearTimingTimer();
    this.nextWordIndex = 0;

    const current = this.current;
    if (!current) return;

    current.audio.onended = null;
    current.audio.onerror = null;
    current.audio.onloadedmetadata = null;
    current.audio.pause();
    this.revokeObjectUrl(current.url);
    this.current = null;
  }

  /**
   * Change the playback rate, keeping the word timeline in step.
   *
   * The audio element plays the same bytes faster, so the schedule is rebuilt
   * from the playhead rather than restarted.
   */
  setRate(rate: number): void {
    const current = this.current;
    if (!current || !Number.isFinite(rate) || rate <= 0) return;

    current.audio.playbackRate = rate;
    if (!current.audio.paused) {
      this.clearTimingTimer();
      this.scheduleNextWord();
    }
  }

  /** Attach the handlers and wait for the element to know its duration. */
  private prepare(audio: AudioLike, url: string, fallbackMs: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      let timer = 0;
      const cleanup = () => {
        this.clearTimer(timer);
        audio.onloadedmetadata = null;
        audio.onerror = null;
      };

      timer = this.setTimer(() => {
        cleanup();
        reject(new Error('the audio did not become ready in time'));
      }, this.loadTimeoutMs);

      audio.onloadedmetadata = () => {
        const mediaMs = audio.duration * 1000;
        cleanup();
        // An unbounded or unparsable duration falls back to whatever the
        // provider reported, which several of them leave at 0.
        resolve(Number.isFinite(mediaMs) && mediaMs > 0 ? Math.round(mediaMs) : fallbackMs);
      };

      audio.onerror = () => {
        cleanup();
        reject(new Error('the audio could not be decoded'));
      };

      // Handlers first, source second: the metadata can be ready before a
      // listener attached afterwards would hear about it.
      audio.src = url;
    });
  }

  private onEnded(id: string): void {
    if (this.current?.id !== id) return;
    this.clearTimingTimer();
    this.emit({ type: 'sentence-end', id });
  }

  /**
   * Wait for the next word's start, then report it and wait for the one after.
   *
   * Words the playhead has already passed are skipped without a report — that
   * is what makes a resume mid-sentence pick up where it left off — except for
   * the word under the playhead, which is reported immediately so a seek
   * highlights where it landed.
   */
  private scheduleNextWord(): void {
    const current = this.current;
    if (!current || current.timings.length === 0) return;

    const rate = playbackRate(current.audio);
    const currentTimeMs = current.audio.currentTime * 1000;

    while (this.nextWordIndex < current.timings.length) {
      const word = current.timings[this.nextWordIndex];
      if (!word) return;

      if (word.endMs <= currentTimeMs) {
        this.nextWordIndex++;
        continue;
      }

      if (word.startMs <= currentTimeMs) {
        this.nextWordIndex++;
        this.emitWord(current.id, word);
        continue;
      }

      const delayMs = Math.max(0, (word.startMs - currentTimeMs) / rate);
      this.timer = this.setTimer(() => {
        this.timer = null;
        if (this.current?.id !== current.id) return;
        this.nextWordIndex++;
        this.emitWord(current.id, word);
        this.scheduleNextWord();
      }, delayMs);
      return;
    }
  }

  private emitWord(id: string, word: WordTiming): void {
    this.emit({ type: 'word', id, charStart: word.charStart, charEnd: word.charEnd });
  }

  private clearTimingTimer(): void {
    if (this.timer === null) return;
    this.clearTimer(this.timer);
    this.timer = null;
  }
}

/** Sorted by start time, so the scheduler can walk the list once. */
function sortTimings(timings: WordTiming[] | undefined): WordTiming[] {
  if (!timings || timings.length === 0) return [];
  return [...timings].sort((a, b) => a.startMs - b.startMs);
}

function clampTime(startTimeMs: number, durationMs: number): number {
  const seconds = (Number.isFinite(startTimeMs) ? startTimeMs : 0) / 1000;
  const max = durationMs / 1000;
  if (!Number.isFinite(max) || max <= 0) return Math.max(0, seconds);
  return Math.min(Math.max(0, seconds), max);
}

/** The element's rate, with a guard for the values that would stall the timer. */
function playbackRate(audio: AudioLike): number {
  const rate = audio.playbackRate;
  return Number.isFinite(rate) && rate > 0 ? rate : 1;
}
