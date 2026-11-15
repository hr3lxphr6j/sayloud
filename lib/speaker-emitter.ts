/**
 * The event plumbing every `Speaker` shares.
 *
 * What a speaker's events *mean* is its own business; how a listener is held is
 * not. One set per event, an unsubscribe that is safe to call twice, and a
 * payload delivered only to the listeners of the event it belongs to are the
 * same in all three speakers, and were copied into each of them.
 *
 * The sets are typed per event instead of being one `Set<(payload: never) => void>`:
 * a handler's parameter type is then checked where it is added and where it is
 * called, rather than asserted at both ends.
 */
import type { SpeakerEvents } from './speaker';

type Listener<K extends keyof SpeakerEvents> = (payload: SpeakerEvents[K]) => void;

/** One set per event, each typed for that event's payload. */
type ListenerSets = { [K in keyof SpeakerEvents]: Set<Listener<K>> };

export class SpeakerEmitter {
  private readonly listeners: ListenerSets = {
    start: new Set(),
    word: new Set(),
    end: new Set(),
    error: new Set(),
    paused: new Set(),
  };

  /**
   * Listen for one event.
   *
   * The unsubscribe closes over the set rather than looking it up again, so it
   * keeps working after `clear()`: the set is emptied, never replaced, and
   * removing a handler it no longer holds is a no-op.
   */
  on<K extends keyof SpeakerEvents>(event: K, handler: Listener<K>): () => void {
    const handlers = this.listeners[event];
    handlers.add(handler);
    return () => {
      handlers.delete(handler);
    };
  }

  emit<K extends keyof SpeakerEvents>(event: K, payload: SpeakerEvents[K]): void {
    for (const handler of this.listeners[event]) handler(payload);
  }

  /** Forget every listener, without a `removeListener` for each of them. */
  clear(): void {
    for (const handlers of Object.values(this.listeners)) handlers.clear();
  }
}
