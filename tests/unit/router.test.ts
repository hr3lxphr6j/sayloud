import { describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from '~/lib/playback-engine';
import type { SessionSnapshot } from '~/lib/protocol';
import { SessionRouter } from '~/lib/router';
import { type SessionStorageArea, SNAPSHOT_KEY, SnapshotStore } from '~/lib/snapshot-store';
import type { Speaker, TtsApi, TtsVoiceLike } from '~/lib/speaker';
import { VoiceCache } from '~/lib/voice-cache';

const VOICES: TtsVoiceLike[] = [{ voiceName: 'Samantha', lang: 'en-US' }];

const SNAPSHOT: SessionSnapshot = {
  tabId: 3,
  docId: 'doc-1',
  sentences: [
    { text: 'Hello world.', lang: 'en' },
    { text: 'Goodbye now.', lang: 'en' },
  ],
  index: 1,
  resumeOffset: 0,
  voice: 'Samantha',
  rate: 1,
  charsRead: 12,
};

function fakeTts(): TtsApi {
  return {
    speak: vi.fn(),
    stop: vi.fn(),
    getVoices: vi.fn(async () => VOICES),
  };
}

function fakeArea(initial: Record<string, unknown> = {}): SessionStorageArea {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(key) {
      return { [key]: data.get(key) };
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

function fakeSpeaker(): Speaker {
  return {
    speak: vi.fn(),
    stop: vi.fn(),
    on() {
      return () => {};
    },
    dispose: vi.fn(),
  };
}

/** The whole graph over fakes, wired the way `createApp` wires it. */
function build(initial: Record<string, unknown> = {}) {
  const tts = fakeTts();
  const voices = new VoiceCache(tts);
  const engine = new PlaybackEngine({
    speaker: fakeSpeaker(),
    resolveVoice: (lang) => voices.resolve(lang),
  });
  const snapshots = new SnapshotStore(fakeArea(initial));
  const router = new SessionRouter({ engine, snapshots, voices });

  return { tts, voices, engine, snapshots, router };
}

describe('SessionRouter.start', () => {
  it('refreshes the voice cache on every start, not only a cold one', async () => {
    const { tts, voices, router } = build();

    await router.start();
    expect(tts.getVoices).toHaveBeenCalledTimes(1);
    expect(voices.isEmpty).toBe(false);

    // A recycled service worker runs start() again with an already warm cache.
    // The refresh has to be unconditional, or voices installed while the worker
    // was asleep would never be picked up.
    await router.start();
    expect(tts.getVoices).toHaveBeenCalledTimes(2);
  });

  it('restores a persisted session in a paused state', async () => {
    const { engine, router } = build({ [SNAPSHOT_KEY]: SNAPSHOT });

    await router.start();

    const status = engine.getStatus();
    expect(status.phase).toBe('paused');
    expect(status.total).toBe(2);
    expect(status.index).toBe(1);
    expect(engine.getSnapshot()?.tabId).toBe(3);
  });

  it('starts idle when nothing was persisted', async () => {
    const { engine, router } = build();

    await router.start();

    expect(engine.getStatus().phase).toBe('idle');
  });
});
