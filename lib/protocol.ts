export type EnginePhase = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface EngineSentence {
  text: string;
  lang: string;
}

/**
 * Why the engine stopped.
 *
 * `no-voice-selected` carries the provider's name because the panel needs it to
 * point at that provider's settings — which is why the check in `load` tests
 * the value with `startsWith` rather than comparing it to a literal.
 */
export type EngineError = 'no-content' | 'no-voice' | 'tts-error' | `no-voice-selected:${string}`;

export interface EngineStatus {
  phase: EnginePhase;
  index: number;
  total: number;
  rate: number;
  voice: string;
  charsRead: number;
  charsTotal: number;
  charsPerSec: number;
  error?: EngineError;
  /**
   * The speaker's own words for `tts-error`, untranslated.
   *
   * A cloud service, an on-device model and `chrome.tts` all fail as the same
   * `tts-error`, and each says something different: a status code, a rejected
   * key, a model that was never downloaded. Carrying the message through is
   * what lets the hint name the cause instead of guessing at it, and it travels
   * as it came — rewording it in the interface language would drop the
   * identifiers that make it worth showing at all.
   */
  errorMessage?: string;
}

export type EngineCommand =
  | {
      type: 'load';
      sentences: EngineSentence[];
      startIndex: number;
      rate: number;
      /**
       * Rebuild a session the engine already had, at that position.
       *
       * The reader sends this after `session-lost`, and the sentences have to
       * land without starting to speak: the user may have paused deliberately,
       * and recovering a session is not the same as asking it to play. Omitted
       * for a fresh document, which starts reading on arrival.
       */
      resume?: boolean;
    }
  | { type: 'play' }
  | { type: 'pause' }
  | { type: 'toggle' }
  | { type: 'next' }
  | { type: 'prev' }
  | { type: 'seek'; index: number }
  | { type: 'setRate'; rate: number }
  | { type: 'stop' }
  | { type: 'sync'; docId: string };

export type EngineEvent =
  | { type: 'status'; status: EngineStatus }
  | { type: 'word'; index: number; charStart: number; charEnd: number }
  /**
   * The engine has no session, and the reader believes it already sent one.
   *
   * Sent either as an answer to `sync`, or when a `play` arrives with nothing to
   * speak — both are moments where the engine cannot go on and the reader cannot
   * tell. Without it both sides wait forever: the reader will not send `load`
   * again because as far as it knows it already did, and the engine has nothing
   * to speak. Reached when the worker was recycled and either no usable snapshot
   * was left behind, or the snapshot it restored carries no sentences.
   */
  | { type: 'session-lost' };

export interface SessionSnapshot {
  tabId: number;
  docId: string;
  /** Number of sentences in the document. Used for progress display. */
  sentenceCount: number;
  /** Total characters across all sentences. Used for percentage calculation. */
  charsTotal: number;
  index: number;
  resumeOffset: number;
  voice: string;
  rate: number;
  charsRead: number;
  /**
   * Audio playback position within the current sentence, in milliseconds.
   * Used to resume from the exact position when paused. Only meaningful for
   * cloud and local providers; browser voice always restarts from the beginning.
   */
  resumeTimeMs?: number;
}
