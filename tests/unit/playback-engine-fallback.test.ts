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
      { text: 'Hello world.', voice: 'Samantha', rate: 1, lang: 'en', volume: 1, resumeTimeMs: 0 },
    ]);

    fallback.fire.start();
    expect(engine.getStatus().phase).toBe('playing');

    fallback.fire.end();
    expect(engine.getStatus().phase).toBe('ended');
    expect(engine.getStatus().error).toBeUndefined();
  });

  it('reports what the speaker actually said, not only that it failed', () => {
    const primary = fakeSpeaker();
    const fallback = fakeSpeaker();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const engine = new PlaybackEngine({
        speaker: primary.speaker,
        fallbackSpeaker: fallback.speaker,
        resolveVoice: () => 'Samantha',
      });

      engine.dispatch({ type: 'load', sentences: [SENTENCE], startIndex: 0, rate: 1 });
      primary.fire.start();
      primary.fire.error('kokoro-82m tier fp16 has not been downloaded');

      // The provider's own message is the only thing that says which failure
      // this is. Dropped, every cause reaches the console as the same three
      // words and there is nothing left to act on.
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('kokoro-82m tier fp16 has not been downloaded')
      );
    } finally {
      warn.mockRestore();
    }
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

    // Stopped, not disposed: the primary is retried on the next session.
    expect(primary.speaker.dispose).not.toHaveBeenCalled();

    // A late `end` from the utterance Chrome was still tearing down must not
    // advance the session past the sentence the fallback is now speaking.
    primary.fire.end();
    expect(engine.getStatus().index).toBe(0);
    expect(engine.getStatus().phase).not.toBe('ended');
  });

  it('asks the fallback voice resolver while the fallback speaks', () => {
    const primary = fakeSpeaker();
    const fallback = fakeSpeaker();
    const engine = new PlaybackEngine({
      speaker: primary.speaker,
      fallbackSpeaker: fallback.speaker,
      // A cloud voice id; the browser speaker cannot use it.
      resolveVoice: () => 'zh-CN-XiaoxiaoNeural',
      resolveFallbackVoice: () => 'Samantha',
    });

    engine.dispatch({ type: 'load', sentences: [SENTENCE], startIndex: 0, rate: 1 });
    primary.fire.error('audio-error');

    expect(fallback.requests[0]?.voice).toBe('Samantha');
  });

  it('returns to the primary for the next session', () => {
    const primary = fakeSpeaker();
    const fallback = fakeSpeaker();
    const engine = new PlaybackEngine({
      speaker: primary.speaker,
      fallbackSpeaker: fallback.speaker,
      resolveVoice: () => 'Samantha',
    });

    engine.dispatch({ type: 'load', sentences: [SENTENCE], startIndex: 0, rate: 1 });
    primary.fire.error('audio-error');
    expect(fallback.requests).toHaveLength(1);

    // A page reload starts a new session: a transient failure must not pin
    // the browser voice until the extension is reloaded.
    engine.dispatch({ type: 'load', sentences: [SENTENCE], startIndex: 0, rate: 1 });
    expect(primary.requests).toHaveLength(2);
    expect(fallback.requests).toHaveLength(1);

    primary.fire.start();
    primary.fire.end();
    expect(engine.getStatus().phase).toBe('ended');
  });

  it('retries the primary mid-session and replays the current sentence', () => {
    const primary = fakeSpeaker();
    const fallback = fakeSpeaker();
    const engine = new PlaybackEngine({
      speaker: primary.speaker,
      fallbackSpeaker: fallback.speaker,
      resolveVoice: () => 'Samantha',
    });

    engine.dispatch({
      type: 'load',
      sentences: [SENTENCE, { text: 'Second.', lang: 'en' }],
      startIndex: 0,
      rate: 1,
    });
    primary.fire.error('audio-error');
    fallback.fire.start();

    engine.retryPrimary();

    expect(primary.requests).toHaveLength(2);
    expect(primary.requests[1]?.text).toBe('Hello world.');
    // The fallback was stopped, so its utterance can no longer move the cursor.
    fallback.fire.end();
    expect(engine.getStatus().index).toBe(0);
  });

  it('keeps a paused session paused when the primary is retried', () => {
    const primary = fakeSpeaker();
    const fallback = fakeSpeaker();
    const engine = new PlaybackEngine({
      speaker: primary.speaker,
      fallbackSpeaker: fallback.speaker,
      resolveVoice: () => 'Samantha',
    });

    engine.dispatch({ type: 'load', sentences: [SENTENCE], startIndex: 0, rate: 1 });
    primary.fire.error('audio-error');
    fallback.fire.start();
    engine.dispatch({ type: 'pause' });

    engine.retryPrimary();

    expect(primary.requests).toHaveLength(1);
    expect(engine.getStatus().phase).toBe('paused');

    engine.dispatch({ type: 'play' });
    expect(primary.requests).toHaveLength(2);
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
