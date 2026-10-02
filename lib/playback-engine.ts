import type {
  EngineCommand,
  EngineEvent,
  EnginePhase,
  EngineSentence,
  EngineStatus,
  SessionSnapshot,
} from './protocol';
import type { PrefetchRequest, Speaker } from './speaker';

export type EngineError = NonNullable<EngineStatus['error']>;

/** Resolve the voice name to use for a language, or undefined when none fits. */
export type VoiceResolver = (lang: string) => string | undefined;

// A resolver returns `undefined` to mean "no usable voice" and an empty string
// to mean "let chrome.tts pick the default".

export interface EngineDeps {
  speaker: Speaker;
  /**
   * Used when `speaker` reports a TTS error, so a failing cloud service
   * degrades to the browser voice instead of stopping playback. The degrade
   * lasts until the next session or `retryPrimary()`.
   */
  fallbackSpeaker?: Speaker;
  resolveVoice: VoiceResolver;
  /**
   * The voice resolver while the fallback speaks. Defaults to `resolveVoice`;
   * needed when that one answers with voice ids only the primary understands.
   */
  resolveFallbackVoice?: VoiceResolver;
  now?: () => number;
}

const MIN_RATE = 0.5;
const MAX_RATE = 3;
/** The engine's own range; the settings store offers the same one. */
const MIN_VOLUME = 0;
const MAX_VOLUME = 1.5;
/** Below this, a rate sample is too noisy to publish. */
const RATE_SAMPLE_MS = 250;

/**
 * Base prefetch horizon, in estimated milliseconds of audio.
 *
 * The spec widens it with the rate: a faster rate burns through the queue
 * faster, so more audio has to be ready ahead of the cursor.
 */
const PREFETCH_HORIZON_MS = 12_000;
/** Reading speeds the horizon estimator assumes, in characters per second. */
const CJK_CHARS_PER_SEC = 5;
const OTHER_CHARS_PER_SEC = 15;
const CJK_PATTERN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu;

/**
 * Session state machine for one tab.
 *
 * The engine owns all playback state and is the only writer of it; the Side
 * Player is a pure view over the events it emits. Every command from
 * `EngineCommand` is handled here so the router stays a thin transport.
 *
 * P1 speaks through `chrome.tts`, which has no seekable audio and cannot resume
 * mid-sentence, so resuming a paused sentence replays it from the start.
 */
export class PlaybackEngine {
  private speaker: Speaker;
  private readonly primarySpeaker: Speaker;
  private readonly fallbackSpeaker: Speaker | undefined;
  private readonly resolvePrimaryVoice: VoiceResolver;
  private readonly resolveFallbackVoice: VoiceResolver;
  private readonly now: () => number;
  private readonly listeners = new Set<(event: EngineEvent) => void>();
  private readonly speakerSubscriptions: Array<() => void> = [];
  /**
   * Sticky for the rest of the session: a service that just failed is not
   * retried on the next sentence, so a broken primary costs one failed
   * utterance rather than one per sentence. A new session (`load`) or a
   * configuration change (`retryPrimary`) tries the primary again.
   */
  private usingFallback = false;

  private phase: EnginePhase = 'idle';
  private sentences: EngineSentence[] = [];
  private index = 0;
  private rate = 1;
  private volume = 1;
  private voice = '';
  private error: EngineError | undefined;
  private tabId = -1;
  private docId = '';

  private charsTotal = 0;
  private charsRead = 0;
  /** Offset of the last reported word inside the current sentence. */
  private wordOffset = 0;
  /**
   * Audio playback position within the current sentence when paused, in milliseconds.
   * Used to resume from the exact position. Only meaningful for cloud and local
   * providers; browser voice always restarts from the beginning.
   */
  private resumeTimeMs = 0;

  private spokenMs = 0;
  private runStartedAt: number | null = null;

  constructor(deps: EngineDeps) {
    this.speaker = deps.speaker;
    this.primarySpeaker = deps.speaker;
    this.fallbackSpeaker = deps.fallbackSpeaker;
    this.resolvePrimaryVoice = deps.resolveVoice;
    this.resolveFallbackVoice = deps.resolveFallbackVoice ?? deps.resolveVoice;
    this.now = deps.now ?? (() => Date.now());

    this.bindSpeakerEvents();
  }

