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
  sentenceCount: 2,
  charsTotal: 24, // 'Hello world.' (12) + 'Goodbye now.' (12)
  index: 1,
  resumeOffset: 0,
  voice: 'Samantha',
  rate: 1,
  charsRead: 12,
};

function fakeTts(): TtsApi {
  return { speak: vi.fn(), stop: vi.fn(), getVoices: vi.fn(async () => VOICES) };
}

function fakeArea(initial: Record<string, unknown> = {}): SessionStorageArea {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(key) {
      return { [key]: data.get(key) };
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) {
        // Chrome storage API behavior: setting undefined removes the key
        if (value === undefined) {
          data.delete(key);
        } else {
          data.set(key, value);
        }
      }
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
  return { port, sent, send: (message: EngineCommand): void => onMessage?.(message) };
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
  const snapshots = new SnapshotStore(fakeArea(initial), fakeArea());
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
    expect(status.total).toBe(0); // No sentences loaded yet (will be reloaded via sync)
    expect(status.index).toBe(0); // Clamped to 0 because no sentences yet
    expect(status.charsTotal).toBe(SNAPSHOT.charsTotal); // Kept for the panel
  });

  it('starts idle when nothing was persisted', async () => {
    const { engine, router } = build();

    await router.start();

    expect(engine.getStatus().phase).toBe('idle');
  });
});

describe('SessionRouter recovery after a recycled worker', () => {
  /**
   * Hold the voice list until the test releases it.
   *
   * `start()` awaits this first, which is exactly the window a reconnecting
   * reader fires its `sync` into: the port died with the old worker, the reader
   * retries after 250ms, and the new worker is still restoring.
   */
  function gateVoices(tts: TtsApi): () => void {
    let release!: () => void;
    const pending = new Promise<TtsVoiceLike[]>((resolve) => {
      release = () => resolve(VOICES);
    });
    tts.getVoices = vi.fn(() => pending);
    return release;
  }

  it('answers a sync that arrives while start() is still restoring', async () => {
    const { tts, router } = build();
    const release = gateVoices(tts);

    const port = fakePort(5);
    router.handlePort(port.port);

    const starting = router.start();
    port.send({ type: 'sync', docId: 'doc-1' });
    release();
    await starting;
    await tick();

    // Without this answer the reader waits forever: it believes it already sent
    // its sentences, so `session-lost` is the only thing that makes it send
    // them again. Dropping it leaves an engine with nothing to play and a play
    // button that does nothing at all.
    expect(port.sent).toContainEqual({ type: 'session-lost' });
  });

  it('does not restore over a session the reader has already rebuilt', async () => {
    const { engine, router, voices, tts } = build({ [SNAPSHOT_KEY]: SNAPSHOT });
    await voices.refresh(); // Warm, so the reader's `load` is not held up by voices.
    const release = gateVoices(tts);

    const port = fakePort(3);
    router.handlePort(port.port);

    const starting = router.start();
    port.send({
      type: 'load',
      sentences: [{ text: 'Hello world.', lang: 'en' }],
      startIndex: 0,
      rate: 1,
    });
    await tick();
    expect(engine.getStatus().total).toBe(1);

    release();
    await starting;

    // The reader got here first and sent its document. Restoring a snapshot
    // that carries no sentences over it would drop them again — a recovery
    // that undoes itself.
    expect(engine.getStatus().total).toBe(1);
  });

  it('keeps the stored snapshot when a restored session has no sentences yet', async () => {
    const { engine, router, snapshots } = build({ [SNAPSHOT_KEY]: SNAPSHOT });
    await router.start();

    const port = fakePort(3);
    router.handlePort(port.port);
    port.send({ type: 'play' });
    await tick();
    await tick();

    // A paused engine without sentences is waiting for its reader, not
    // finished. Forgetting the snapshot here throws away the only record of
    // where the session was, and the next recycle has nothing left to restore.
    expect(engine.getStatus().phase).toBe('paused');
    expect(await snapshots.load()).not.toBeNull();
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
