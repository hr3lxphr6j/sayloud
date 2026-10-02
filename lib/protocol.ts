export type EnginePhase = 'idle' | 'loading' | 'playing' | 'paused' | 'ended' | 'error';

export interface EngineSentence {
  text: string;
  lang: string;
}

export interface EngineStatus {
  phase: EnginePhase;
  index: number;
  total: number;
  rate: number;
  voice: string;
  charsRead: number;
  charsTotal: number;
  charsPerSec: number;
  error?: 'no-voice' | 'tts-error' | 'no-content';
}

export type EngineCommand =
  | { type: 'load'; sentences: EngineSentence[]; startIndex: number; rate: number }
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
   * Only ever an answer to `sync`, and only when there is nothing to catch the
   * reader up to. Without it both sides wait forever: the reader will not send
   * `load` again because as far as it knows it already did, and the engine has
   * nothing to speak. Reached when the worker was recycled and no usable
   * snapshot was left behind.
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
