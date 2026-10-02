import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackEngine, type VoiceResolver } from '~/lib/playback-engine';
import type { EngineEvent, EngineSentence, EngineStatus } from '~/lib/protocol';
import type { PrefetchRequest, Speaker, SpeakRequest } from '~/lib/speaker';

/**
 * Fake speaker that mirrors the real one's contract: `stop()` invalidates the
 * current utterance, so events fired afterwards are dropped just like stale
 * `chrome.tts` events would be.
 */
function fakeSpeaker(options: { prefetch?: boolean } = {}) {
  const requests: SpeakRequest[] = [];
  const prefetches: PrefetchRequest[][] = [];
  const volumes: number[] = [];
  const listeners = new Map<string, Set<(payload: never) => void>>();
  let live = false;
  let stopCount = 0;

  const speaker: Speaker = {
    speak(request) {
      requests.push(request);
      live = true;
    },
    setVolume(volume: number) {
      volumes.push(volume);
    },
    ...(options.prefetch === false
      ? {}
      : {
          prefetch(batch: readonly PrefetchRequest[]) {
            prefetches.push([...batch]);
          },
        }),
    stop() {
      live = false;
      stopCount += 1;
    },
    on(event, handler) {
      let handlers = listeners.get(event);
      if (!handlers) {
        handlers = new Set();
        listeners.set(event, handlers);
      }
      handlers.add(handler as (payload: never) => void);
      return () => {
        handlers.delete(handler as (payload: never) => void);
      };
    },
    dispose: vi.fn(),
  };

  const deliver = (event: string, payload: unknown): void => {
    if (!live) return;
    for (const handler of listeners.get(event) ?? []) {
      (handler as (value: unknown) => void)(payload);
    }
  };

  return {
    speaker,
    requests,
    prefetches,
    volumes,
    get stopCount() {
      return stopCount;
    },
    fire: {
      start: () => deliver('start', undefined),
      word: (charStart: number, charEnd: number) => deliver('word', { charStart, charEnd }),
      end: () => deliver('end', undefined),
      error: (message = 'boom') => deliver('error', message),
    },
  };
}

const SENTENCES: EngineSentence[] = [
  { text: 'Hello world.', lang: 'en' }, // 12 chars
  { text: 'Goodbye now.', lang: 'en' }, // 12 chars
  { text: 'Farewell.', lang: 'en' }, // 9 chars
];
const TOTAL_CHARS = 33;

