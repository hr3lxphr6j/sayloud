/**
 * The cloud voice, as a `Speaker` (spec §5.1).
 *
 * The service worker's engine is a synchronous state machine — `speak()` returns
 * immediately and the speaker reports progress through events, which is what
 * `chrome.tts` does. So rather than turning the engine's playback path async,
 * this adapter hides the whole async pipeline behind that same interface: it
 * fires off synthesize → play, and reports `start`, `word`, `end` and `error`
 * as the offscreen document produces them. The engine needs no changes at all,
 * and the P1 browser path is untouched.
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

type Handler = (payload: never) => void;

export class OffscreenSpeaker implements Speaker {
  private readonly manager: CommandChannel;
  private readonly config: ProviderConfig;
  private readonly events: RuntimeEventSource;
  private readonly listeners = new Map<keyof SpeakerEvents, Set<Handler>>();

  /** Invalidates replies and events from utterances that were replaced. */
  private generation = 0;
  /** The utterance whose events are wanted; the id in the offscreen protocol. */
  private activeId: string | null = null;
  private sequence = 0;

  constructor(deps: OffscreenSpeakerDeps) {
    this.manager = deps.manager;
    this.config = deps.config;
    this.events = deps.events;
    this.events.addListener(this.onMessage);
  }

  speak({ text, voice, rate }: SpeakRequest): void {
    const generation = ++this.generation;
    const id = `sayloud-${++this.sequence}`;
    this.activeId = id;
    void this.run(generation, id, text, voice, rate);
  }

  stop(): void {
    this.generation++;
    this.activeId = null;
    void this.manager.sendCommand({ type: 'stop' }, { create: false }).catch((error: unknown) => {
      console.warn('[SayLoud] could not stop the cloud voice', error);
    });
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
    void this.manager
      .sendCommand(
        {
          type: 'prefetch',
          items: requests.map((request) => ({
            text: request.text,
            voiceId: request.voice ?? '',
          })),
          config: this.config,
        },
        { create: false }
      )
      .catch((error: unknown) => {
        console.warn('[SayLoud] could not prefetch audio', error);
      });
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
    this.events.removeListener(this.onMessage);
    this.listeners.clear();
  }

  /** Synthesize, then play; report anything that fails as a speaker error. */
  private async run(
    generation: number,
    id: string,
    text: string,
    voice: string | undefined,
    rate: number
  ): Promise<void> {
    try {
      const reply = await this.manager.sendCommand({
        type: 'synthesize',
        id,
        text,
        // The engine resolves a voice before it speaks, and refuses to speak
        // when it cannot; an empty id here would be a wiring bug.
        voiceId: voice ?? '',
        config: this.config,
      });
      if (this.stale(generation)) return;

      // A missing reply means the offscreen worker already reported the failure
      // as an `error` event; saying so again would make the engine fall back
      // twice.
      if (!reply) return;

      // The rate is set before playback starts, so the word timeline is
      // scheduled at the right speed from the first word.
      await this.manager.sendCommand({ type: 'setRate', rate });
      if (this.stale(generation)) return;

      await this.manager.sendCommand({ type: 'play', id, startTimeMs: 0 });
      if (this.stale(generation)) return;

      this.emit('start', undefined);
    } catch (error) {
      if (this.stale(generation)) return;
      this.emit('error', errorMessage(error));
    }
  }

  private readonly onMessage = (message: unknown): void => {
    // Two filters, for two different mistakes: a message that is not an audio
    // event at all, and an event from a sentence the engine has moved on from.
    if (!isOffscreenEvent(message) || message.id !== this.activeId) return;

    switch (message.type) {
      case 'word': {
        const span: WordSpan = { charStart: message.charStart, charEnd: message.charEnd };
        this.emit('word', span);
        return;
      }
      case 'sentence-end':
        this.emit('end', undefined);
        return;
      case 'error':
        this.emit('error', message.message);
        return;
      default:
        // `ready` is the reply to `synthesize`, which `run` is already awaiting.
        return;
    }
  };

  private stale(generation: number): boolean {
    return generation !== this.generation;
  }

  private emit<K extends keyof SpeakerEvents>(event: K, payload: SpeakerEvents[K]): void {
    for (const handler of this.listeners.get(event) ?? []) {
      (handler as (value: SpeakerEvents[K]) => void)(payload);
    }
  }
}
