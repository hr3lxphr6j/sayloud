/**
 * The cloud voice, as a `Speaker`.
 *
 * The service worker's engine is a synchronous state machine — `speak()` returns
 * immediately and the speaker reports progress through events, which is what
 * `chrome.tts` does. So rather than turning the engine's playback path async,
 * this adapter hides the whole async pipeline behind that same interface: it
 * fires off synthesize → play, and reports `start`, `word`, `end` and `error`
 * as the offscreen document produces them. The engine needs no changes at all,
 * and the existing browser voice path is untouched.
 *
 * Every utterance is tagged with a sequence id. The engine stops and re-speaks
 * freely (a seek, a rate change, a pause), and replies and events from a
 * superseded utterance must not move the cursor of the new one.
 */

import type { SendOptions } from './offscreen-manager';
import {
  isOffscreenEvent,
  type OffscreenCommand,
  type SynthesizeReply,
} from './offscreen-protocol';
import { errorMessage } from './providers/errors';
import type { ProviderConfig } from './providers/types';
import type { PrefetchRequest, Speaker, SpeakerEvents, SpeakRequest, WordSpan } from './speaker';
import { SpeakerEmitter } from './speaker-emitter';

/** The slice of `chrome.runtime.onMessage` this module uses. */
export interface RuntimeEventSource {
  addListener(listener: (message: unknown) => void): void;
  removeListener(listener: (message: unknown) => void): void;
}

/** The command channel the speaker needs. `OffscreenManager` satisfies this. */
export interface CommandChannel {
  sendCommand(
    command: OffscreenCommand,
    options?: SendOptions
  ): Promise<SynthesizeReply | undefined>;
}

export interface OffscreenSpeakerDeps {
  manager: CommandChannel;
  /** Credentials and model; the voice comes per sentence from the engine. */
  config: ProviderConfig;
  /** Where the offscreen document's events arrive. */
  events: RuntimeEventSource;
}

export class OffscreenSpeaker implements Speaker {
  private readonly manager: CommandChannel;
  private readonly config: ProviderConfig;
  private readonly events: RuntimeEventSource;
  private readonly emitter = new SpeakerEmitter();

  /** Invalidates replies and events from utterances that were replaced. */
  private generation = 0;
  /** The utterance whose events are wanted; the id in the offscreen protocol. */
  private activeId: string | null = null;
  private sequence = 0;
  /**
   * The last known playback position from the offscreen document, in milliseconds.
   * Updated by 'paused' events sent when the audio is paused.
   */
  private lastPausedTimeMs = 0;
  /**
   * The rate the next `play` should use.
   *
   * Kept here rather than only in the request that started the utterance: a
   * change that arrives while the sentence is still being synthesized has to
   * win over the rate captured when `speak` was called, or the sentence would
   * start at the old speed while the UI shows the new one.
   */
  private rate = 1;

  constructor(deps: OffscreenSpeakerDeps) {
    this.manager = deps.manager;
    this.config = deps.config;
    this.events = deps.events;
    this.events.addListener(this.onMessage);
  }

  speak({ text, voice, rate, lang, volume, resumeTimeMs }: SpeakRequest): void {
    const generation = ++this.generation;
    const id = `sayloud-${++this.sequence}`;
    this.activeId = id;
    this.rate = rate;
    void this.run(generation, id, text, voice, lang, volume, resumeTimeMs);
  }

  /**
   * Change the speed of the sentence that is playing.
   *
   * The stored rate is what the pending (or next) utterance is played at, so a
   * change during synthesis is not lost to the snapshot `speak` took. `create:
   * false` for the same reason `setVolume` uses it: a rate change is only
   * meaningful while audio is playing, and it must never be what brings the
   * offscreen document into existence.
   *
   * Always reports `true`: the engine only asks while a sentence is running,
   * and the offscreen player applies the rate to whatever is loaded.
   */
  setRate(rate: number): boolean {
    this.rate = rate;
    this.fireAndForget({ type: 'setRate', rate }, 'change the cloud voice rate');
    return true;
  }

  /**
   * Change the loudness of the sentence that is playing.
   *
   * `create: false` for the same reason `stop` uses it: a volume change is only
   * meaningful while audio is playing, and it must never be what brings the
   * offscreen document into existence.
   */
  setVolume(volume: number): void {
    this.fireAndForget({ type: 'setVolume', volume }, 'change the cloud voice volume');
  }

  stop(): void {
    this.generation++;
    this.activeId = null;
    this.fireAndForget({ type: 'stop' }, 'stop the cloud voice');
  }

  /**
   * Get the current playback position within the sentence, in milliseconds.
   * Returns the position captured by the last pause event.
   */
  getCurrentTimeMs(): number | undefined {
    return this.lastPausedTimeMs;
  }

