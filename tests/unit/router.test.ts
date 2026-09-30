import { describe, expect, it, vi } from 'vitest';
import { PlaybackEngine } from '~/lib/playback-engine';
import type { EngineCommand, EngineEvent, SessionSnapshot } from '~/lib/protocol';
import { type RouterPort, SessionRouter } from '~/lib/router';
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

/** A port the router can talk to, and that a test can send commands through. */
function fakePort(tabId: number) {
  const sent: EngineEvent[] = [];
  let onMessage: ((message: unknown) => void) | null = null;
  const port: RouterPort = {
    senderTabId: tabId,
    postMessage: (message) => sent.push(message),
    onMessage: (handler) => {
      onMessage = handler;
    },
    onDisconnect: () => {},
  };
  return {
    port,
    sent,
    send: (message: EngineCommand): void => onMessage?.(message),
  };
}

/** Commands reach the engine in a microtask; the tests wait for that turn. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
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

describe('SessionRouter.handleTabActivated', () => {
  /** A router with a session already loading in tab 1. */
  async function reading(tabId = 1) {
    const { engine, router } = build();
    const port = fakePort(tabId);
    router.handlePort(port.port);
    port.send({
      type: 'load',
      sentences: [{ text: 'Hello world.', lang: 'en' }],
      startIndex: 0,
      rate: 1,
    });
    await tick();
    return { engine, router };
  }

  it('pauses the session when the user switches to another tab', async () => {
    const { engine, router } = await reading();

    router.handleTabActivated(2);

    expect(engine.getStatus().phase).toBe('paused');
  });

  it('leaves the session alone when the setting says to keep playing', async () => {
    const { engine, router } = await reading();

    router.handleTabActivated(2, true);

    // The fake speaker never reports `start`, so the session sits in `loading`:
    // what matters is that switching tabs did not pause it.
    expect(engine.getStatus().phase).toBe('loading');
  });
});
