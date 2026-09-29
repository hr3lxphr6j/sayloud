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
  | { type: 'word'; index: number; charStart: number; charEnd: number };

export interface SessionSnapshot {
  tabId: number;
  docId: string;
  sentences: EngineSentence[];
  index: number;
  resumeOffset: number;
  voice: string;
  rate: number;
  charsRead: number;
}
