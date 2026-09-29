import { describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from '~/lib/playback-engine';
import type { Speaker, SpeakRequest } from '~/lib/speaker';

/**
 * Fake speaker mirroring the real one's contract: `stop()`/`dispose()`
 * invalidate the current utterance, so events fired afterwards are dropped just
 * like stale `chrome.tts` events would be.
 */
function fakeSpeaker() {
  const requests: SpeakRequest[] = [];
  const listeners = new Map<string, Set<(payload: never) => void>>();
  let live = false;

  const speaker: Speaker = {
    speak(request) {
      requests.push(request);
      live = true;
    },
    stop() {
      live = false;
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
    dispose: vi.fn(() => {
      live = false;
      listeners.clear();
    }),
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
    fire: {
      start: () => deliver('start', undefined),
      end: () => deliver('end', undefined),
      error: (message = 'boom') => deliver('error', message),
    },
  };
}

const SENTENCE = { text: 'Hello world.', lang: 'en' };

describe('PlaybackEngine fallback speaker', () => {
  it('switches to the fallback and replays the sentence when the primary fails', () => {
    const primary = fakeSpeaker();
    const fallback = fakeSpeaker();
    const engine = new PlaybackEngine({
      speaker: primary.speaker,
      fallbackSpeaker: fallback.speaker,
      resolveVoice: () => 'Samantha',
    });

    engine.dispatch({ type: 'load', sentences: [SENTENCE], startIndex: 0, rate: 1 });
    primary.fire.start();
    primary.fire.error('voice not found');

    // The failed utterance never advanced the cursor, so the fallback gets the
    // same sentence.
    expect(fallback.requests).toEqual([
      { text: 'Hello world.', voice: 'Samantha', rate: 1, lang: 'en' },
    ]);

    fallback.fire.start();
    expect(engine.getStatus().phase).toBe('playing');

    fallback.fire.end();
    expect(engine.getStatus().phase).toBe('ended');
    expect(engine.getStatus().error).toBeUndefined();
  });

  it('detaches from the primary so its stale events cannot move the cursor', () => {
    const primary = fakeSpeaker();
    const fallback = fakeSpeaker();
    const engine = new PlaybackEngine({
      speaker: primary.speaker,
      fallbackSpeaker: fallback.speaker,
      resolveVoice: () => 'Samantha',
    });

    engine.dispatch({ type: 'load', sentences: [SENTENCE], startIndex: 0, rate: 1 });
    primary.fire.start();
    primary.fire.error('voice not found');

    expect(primary.speaker.dispose).toHaveBeenCalled();

    // A late `end` from the utterance Chrome was still tearing down must not
    // advance the session past the sentence the fallback is now speaking.
    primary.fire.end();
    expect(engine.getStatus().index).toBe(0);
    expect(engine.getStatus().phase).not.toBe('ended');
  });

  it('does not retry when the fallback fails too', () => {
    const primary = fakeSpeaker();
    const fallback = fakeSpeaker();
    const engine = new PlaybackEngine({
      speaker: primary.speaker,
      fallbackSpeaker: fallback.speaker,
      resolveVoice: () => 'Samantha',
    });

    engine.dispatch({ type: 'load', sentences: [SENTENCE], startIndex: 0, rate: 1 });
    primary.fire.start();
    primary.fire.error('voice not found');
    fallback.fire.error('fallback failed');

    const status = engine.getStatus();
    expect(status.phase).toBe('error');
    expect(status.error).toBe('tts-error');
    // One attempt each: no bouncing between speakers.
    expect(fallback.requests).toHaveLength(1);
    expect(primary.requests).toHaveLength(1);
  });

  it('fails immediately when there is no fallback speaker', () => {
    const primary = fakeSpeaker();
    const engine = new PlaybackEngine({
      speaker: primary.speaker,
      resolveVoice: () => 'Samantha',
    });

    engine.dispatch({ type: 'load', sentences: [SENTENCE], startIndex: 0, rate: 1 });
    primary.fire.start();
    primary.fire.error('voice not found');

    expect(engine.getStatus().phase).toBe('error');
    expect(engine.getStatus().error).toBe('tts-error');
  });

  it('does not fall back for errors that a second speaker cannot fix', () => {
    const primary = fakeSpeaker();
    const fallback = fakeSpeaker();
    const engine = new PlaybackEngine({
      speaker: primary.speaker,
      fallbackSpeaker: fallback.speaker,
      resolveVoice: () => undefined,
    });

    engine.dispatch({
      type: 'load',
      sentences: [{ text: 'Bonjour.', lang: 'fr-FR' }],
      startIndex: 0,
      rate: 1,
    });

    // No installed voice is a dead end for any speaker; the UI has to offer the
    // install hint instead of silently reading with a different voice.
    expect(engine.getStatus().error).toBe('no-voice');
    expect(fallback.requests).toHaveLength(0);
  });
});