  /** Bind the session to the tab that owns it, so snapshots carry the right id. */
  setTabId(tabId: number): void {
    this.tabId = tabId;
  }

  dispatch(command: EngineCommand): void {
    switch (command.type) {
      case 'load':
        this.load(command.sentences, command.startIndex, command.rate);
        return;
      case 'play':
        this.play();
        return;
      case 'pause':
        this.pause();
        return;
      case 'toggle':
        this.toggle();
        return;
      case 'next':
        this.seek(this.index + 1);
        return;
      case 'prev':
        this.seek(this.index - 1);
        return;
      case 'seek':
        this.seek(command.index);
        return;
      case 'setRate':
        this.setRate(command.rate);
        return;
      case 'stop':
        this.stop();
        return;
      case 'sync':
        this.sync(command.docId);
        return;
      default: {
        // Compile-time exhaustiveness: a new command type must be handled above.
        const unhandled: never = command;
        void unhandled;
      }
    }
  }

  subscribe(listener: (event: EngineEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  getStatus(): EngineStatus {
    const status: EngineStatus = {
      phase: this.phase,
      index: this.index,
      total: this.sentences.length,
      rate: this.rate,
      voice: this.voice,
      charsRead: this.charsRead,
      charsTotal: this.charsTotal,
      charsPerSec: this.charsPerSec(),
    };
    if (this.error) status.error = this.error;
    return status;
  }

  /** Null when there is no session worth persisting. */
  getSnapshot(): SessionSnapshot | null {
    if (this.sentences.length === 0) return null;
    return {
      tabId: this.tabId,
      docId: this.docId,
      sentences: [...this.sentences],
      index: this.index,
      resumeOffset: this.wordOffset,
      voice: this.voice,
      rate: this.rate,
      charsRead: this.charsRead,
      resumeTimeMs: this.resumeTimeMs,
    };
  }

  /**
   * Rebuild a session after the service worker was recycled.
   *
   * Always lands in `paused`: the user is no longer mid-gesture, and
   * `chrome.tts` would need a fresh call anyway.
   */
  restore(snapshot: SessionSnapshot): void {
    this.speaker.stop();
    this.sentences = [...snapshot.sentences];
    this.charsTotal = this.sentences.reduce((sum, s) => sum + s.text.length, 0);
    this.index = clampIndex(snapshot.index, this.sentences.length);
    this.rate = clampRate(snapshot.rate);
    this.voice = snapshot.voice;
    this.charsRead = snapshot.charsRead;
    this.tabId = snapshot.tabId;
    this.docId = snapshot.docId;
    this.error = undefined;
    this.resetTiming();
    // `chrome.tts` cannot resume mid-sentence, so the word offset is dropped.
    this.wordOffset = 0;
    // Restore the audio playback position for cloud/local providers.
    // Browser voice will ignore this and always restart from the beginning.
    this.resumeTimeMs = snapshot.resumeTimeMs ?? 0;
    this.setPhase(this.sentences.length === 0 ? 'idle' : 'paused');
  }

  dispose(): void {
    this.unbindSpeakerEvents();
    this.listeners.clear();
    this.primarySpeaker.dispose();
    this.fallbackSpeaker?.dispose();
  }

  /**
   * Leave the fallback and speak through the primary again.
   *
   * Called when the provider configuration changes: whatever made the primary
   * fail may have been fixed. A session mid-sentence replays that sentence on
   * the primary; a paused one stays paused.
   */
  retryPrimary(): void {
    if (!this.usingFallback) return;
    const wasSpeaking = this.phase === 'playing' || this.phase === 'loading';
    this.useSpeaker(this.primarySpeaker);
    this.usingFallback = false;
    if (wasSpeaking) this.speakCurrent();
  }

  load(sentences: EngineSentence[], startIndex = 0, rate = 1): void {
    this.speaker.stop();
    if (this.usingFallback) {
      this.useSpeaker(this.primarySpeaker);
      this.usingFallback = false;
    }
    this.resetTiming();
    this.sentences = [...sentences];
    this.charsTotal = this.sentences.reduce((sum, s) => sum + s.text.length, 0);
    this.rate = clampRate(rate);
    this.index = clampIndex(startIndex, this.sentences.length);
    this.charsRead = charsBefore(this.sentences, this.index);
    this.wordOffset = 0;
    this.resumeTimeMs = 0;
    this.error = undefined;

    if (this.sentences.length === 0) {
      this.fail('no-content');
      return;
    }

    // A page with no usable voice is a dead end; surface it before "loading"
    // so the UI can offer to install a voice instead of spinning forever.
    // An empty name is valid here: chrome.tts reads it as "any available voice".
    if (this.resolveVoice(this.sentences[this.index]?.lang ?? '') === undefined) {
      this.voice = '';
      this.fail('no-voice');
      return;
    }

    this.setPhase('loading');
    this.speakCurrent();
  }

  play(): void {
    if (this.phase === 'playing' || this.phase === 'loading') return;
    if (this.sentences.length === 0) {
      // Silent here is the hardest kind of report to act on: no error, no
      // effect, and nothing anywhere to look at. It means this engine was
      // rebuilt without a session — which is what happens when a snapshot was
      // never written or could not be read — so the ids go in the log to tell
      // those apart.
      console.warn('[SayLoud] cannot play: this session has no sentences', {
        docId: this.docId,
        tabId: this.tabId,
        phase: this.phase,
      });
      return;
    }

    if (this.phase === 'ended') {
      // Pressing play after the end replays from the top.
      this.index = 0;
      this.charsRead = 0;
      this.wordOffset = 0;
      this.resumeTimeMs = 0;
      this.resetTiming();
    }

    this.error = undefined;
    this.setPhase('loading');
    this.speakCurrent();
  }

  pause(): void {
    if (this.phase !== 'playing' && this.phase !== 'loading') return;
    // Use pause() if the speaker supports it (cloud/local providers), otherwise
    // fall back to stop() (browser voice). Cloud/local providers will emit a
    // 'paused' event with the current position, which we capture via getCurrentTimeMs().
    if (this.speaker.pause) {
      this.speaker.pause();
      // Give the speaker a moment to process the pause and emit the 'paused' event,
      // then capture the position. This is necessary because the pause event is async.
      setTimeout(() => {
        this.resumeTimeMs = this.speaker.getCurrentTimeMs?.() ?? 0;
      }, 10);
    } else {
      // Browser voice doesn't support pause, so stop it. resumeTimeMs stays 0,
      // meaning it will restart from the beginning.
      this.resumeTimeMs = 0;
      this.speaker.stop();
    }
    this.setPhase('paused');
  }

  toggle(): void {
    if (this.phase === 'playing' || this.phase === 'loading') this.pause();
    else this.play();
  }

  seek(index: number): void {
    if (this.sentences.length === 0) return;

    this.index = clampIndex(index, this.sentences.length);
    this.wordOffset = 0;
    this.resumeTimeMs = 0;
    this.charsRead = charsBefore(this.sentences, this.index);

    if (this.phase === 'playing' || this.phase === 'loading') {
      this.setPhase('loading');
      this.speakCurrent();
      return;
    }

    // While paused the cursor still moves, so the highlight follows the click.
    if (this.phase === 'ended' || this.phase === 'error') this.setPhase('paused');
    else this.emitStatus();
  }

  setRate(rate: number): void {
    const next = clampRate(rate);
    if (next === this.rate) return;
    this.rate = next;

    // `chrome.tts` takes the rate per utterance, so the current sentence has to
    // be re-spoken for the change to be audible.
    if (this.phase === 'playing' || this.phase === 'loading') {
      this.setPhase('loading');
      this.speakCurrent();
      return;
    }
    this.emitStatus();
  }

  /**
   * Change the loudness, for this and every later sentence.
   *
   * The current sentence is left alone: a speaker that can change volume while
   * it plays — the cloud voice, through the offscreen player's gain node — does
   * so from the stored value, and one that cannot reads it from the next
   * request. Re-speaking here would restart the sentence on every step of the
   * volume slider.
   */
  setVolume(volume: number): void {
    const next = clampVolume(volume);
    if (next === this.volume) return;
    this.volume = next;
    this.speaker.setVolume?.(next);
  }

  stop(): void {
    this.speaker.stop();
    this.sentences = [];
    this.index = 0;
    this.voice = '';
    this.error = undefined;
    this.charsTotal = 0;
    this.charsRead = 0;
    this.wordOffset = 0;
    this.docId = '';
    this.resetTiming();
    this.setPhase('idle');
  }

  /**
   * The content script announces which document it is after (re)connecting.
   * A different document means the page navigated, so the session is stale.
   */
  private sync(docId: string): void {
    if (this.sentences.length === 0) {
      this.docId = docId;
      // Asked to catch a reconnected reader up, with nothing to catch it up to.
      // Saying so is the only way out of the standoff: the reader believes it
      // already sent its sentences, so it will never send them again by itself.
      this.emit({ type: 'session-lost' });
      return;
    }
    if (this.docId && this.docId !== docId) {
      this.stop();
      return;
    }
    this.docId = docId;
    // Re-announce the current state so a reconnected player catches up.
    this.emitStatus();
  }

  /**
   * Warm the cache for the sentences that will play next (spec §5.3).
   *
   * Called when a sentence starts, which is the one moment the ordering is
   * safe: the speaker has already been asked to synthesize the current
   * sentence, so a prefetch cannot supersede it. A `Speaker` without `prefetch`
   * — the browser voice — ignores this entirely.
   */
  private prefetchUpcoming(): void {
    // Only while audio is actually flowing. A paused session would warm a
    // queue that nothing is about to consume.
    if (this.phase !== 'playing') return;

    const horizonMs = PREFETCH_HORIZON_MS * (1 + this.rate * 0.5);
    const requests: PrefetchRequest[] = [];
    let estimatedMs = 0;

    for (let index = this.index + 1; index < this.sentences.length; index++) {
      if (estimatedMs >= horizonMs) break;

      const sentence = this.sentences[index];
      if (!sentence || sentence.text.length === 0) continue;

      const voice = this.resolveVoice(sentence.lang);
      if (voice === undefined) continue;

      requests.push({ text: sentence.text, voice });
      estimatedMs += estimateSpeechMs(sentence.text);
    }

    if (requests.length > 0) this.speaker.prefetch?.(requests);
  }

  private speakCurrent(): void {
    for (let index = this.index; index < this.sentences.length; index++) {
      const sentence = this.sentences[index];
      if (!sentence || sentence.text.length === 0) continue;

      const voice = this.resolveVoice(sentence.lang);
      if (voice === undefined) {
        this.index = index;
        this.voice = '';
        this.fail('no-voice');
        return;
      }

      this.index = index;
      this.voice = voice;
      this.wordOffset = 0;
      this.charsRead = charsBefore(this.sentences, index);
      this.speaker.speak({
        text: sentence.text,
        voice,
        rate: this.rate,
        lang: sentence.lang,
        volume: this.volume,
        resumeTimeMs: this.resumeTimeMs,
      });
      // Clear the resume position after using it once, so the next sentence
      // (or a seek/rate change that re-speaks the current one) starts from the
      // beginning rather than jumping to a stale offset.
      this.resumeTimeMs = 0;
      return;
    }

    // Nothing left to speak.
    this.finish();
  }

  private onWord(span: { charStart: number; charEnd: number }): void {
    if (!this.sentences[this.index]) return;
    this.wordOffset = span.charEnd;
    this.charsRead = charsBefore(this.sentences, this.index) + span.charEnd;
    this.emit({
      type: 'word',
      index: this.index,
      charStart: span.charStart,
      charEnd: span.charEnd,
    });
  }

  private onEnd(): void {
    const sentence = this.sentences[this.index];
    if (sentence) {
      this.charsRead = charsBefore(this.sentences, this.index) + sentence.text.length;
    }

    if (this.index >= this.sentences.length - 1) {
      this.finish();
      return;
    }

    this.index += 1;
    this.wordOffset = 0;
    // Stay in `playing` across the boundary: `chrome.tts` starts the next
    // utterance immediately, and dropping to `loading` would flash the play
    // button's spinner on every sentence. Only user-initiated restarts (load,
    // play, seek, setRate) go through `loading`.
    this.emitStatus();
    this.speakCurrent();
  }

  private finish(): void {
    this.charsRead = this.charsTotal;
    this.setPhase('ended');
  }

  private fail(error: EngineError, detail?: string): void {
    // The speaker's own message, logged before anything is decided about it.
    // Without this every cause — a model that was never downloaded, a worker
    // that died, a rejected key — reaches the console as the same three words,
    // "speaker failed", and the one detail that says which of them it was is
    // thrown away a frame later.
    if (detail !== undefined && detail.length > 0) {
      console.warn(`[SayLoud] the speaker reported: ${detail}`);
    }

    // Only a TTS error is worth retrying on another speaker: no installed voice
    // is a dead end for every speaker, and the UI has to say so.
    if (this.fallbackSpeaker && error === 'tts-error' && !this.usingFallback) {
      this.switchToFallback();
      return;
    }

    this.error = error;
    this.speaker.stop();
    this.setPhase('error');
  }

  /**
   * Degrade to the fallback speaker and replay the sentence it dropped.
   *
   * The phase is left alone on purpose: the failed utterance never advanced the
   * cursor, and dropping to `loading` would flash the play button's spinner.
   */
  private switchToFallback(): void {
    const fallback = this.fallbackSpeaker;
    if (!fallback) return;

    console.warn('[SayLoud] speaker failed, falling back to the browser voice');
    // Stopped, not disposed: the primary is tried again on the next session.
    this.useSpeaker(fallback);
    this.usingFallback = true;

    this.speakCurrent();
  }

  /**
   * Point the engine at `next`.
   *
   * Unbinding first means events still in flight from the outgoing speaker's
   * utterance cannot move the cursor.
   */
  private useSpeaker(next: Speaker): void {
    this.unbindSpeakerEvents();
    this.speaker.stop();
    this.speaker = next;
    this.bindSpeakerEvents();
  }

  private resolveVoice(lang: string): string | undefined {
    return this.usingFallback ? this.resolveFallbackVoice(lang) : this.resolvePrimaryVoice(lang);
  }

  private bindSpeakerEvents(): void {
    this.speakerSubscriptions.push(
      this.speaker.on('start', () => {
        this.setPhase('playing');
        this.prefetchUpcoming();
      }),
      this.speaker.on('word', (span) => this.onWord(span)),
      this.speaker.on('end', () => this.onEnd()),
      this.speaker.on('error', (message) => this.fail('tts-error', message))
    );
  }

  private unbindSpeakerEvents(): void {
    for (const unsubscribe of this.speakerSubscriptions) unsubscribe();
    this.speakerSubscriptions.length = 0;
  }

  private setPhase(phase: EnginePhase): void {
    // Timing follows the phase so `charsPerSec` excludes time spent paused.
    if (phase === 'playing') this.beginTiming();
    else this.endTiming();
    this.phase = phase;
    this.emitStatus();
  }

  private emitStatus(): void {
    this.emit({ type: 'status', status: this.getStatus() });
  }

  private emit(event: EngineEvent): void {
    for (const listener of [...this.listeners]) listener(event);
  }

  private beginTiming(): void {
    if (this.runStartedAt === null) this.runStartedAt = this.now();
  }

  private endTiming(): void {
    if (this.runStartedAt === null) return;
    this.spokenMs += this.now() - this.runStartedAt;
    this.runStartedAt = null;
  }

  private resetTiming(): void {
    this.spokenMs = 0;
    this.runStartedAt = null;
  }

  private charsPerSec(): number {
    const elapsed =
      this.spokenMs + (this.runStartedAt === null ? 0 : this.now() - this.runStartedAt);
    if (elapsed < RATE_SAMPLE_MS || this.charsRead <= 0) return 0;
    return this.charsRead / (elapsed / 1000);
  }
}

/**
 * A rough duration for a sentence, in milliseconds.
 *
 * Used only to decide how far ahead to prefetch. The authoritative duration is
 * the media element's — several providers report `durationMs: 0` — so this
 * estimate never reaches the UI.
 */
function estimateSpeechMs(text: string): number {
  const cjk = text.match(CJK_PATTERN)?.length ?? 0;
  const other = text.length - cjk;
  return (cjk / CJK_CHARS_PER_SEC + other / OTHER_CHARS_PER_SEC) * 1000;
}

function clampRate(rate: number): number {
  if (!Number.isFinite(rate)) return 1;
  return Math.min(MAX_RATE, Math.max(MIN_RATE, rate));
}

function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return 1;
  return Math.min(MAX_VOLUME, Math.max(MIN_VOLUME, volume));
}

function clampIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  if (!Number.isFinite(index)) return 0;
  return Math.min(total - 1, Math.max(0, Math.floor(index)));
}

function charsBefore(sentences: EngineSentence[], index: number): number {
  let total = 0;
  for (let i = 0; i < index && i < sentences.length; i++) {
    total += sentences[i]?.text.length ?? 0;
  }
  return total;
}
