import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OffscreenEvent } from '~/lib/offscreen-protocol';
import type { SynthesisResult, WordTiming } from '~/lib/providers/types';
import { type AudioLike, TimelinePlayer } from '~/lib/timeline-player';

/** A fake clock, so a word's delay can be inspected instead of waited for. */
function fakeClock() {
  let nextId = 1;
  const pending = new Map<number, { run: () => void; delayMs: number }>();

  return {
    setTimer: (run: () => void, delayMs: number): number => {
      const id = nextId++;
      pending.set(id, { run, delayMs });
      return id;
    },
    clearTimer: (id: number): void => {
      pending.delete(id);
    },
    get size(): number {
      return pending.size;
    },
    /** The delay of the one scheduled callback, or null when idle. */
    delay(): number | null {
      const [entry] = [...pending.values()];
      return entry ? entry.delayMs : null;
    },
    runNext(): void {
      const run = this.take();
      if (!run) throw new Error('no timer is scheduled');
      run();
    },
    /** Remove and return the scheduled callback, without running it. */
    take(): (() => void) | null {
      const [id, entry] = [...pending.entries()][0] ?? [];
      if (id === undefined || !entry) return null;
      pending.delete(id);
      return entry.run;
    },
  };
}

/** The audio elements the player created, plus the events it can be told about. */
function fakeAudios() {
  const created: AudioLike[] = [];
  const createAudio = (): AudioLike => {
    const audio: AudioLike = {
      src: '',
      currentTime: 0,
      playbackRate: 1,
      duration: Number.NaN,
      paused: true,
      play: vi.fn(async () => {
        audio.paused = false;
      }),
      pause: vi.fn(() => {
        audio.paused = true;
      }),
      onloadedmetadata: null,
      onerror: null,
      onended: null,
    };
    created.push(audio);
    return audio;
  };

  return {
    created,
    createAudio,
    /** The audio of the nth (0-based) created element. */
    at(index: number): AudioLike {
      const audio = created[index];
      if (!audio) throw new Error(`no audio was created at index ${index}`);
      return audio;
    },
    metadata(audio: AudioLike, seconds: number): void {
      audio.duration = seconds;
      audio.onloadedmetadata?.();
    },
    error(audio: AudioLike): void {
      audio.onerror?.();
    },
    ended(audio: AudioLike): void {
      audio.paused = true;
      audio.onended?.();
    },
  };
}

function result(overrides: Partial<SynthesisResult> = {}): SynthesisResult {
  return {
    audio: new ArrayBuffer(8),
    mime: 'audio/mpeg',
    durationMs: 0,
    ...overrides,
  };
}

/** Timings for "hello world", four characters each. */
const TIMINGS: WordTiming[] = [
  { charStart: 0, charEnd: 5, startMs: 0, endMs: 400 },
  { charStart: 6, charEnd: 11, startMs: 500, endMs: 900 },
];