  /**
   * Pause the current utterance, preserving playback position for resume.
   * The offscreen document will emit a 'paused' event with the current time.
   */
  pause(): void {
    // A synthesis that is still preparing must never start after this pause.
    this.generation++;
    this.fireAndForget({ type: 'pause' }, 'pause the cloud voice');
  }

  /**
   * Warm the cache for sentences expected to play soon.
   *
   * Fire and forget, and never with `create: true`: warming a document that
   * does not exist would cost a document and a provider call for audio nobody
   * has asked for yet. `generation` and `activeId` are deliberately untouched —
   * a prefetch must not supersede the sentence that is playing.
   */
  prefetch(requests: readonly PrefetchRequest[]): void {
    if (requests.length === 0) return;
    this.fireAndForget(
      {
        type: 'prefetch',
        items: requests.map((request) => ({
          text: request.text,
          voiceId: request.voice ?? '',
        })),
        config: this.config,
      },
      'prefetch audio'
    );
  }

  on<K extends keyof SpeakerEvents>(
    event: K,
    handler: (payload: SpeakerEvents[K]) => void
  ): () => void {
    return this.emitter.on(event, handler);
  }

  dispose(): void {
    this.stop();
    this.events.removeListener(this.onMessage);
    this.emitter.clear();
  }

  /**
   * Send a command whose result nobody waits for.
   *
   * Every one of these is a change to audio that is already playing or about to
   * be, so none of them may create the offscreen document, and none of them may
   * fail loudly: a document that was reclaimed mid-sentence is a lost command,
   * not a playback error. `what` names the command so the log says which one.
   */
  private fireAndForget(command: OffscreenCommand, what: string): void {
    void this.manager.sendCommand(command, { create: false }).catch((error: unknown) => {
      console.warn(`[SayLoud] could not ${what}`, error);
    });
  }

  /** Synthesize, then play; report anything that fails as a speaker error. */
  private async run(
    generation: number,
    id: string,
    text: string,
    voice: string | undefined,
    lang: string,
    volume: number | undefined,
    resumeTimeMs: number | undefined
  ): Promise<void> {
    try {
      const reply = await this.manager.sendCommand({
        type: 'synthesize',
        id,
        text,
        // The engine resolves a voice before it speaks, and refuses to speak
        // when it cannot; an empty id here would be a wiring bug.
        voiceId: voice ?? '',
        lang,
        config: this.config,
      });
      if (this.stale(generation)) return;

      // A missing reply means the offscreen worker already reported the failure
      // as an `error` event; reporting it again would duplicate the failure.
      if (!reply) return;

      // The rate is set before playback starts, so the word timeline is
      // scheduled at the right speed from the first word. Read at this point
      // rather than passed in: a change that arrived while synthesis was in
      // flight is the one the reader asked for.
      await this.manager.sendCommand({ type: 'setRate', rate: this.rate });
      if (this.stale(generation)) return;

      // Same for the volume: the first word is already at the right loudness.
      if (volume !== undefined) {
        await this.manager.sendCommand({ type: 'setVolume', volume });
        if (this.stale(generation)) return;
      }

      await this.manager.sendCommand({ type: 'play', id, startTimeMs: resumeTimeMs ?? 0 });
      if (this.stale(generation)) return;

      this.emitter.emit('start', undefined);
    } catch (error) {
      if (this.stale(generation)) return;
      this.emitter.emit('error', errorMessage(error));
    }
  }

  private readonly onMessage = (message: unknown): void => {
    // `runtime.sendMessage` reaches every extension context, and what arrives
    // here is only trustworthy if it is one of our own audio events.
    if (!isOffscreenEvent(message)) return;

    // An event from an utterance the engine has moved on from. The engine stops
    // and re-speaks freely (a seek, a rate change, a pause), and a late word or
    // end from the replaced one would drag the new cursor with it — including a
    // late `paused`, which would overwrite the resume position with the old
    // sentence's.
    if (message.id !== this.activeId) return;

    switch (message.type) {
      case 'paused':
        this.lastPausedTimeMs = message.currentTimeMs;
        // The engine keeps its own copy so it can resume from this position.
        this.emitter.emit('paused', message.currentTimeMs);
        return;
      case 'word': {
        const span: WordSpan = { charStart: message.charStart, charEnd: message.charEnd };
        this.emitter.emit('word', span);
        return;
      }
      case 'sentence-end':
        this.emitter.emit('end', undefined);
        return;
      case 'error':
        this.emitter.emit('error', message.message);
        return;
      default:
        // `ready` is the reply to `synthesize`, which `run` is already awaiting.
        return;
    }
  };

  private stale(generation: number): boolean {
    return generation !== this.generation;
  }
}