describe('PlaybackEngine', () => {
  let fake: ReturnType<typeof fakeSpeaker>;
  let engine: PlaybackEngine;
  let events: EngineEvent[];
  let time: number;

  const resolveVoice: VoiceResolver = (lang) => (lang.startsWith('en') ? 'Samantha' : undefined);

  function status(): EngineStatus {
    return engine.getStatus();
  }

  function lastStatus(): EngineStatus | undefined {
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event?.type === 'status') return event.status;
    }
    return undefined;
  }

  function wordEvents() {
    return events.filter((e) => e.type === 'word');
  }

  beforeEach(() => {
    fake = fakeSpeaker();
    time = 0;
    engine = new PlaybackEngine({ speaker: fake.speaker, resolveVoice, now: () => time });
    events = [];
    engine.subscribe((event) => events.push(event));
  });

  describe('load', () => {
    it('starts in the loading phase and speaks the sentence at startIndex', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });

      expect(status().phase).toBe('loading');
      expect(status().total).toBe(3);
      expect(status().charsTotal).toBe(TOTAL_CHARS);
      expect(status().voice).toBe('Samantha');
      expect(fake.requests[0]).toEqual({
        text: 'Hello world.',
        voice: 'Samantha',
        rate: 1,
        lang: 'en',
        volume: 1,
        resumeTimeMs: 0,
      });
    });

    it('starts from the requested index and counts the skipped characters', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 2, rate: 1 });

      expect(status().index).toBe(2);
      expect(status().charsRead).toBe(24);
      expect(fake.requests[0]?.text).toBe('Farewell.');
    });

    it('clamps an out-of-range start index', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 99, rate: 1 });
      expect(status().index).toBe(2);
    });

    it('reports no-content for an empty document', () => {
      engine.dispatch({ type: 'load', sentences: [], startIndex: 0, rate: 1 });

      expect(status().phase).toBe('error');
      expect(status().error).toBe('no-content');
      expect(fake.requests).toHaveLength(0);
    });

    it('reports no-voice when no voice fits the language', () => {
      engine.dispatch({
        type: 'load',
        sentences: [{ text: 'Bonjour.', lang: 'fr-FR' }],
        startIndex: 0,
        rate: 1,
      });

      expect(status().phase).toBe('error');
      expect(status().error).toBe('no-voice');
      expect(fake.requests).toHaveLength(0);
    });

    it('takes a no-voice-selected error from startup and refuses to load', () => {
      // Reported rather than dispatched, because the router learns this before
      // any sentence exists. Without it the engine would only find out in
      // `speakCurrent`, and its own `no-voice` blames the language instead of
      // the missing selection — the user is told to install a voice when they
      // needed to pick one.
      engine.reportError('no-voice-selected:dashscope');
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });

      expect(status().phase).toBe('error');
      expect(status().error).toBe('no-voice-selected:dashscope');
      expect(status().total).toBe(0);
      expect(fake.requests).toHaveLength(0);
    });

    it('ignores a reported message that is not one of its own errors', () => {
      // The callers log whatever they caught before calling, so an
      // unrecognised message has already been said out loud. Adopting it here
      // would put a cause in the status that the engine never established.
      engine.reportError('provider-unavailable:dashscope');

      expect(status().phase).not.toBe('error');
      expect(status().error).toBeUndefined();
    });

    it('replaces a session that is already playing', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      engine.dispatch({
        type: 'load',
        sentences: [SENTENCES[0] as EngineSentence],
        startIndex: 0,
        rate: 1,
      });

      expect(status().total).toBe(1);
      expect(fake.requests).toHaveLength(2);
      expect(fake.stopCount).toBeGreaterThan(0);
    });
  });

  describe('playback', () => {
    beforeEach(() => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
    });

    it('moves to playing once the engine reports speech started', () => {
      expect(status().phase).toBe('loading');
      fake.fire.start();
      expect(status().phase).toBe('playing');
    });

    it('emits word events with the current sentence index', () => {
      fake.fire.start();
      fake.fire.word(0, 5);
      fake.fire.word(6, 11);

      expect(wordEvents()).toEqual([
        { type: 'word', index: 0, charStart: 0, charEnd: 5 },
        { type: 'word', index: 0, charStart: 6, charEnd: 11 },
      ]);
      expect(status().charsRead).toBe(11);
    });

    it('advances to the next sentence when one ends', () => {
      fake.fire.start();
      fake.fire.end();

      expect(status().index).toBe(1);
      expect(status().charsRead).toBe(12);
      expect(fake.requests[1]?.text).toBe('Goodbye now.');
      // Continuous playback stays "playing": flipping to "loading" between
      // sentences would flash the spinner on every sentence boundary.
      expect(status().phase).toBe('playing');
    });

    it('ends the session after the last sentence', () => {
      fake.fire.start();
      fake.fire.end();
      fake.fire.start();
      fake.fire.end();
      fake.fire.start();
      fake.fire.end();

      expect(status().phase).toBe('ended');
      expect(status().index).toBe(2);
      expect(status().charsRead).toBe(TOTAL_CHARS);
    });

    it('reports a tts error from the engine', () => {
      fake.fire.start();
      fake.fire.error('voice not found');

      expect(status().phase).toBe('error');
      expect(status().error).toBe('tts-error');
    });
  });

  describe('pause and resume', () => {
    beforeEach(() => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      fake.fire.start();
    });

    it('pauses without moving the cursor', () => {
      engine.dispatch({ type: 'pause' });

      expect(status().phase).toBe('paused');
      expect(status().index).toBe(0);
      expect(status().charsRead).toBe(0);
    });

    it('ignores events from the paused utterance', () => {
      engine.dispatch({ type: 'pause' });
      fake.fire.word(0, 5);
      fake.fire.end();

      expect(status().phase).toBe('paused');
      expect(status().index).toBe(0);
      expect(wordEvents()).toHaveLength(0);
    });

    it('replays the current sentence when resumed', () => {
      engine.dispatch({ type: 'pause' });
      engine.dispatch({ type: 'play' });

      expect(status().phase).toBe('loading');
      expect(fake.requests[1]?.text).toBe('Hello world.');
    });

    it('toggles between playing and paused', () => {
      engine.dispatch({ type: 'toggle' });
      expect(status().phase).toBe('paused');

      engine.dispatch({ type: 'toggle' });
      expect(status().phase).toBe('loading');
    });

    it('restarts from the top when play follows the end of the session', () => {
      engine.dispatch({ type: 'seek', index: 2 });
      fake.fire.start();
      fake.fire.end();
      expect(status().phase).toBe('ended');

      engine.dispatch({ type: 'play' });

      expect(status().index).toBe(0);
      expect(status().charsRead).toBe(0);
    });
  });

  describe('navigation', () => {
    beforeEach(() => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 1, rate: 1 });
      fake.fire.start();
    });

    it('moves forward while playing and speaks the new sentence', () => {
      engine.dispatch({ type: 'next' });

      expect(status().index).toBe(2);
      expect(status().charsRead).toBe(24);
      expect(fake.requests[1]?.text).toBe('Farewell.');
    });

    it('moves backward while playing', () => {
      engine.dispatch({ type: 'prev' });

      expect(status().index).toBe(0);
      expect(fake.requests[1]?.text).toBe('Hello world.');
    });

    it('moves the cursor without speaking while paused', () => {
      engine.dispatch({ type: 'pause' });
      const before = fake.requests.length;

      engine.dispatch({ type: 'next' });

      expect(status().index).toBe(2);
      expect(status().phase).toBe('paused');
      expect(fake.requests).toHaveLength(before);
    });

    it('clamps at both ends', () => {
      engine.dispatch({ type: 'seek', index: -5 });
      expect(status().index).toBe(0);

      engine.dispatch({ type: 'seek', index: 99 });
      expect(status().index).toBe(2);
    });

    it('emits a status event for every cursor move so the UI can follow', () => {
      engine.dispatch({ type: 'pause' });
      events.length = 0;

      engine.dispatch({ type: 'next' });
      expect(lastStatus()?.index).toBe(2);
    });
  });

  describe('rate', () => {
    beforeEach(() => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      fake.fire.start();
    });

    it('clamps the rate to the supported range', () => {
      engine.dispatch({ type: 'setRate', rate: 9 });
      expect(status().rate).toBe(3);

      engine.dispatch({ type: 'setRate', rate: 0.1 });
      expect(status().rate).toBe(0.5);
    });

    it('re-speaks the current sentence so the new rate is audible', () => {
      engine.dispatch({ type: 'setRate', rate: 1.5 });

      expect(fake.requests[1]).toMatchObject({ text: 'Hello world.', rate: 1.5 });
      expect(status().index).toBe(0);
    });

    it('does not speak while paused', () => {
      engine.dispatch({ type: 'pause' });
      const before = fake.requests.length;

      engine.dispatch({ type: 'setRate', rate: 2 });

      expect(status().rate).toBe(2);
      expect(fake.requests).toHaveLength(before);
    });

    it('ignores a rate that is already in effect', () => {
      events.length = 0;
      engine.dispatch({ type: 'setRate', rate: 1 });
      expect(events).toHaveLength(0);
    });
  });

  describe('volume', () => {
    it('starts at full volume', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });

      expect(fake.requests[0]?.volume).toBe(1);
    });

    it('stores the volume and hands it to the speaker', () => {
      engine.setVolume(0.4);

      expect(fake.volumes).toEqual([0.4]);
    });

    it('includes the stored volume in every request', () => {
      engine.setVolume(0.4);
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });

      expect(fake.requests[0]?.volume).toBe(0.4);
    });

    it('does not re-speak the current sentence', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      fake.fire.start();
      const before = fake.requests.length;

      engine.setVolume(0.4);

      // Unlike the rate, the cloud voice changes loudness without restarting:
      // the offscreen player applies it to the gain node it is already using.
      expect(fake.requests).toHaveLength(before);
    });

    it('clamps the volume to the supported range', () => {
      engine.setVolume(9);
      expect(fake.volumes).toEqual([1.5]);

      engine.setVolume(-1);
      expect(fake.volumes).toEqual([1.5, 0]);
    });

    it('says nothing when the volume does not change', () => {
      engine.setVolume(1);

      expect(fake.volumes).toEqual([]);
    });
  });

  describe('prefetch', () => {
    /**
     * Sentences long enough that the horizon, not the document, limits how far
     * ahead the engine looks. 150 non-CJK characters estimate at 10s.
     */
    const LONG: EngineSentence[] = Array.from({ length: 10 }, (_, index) => ({
      text: `${index} `.padEnd(150, 'x'),
      lang: 'en',
    }));

    it('warms the sentences after the cursor that fit the horizon', () => {
      engine.dispatch({ type: 'load', sentences: LONG, startIndex: 0, rate: 1 });
      fake.fire.start();

      // The horizon at rate 1 is 12s, so two 10s sentences cross it.
      expect(fake.prefetches).toEqual([
        [
          { text: LONG[1]?.text, voice: 'Samantha' },
          { text: LONG[2]?.text, voice: 'Samantha' },
        ],
      ]);
    });

    it('looks further ahead at a higher rate', () => {
      engine.dispatch({ type: 'load', sentences: LONG, startIndex: 0, rate: 2 });
      fake.fire.start();

      expect(fake.prefetches[0]).toHaveLength(3);
    });

    it('does not prefetch before the speaker reports it started', () => {
      engine.dispatch({ type: 'load', sentences: LONG, startIndex: 0, rate: 1 });

      expect(fake.prefetches).toEqual([]);
    });

    it('re-runs when the rate changes', () => {
      engine.dispatch({ type: 'load', sentences: LONG, startIndex: 0, rate: 1 });
      fake.fire.start();

      engine.dispatch({ type: 'setRate', rate: 2 });
      fake.fire.start();

      expect(fake.prefetches).toHaveLength(2);
      expect(fake.prefetches[1]).toHaveLength(3);
    });

    it('re-runs from the new cursor after a seek', () => {
      engine.dispatch({ type: 'load', sentences: LONG, startIndex: 0, rate: 1 });
      fake.fire.start();

      engine.dispatch({ type: 'seek', index: 5 });
      fake.fire.start();

      expect(fake.prefetches[1]?.[0]).toEqual({ text: LONG[6]?.text, voice: 'Samantha' });
    });

    it('does not prefetch while paused', () => {
      engine.dispatch({ type: 'load', sentences: LONG, startIndex: 0, rate: 1 });
      fake.fire.start();
      engine.dispatch({ type: 'pause' });
      fake.prefetches.length = 0;

      engine.dispatch({ type: 'next' });

      expect(fake.prefetches).toEqual([]);
    });

    it('does nothing when the speaker has no prefetch', () => {
      const bare = fakeSpeaker({ prefetch: false });
      const plain = new PlaybackEngine({ speaker: bare.speaker, resolveVoice, now: () => time });
      plain.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });

      expect(() => bare.fire.start()).not.toThrow();
      expect(plain.getStatus().phase).toBe('playing');
      expect(bare.prefetches).toEqual([]);
    });
  });

  describe('stop', () => {
    it('returns to idle and forgets the session', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      fake.fire.start();

      engine.dispatch({ type: 'stop' });

      expect(status().phase).toBe('idle');
      expect(status().total).toBe(0);
      expect(status().charsRead).toBe(0);
      expect(status().voice).toBe('');
      expect(engine.getSnapshot()).toBeNull();
    });

    it('ignores events after stopping', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      fake.fire.start();
      engine.dispatch({ type: 'stop' });
      events.length = 0;

      fake.fire.word(0, 5);
      fake.fire.end();

      expect(events).toHaveLength(0);
    });
  });

  describe('speed estimate', () => {
    it('reports characters per second once enough time has passed', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      fake.fire.start();
      fake.fire.word(0, 5);
      fake.fire.word(6, 11);

      time = 1000;
      expect(status().charsPerSec).toBeCloseTo(11, 5);
    });

    it('withholds the estimate until the sample is meaningful', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      fake.fire.start();
      fake.fire.word(0, 5);

      time = 100;
      expect(status().charsPerSec).toBe(0);
    });

    it('excludes paused time from the estimate', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      fake.fire.start();
      fake.fire.word(0, 5);
      fake.fire.word(6, 11);

      time = 1000;
      engine.dispatch({ type: 'pause' });
      time = 60_000;

      expect(status().charsPerSec).toBeCloseTo(11, 5);
    });
  });

  describe('snapshot and restore', () => {
    it('captures the session so the service worker can persist it', () => {
      engine.setTabId(7);
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 1, rate: 1.5 });
      engine.dispatch({ type: 'sync', docId: 'doc-1' });
      fake.fire.start();
      fake.fire.word(0, 7);

      const snapshot = engine.getSnapshot();
      expect(snapshot).toMatchObject({
        tabId: 7,
        docId: 'doc-1',
        index: 1,
        rate: 1.5,
        voice: 'Samantha',
        resumeOffset: 7,
        charsRead: 19,
      });
      expect(snapshot?.sentenceCount).toBe(3);
    });

    it('restores into paused without speaking', () => {
      const other = new PlaybackEngine({ speaker: fake.speaker, resolveVoice, now: () => time });
      other.restore({
        tabId: 7,
        docId: 'doc-1',
        sentenceCount: 3,
        charsTotal: TOTAL_CHARS,
        index: 1,
        resumeOffset: 0,
        voice: 'Samantha',
        rate: 2,
        charsRead: 12,
      });

      const restored = other.getStatus();
      expect(restored.phase).toBe('paused');
      expect(restored.index).toBe(0); // Clamped to 0 because sentences are empty
      expect(restored.rate).toBe(2);
      expect(restored.total).toBe(0); // No sentences loaded yet
      expect(restored.charsTotal).toBe(TOTAL_CHARS); // Preserved from snapshot
      expect(fake.requests).toHaveLength(0);
    });

    it('restores a snapshot with no sentences into paused (will become idle after sync)', () => {
      const other = new PlaybackEngine({ speaker: fake.speaker, resolveVoice, now: () => time });
      other.restore({
        tabId: 7,
        docId: 'doc-1',
        sentenceCount: 0,
        charsTotal: 0,
        index: 0,
        resumeOffset: 0,
        voice: '',
        rate: 1,
        charsRead: 0,
      });

      // Restore always sets phase to 'paused', even with no sentences.
      // The phase will become 'idle' after sync when content script doesn't send any.
      expect(other.getStatus().phase).toBe('paused');
    });
  });

  describe('sync', () => {
    it('adopts the document id of the connecting content script', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      engine.dispatch({ type: 'sync', docId: 'doc-1' });

      expect(engine.getSnapshot()?.docId).toBe('doc-1');
    });

    it('re-announces the current status so a reconnected player catches up', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      engine.dispatch({ type: 'sync', docId: 'doc-1' });
      fake.fire.start();
      events.length = 0;

      engine.dispatch({ type: 'sync', docId: 'doc-1' });

      expect(lastStatus()?.phase).toBe('playing');
      expect(lastStatus()?.index).toBe(0);
    });

    it('ends a session that belongs to a different document', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      engine.dispatch({ type: 'sync', docId: 'doc-1' });
      fake.fire.start();

      engine.dispatch({ type: 'sync', docId: 'doc-2' });

      expect(status().phase).toBe('idle');
      expect(status().total).toBe(0);
    });

    it('tells a reader with no session to send its document again', () => {
      // A recycled worker comes back with nothing. The reader believes it
      // already sent its sentences and will never send them again by itself,
      // so an engine that cannot resume has to say so — otherwise pressing
      // play does nothing, forever, with no error anywhere to look at.
      engine.dispatch({ type: 'sync', docId: 'doc-1' });

      expect(events).toContainEqual({ type: 'session-lost' });
    });

    it('does not ask for the document again when it still has one', () => {
      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      events.length = 0;

      engine.dispatch({ type: 'sync', docId: 'doc-1' });

      expect(events).not.toContainEqual({ type: 'session-lost' });
    });
  });

  describe('subscriptions', () => {
    it('stops delivering events after unsubscribe', () => {
      const seen: EngineEvent[] = [];
      const off = engine.subscribe((event) => seen.push(event));

      engine.dispatch({ type: 'load', sentences: SENTENCES, startIndex: 0, rate: 1 });
      expect(seen.length).toBeGreaterThan(0);

      off();
      engine.dispatch({ type: 'stop' });
      expect(seen.some((e) => e.type === 'status' && e.status.phase === 'idle')).toBe(false);
    });

    it('detaches from the speaker and disposes it', () => {
      engine.dispose();
      expect(fake.speaker.dispose).toHaveBeenCalled();
    });
  });
});