describe('TimelinePlayer', () => {
  let clock: ReturnType<typeof fakeClock>;
  let audios: ReturnType<typeof fakeAudios>;
  let events: OffscreenEvent[];
  let urls: string[];
  let revoked: string[];
  let player: TimelinePlayer;

  beforeEach(() => {
    clock = fakeClock();
    audios = fakeAudios();
    events = [];
    urls = [];
    revoked = [];

    player = new TimelinePlayer({
      emit: (event) => events.push(event),
      createAudio: audios.createAudio,
      createObjectUrl: () => {
        const url = `blob:${urls.length}`;
        urls.push(url);
        return url;
      },
      revokeObjectUrl: (url) => revoked.push(url),
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
    });
  });

  /** Load a sentence and let its metadata arrive. */
  async function load(id: string, synthesis: SynthesisResult, seconds = 2): Promise<void> {
    const loading = player.load(id, synthesis);
    audios.metadata(audios.at(audios.created.length - 1) as AudioLike, seconds);
    await loading;
  }

  describe('load', () => {
    it('uses the media element duration, not the provider report', async () => {
      const loading = player.load('a', result({ durationMs: 0 }));
      const audio = audios.at(0);
      audios.metadata(audio, 2.5);

      await expect(loading).resolves.toEqual({ durationMs: 2500, hasTimings: false });
      expect(audio.src).toBe('blob:0');
      expect(player.currentId).toBe('a');
    });

    it('falls back to the provider duration when the element has none', async () => {
      const loading = player.load('a', result({ durationMs: 1234 }));
      // `duration` stays NaN: a stream of unknown length.
      audios.at(0).onloadedmetadata?.();

      await expect(loading).resolves.toEqual({ durationMs: 1234, hasTimings: false });
    });

    it('reports whether timings are present', async () => {
      const loading = player.load('a', result({ timings: TIMINGS }));
      audios.metadata(audios.at(0), 1);

      await expect(loading).resolves.toEqual({ durationMs: 1000, hasTimings: true });
    });

    it('rejects and releases the url when the audio cannot be decoded', async () => {
      const loading = player.load('a', result());
      audios.error(audios.at(0));

      await expect(loading).rejects.toThrow('could not be decoded');
      expect(revoked).toEqual(['blob:0']);
      expect(player.currentId).toBeNull();
    });

    it('rejects when the metadata never arrives', async () => {
      const loading = player.load('a', result());
      clock.runNext();

      await expect(loading).rejects.toThrow('did not become ready in time');
      expect(revoked).toEqual(['blob:0']);
    });

    it('stops and releases the sentence it replaces', async () => {
      await load('a', result());
      await load('b', result());

      const first = audios.at(0);
      expect(first.pause).toHaveBeenCalled();
      expect(revoked).toEqual(['blob:0']);
      expect(player.currentId).toBe('b');
    });
  });

  describe('play', () => {
    it('seeks to the requested offset and starts the element', async () => {
      await load('a', result());
      await player.play('a', 750);

      const audio = audios.at(0);
      expect(audio.currentTime).toBeCloseTo(0.75);
      expect(audio.play).toHaveBeenCalled();
      expect(player.isPlaying).toBe(true);
    });

    it('refuses to play audio that is not loaded', async () => {
      await expect(player.play('nope')).rejects.toThrow('not loaded');
    });

    it('refuses to play a sentence other than the loaded one', async () => {
      await load('a', result());
      await expect(player.play('b')).rejects.toThrow('not loaded');
    });

    it('clamps a start time past the end of the audio', async () => {
      await load('a', result(), 1);
      await player.play('a', 5_000);

      expect(audios.at(0).currentTime).toBe(1);
    });

    it('plays from the start when the offset is not a number', async () => {
      await load('a', result(), 1);
      await player.play('a', Number.NaN);

      expect(audios.at(0).currentTime).toBe(0);
    });

    it('does not clamp an offset when the length is unknown', async () => {
      const loading = player.load('a', result({ durationMs: 0 }));
      // No metadata duration and no provider duration: nothing to clamp to.
      audios.at(0).onloadedmetadata?.();
      await loading;

      await player.play('a', 500);

      expect(audios.at(0).currentTime).toBeCloseTo(0.5);
    });

    it('treats a stalled playback rate as normal speed', async () => {
      await load('a', result({ timings: TIMINGS }));
      audios.at(0).playbackRate = 0;
      await player.play('a');

      // A rate of 0 would schedule the next word never; 1 is the sane reading.
      expect(clock.delay()).toBe(500);
    });

    it('reports each word when its start time arrives', async () => {
      await load('a', result({ timings: TIMINGS }));
      await player.play('a');

      // The first word starts at 0, so it is reported as soon as playback does.
      expect(events).toEqual([{ type: 'word', id: 'a', charStart: 0, charEnd: 5 }]);
      expect(clock.delay()).toBe(500);

      const audio = audios.at(0);
      audio.currentTime = 0.5;
      clock.runNext();

      expect(events).toEqual([
        { type: 'word', id: 'a', charStart: 0, charEnd: 5 },
        { type: 'word', id: 'a', charStart: 6, charEnd: 11 },
      ]);
      expect(clock.size).toBe(0);
    });

    it('divides the wait by the playback rate', async () => {
      await load('a', result({ timings: TIMINGS }));
      player.setRate(2);
      await player.play('a');

      // 500ms of audio at 2x is 250ms of wall clock.
      expect(clock.delay()).toBe(250);
    });

    it('skips the words a seek already passed and reports the one it landed on', async () => {
      await load('a', result({ timings: TIMINGS }));
      const audio = audios.at(0);
      audio.currentTime = 0.7;
      await player.play('a', 700);

      // The second word covers 500-900ms, so it is reported immediately and
      // nothing is left to schedule.
      expect(events).toEqual([{ type: 'word', id: 'a', charStart: 6, charEnd: 11 }]);
      expect(clock.size).toBe(0);
    });

    it('sorts timings that arrive out of order', async () => {
      const reversed = [TIMINGS[1] as WordTiming, TIMINGS[0] as WordTiming];
      await load('a', result({ timings: reversed }));
      await player.play('a');

      expect(events).toEqual([{ type: 'word', id: 'a', charStart: 0, charEnd: 5 }]);
      expect(clock.delay()).toBe(500);
    });

    it('ignores a rejection from an utterance that was already stopped', async () => {
      await load('a', result());
      const audio = audios.at(0);
      let rejectPlay: (error: Error) => void = () => {};
      audio.play = vi.fn(
        () =>
          new Promise<void>((_resolve, reject) => {
            rejectPlay = reject;
          })
      );

      const playing = player.play('a');
      player.stop();
      rejectPlay(new Error('the play() request was interrupted'));

      await expect(playing).resolves.toBeUndefined();
    });

    it('propagates a rejection from the current utterance', async () => {
      await load('a', result());
      const audio = audios.at(0);
      audio.play = vi.fn(async () => {
        throw new Error('autoplay refused');
      });

      await expect(player.play('a')).rejects.toThrow('autoplay refused');
    });
  });

  describe('sentence end', () => {
    it('reports the end of the sentence and stops the timeline', async () => {
      await load('a', result({ timings: TIMINGS }));
      await player.play('a');

      audios.ended(audios.at(0));

      expect(events).toEqual([
        { type: 'word', id: 'a', charStart: 0, charEnd: 5 },
        { type: 'sentence-end', id: 'a' },
      ]);
      expect(clock.size).toBe(0);
    });

    it('ignores an end from a sentence that was replaced', async () => {
      await load('a', result());
      const stale = audios.at(0);
      await load('b', result());

      audios.ended(stale);

      expect(events).toEqual([]);
    });
  });

  describe('pause and stop', () => {
    it('pauses the element and stops the word timeline', async () => {
      await load('a', result({ timings: TIMINGS }));
      await player.play('a');

      player.pause();

      expect(audios.at(0).pause).toHaveBeenCalled();
      expect(clock.size).toBe(0);
      expect(player.isPlaying).toBe(false);
    });

    it('releases the audio and its url', async () => {
      await load('a', result());
      player.stop();

      expect(revoked).toEqual(['blob:0']);
      expect(player.currentId).toBeNull();
      expect(clock.size).toBe(0);
    });

    it('is safe to call when nothing is loaded', () => {
      expect(() => player.stop()).not.toThrow();
      expect(revoked).toEqual([]);
    });

    it('ignores a queued word callback that fires after a stop', async () => {
      await load('a', result({ timings: TIMINGS }));
      await player.play('a');
      // A callback that has already been handed to the event loop when the
      // stop arrives cannot be cancelled, so the player has to ignore it.
      const queued = clock.take();
      player.stop();

      queued?.();

      expect(events).toEqual([{ type: 'word', id: 'a', charStart: 0, charEnd: 5 }]);
    });
  });

  describe('setRate', () => {
    it('reschedules the pending word when the rate changes mid-sentence', async () => {
      await load('a', result({ timings: TIMINGS }));
      await player.play('a');
      expect(clock.delay()).toBe(500);

      const audio = audios.at(0);
      audio.currentTime = 0.2;
      player.setRate(4);

      expect(audio.playbackRate).toBe(4);
      // 300ms of audio left at 4x.
      expect(clock.delay()).toBe(75);
    });

    it('applies the rate to a loaded but paused sentence without scheduling', async () => {
      await load('a', result({ timings: TIMINGS }));
      player.setRate(1.5);

      expect(audios.at(0).playbackRate).toBe(1.5);
      expect(clock.size).toBe(0);
    });

    it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('ignores the rate %s', (rate) => {
      player.setRate(rate);
      expect(clock.size).toBe(0);
    });

    it('ignores the rate when nothing is loaded', () => {
      expect(() => player.setRate(2)).not.toThrow();
    });
  });
});
