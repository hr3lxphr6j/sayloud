import { describe, expect, it, vi } from 'vitest';
import { CONFIG_KEY, type LocalStorageArea, SELECTED_VOICES_KEY } from '~/lib/config-store';
import { createApp, type OffscreenDeps } from '~/lib/container';
import type { OffscreenCommand, SynthesizeReply } from '~/lib/offscreen-protocol';
import type { EngineEvent } from '~/lib/protocol';
import { DEFAULT_SETTINGS, SETTINGS_KEY } from '~/lib/settings-store';
import type { SessionStorageArea } from '~/lib/snapshot-store';
import type { TtsApi, TtsSpeakOptions, TtsVoiceLike } from '~/lib/speaker';

const VOICES: TtsVoiceLike[] = [{ voiceName: 'Samantha', lang: 'en-US' }];

function fakeTts() {
  const calls: Array<{ text: string; options: TtsSpeakOptions }> = [];
  const tts: TtsApi = {
    speak: (text, options) => {
      calls.push({ text, options });
    },
    stop: vi.fn(),
    getVoices: async () => VOICES,
  };
  return { tts, calls };
}

function fakeSession(): SessionStorageArea {
  const data = new Map<string, unknown>();
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

function fakeLocal(
  initial: Record<string, unknown> = {}
): LocalStorageArea & { remove(key: string): Promise<void> } {
  const data = new Map<string, unknown>(Object.entries(initial));
  return {
    async get(key) {
      const names = Array.isArray(key) ? key : [key];
      const stored: Record<string, unknown> = {};
      for (const name of names) stored[name] = data.get(name);
      return stored;
    },
    async set(items) {
      for (const [key, value] of Object.entries(items)) data.set(key, value);
    },
    async remove(key) {
      data.delete(key);
    },
  };
}

/** The offscreen document, as the service worker sees it. */
function fakeOffscreen(reply: SynthesizeReply = { durationMs: 1000, hasTimings: false }) {
  const commands: OffscreenCommand[] = [];
  const listeners = new Set<(message: unknown) => void>();

  const deps: OffscreenDeps = {
    offscreen: {
      hasDocument: vi.fn(async () => false),
      createDocument: vi.fn(async () => {}),
    },
    runtime: {
      sendMessage: vi.fn(async (message: unknown) => {
        commands.push(message as OffscreenCommand);
        const command = message as OffscreenCommand;
        return command.type === 'synthesize' ? reply : undefined;
      }),
    },
    events: {
      addListener: (listener) => {
        listeners.add(listener);
      },
      removeListener: (listener) => {
        listeners.delete(listener);
      },
    },
  };

  return {
    deps,
    commands,
    /** Deliver an event from the document, as `runtime.onMessage` would. */
    deliver: (message: unknown): void => {
      for (const listener of [...listeners]) listener(message);
    },
    synthesizeIds(): string[] {
      return commands.flatMap((command) => (command.type === 'synthesize' ? [command.id] : []));
    },
  };
}

const CLOUD_CONFIG = { provider: 'dashscope' as const, apiKey: 'k', model: 'cosyvoice-v3' };

/** Commands and reads settle in a microtask; the tests wait for that turn. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe('createApp', () => {
  it('reads the settings from the storage area it was given', async () => {
    const { tts } = fakeTts();
    const app = createApp({ tts, storage: { session: fakeSession(), local: fakeLocal() } });

    expect(await app.settings.load()).toEqual(DEFAULT_SETTINGS);

    await app.settings.update({ volume: 0.5 });

    expect((await app.settings.load()).volume).toBe(0.5);
  });

  it('is not ready until the settings have been read', async () => {
    const { tts } = fakeTts();
    const local = fakeLocal();
    const gate: { release: (() => void) | undefined } = { release: undefined };
    const slow: LocalStorageArea & { remove(key: string): Promise<void> } = {
      async get(key) {
        const names = Array.isArray(key) ? key : [key];
        if (names.includes(SETTINGS_KEY)) {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
        }
        return local.get(key);
      },
      set: (items) => local.set(items),
      remove: (key) => local.remove(key),
    };
    const app = createApp({ tts, storage: { session: fakeSession(), local: slow } });

    let ready = false;
    void app.ready.then(() => {
      ready = true;
    });
    await tick();
    expect(ready).toBe(false);

    gate.release?.();
    await app.ready;

    expect(ready).toBe(true);
  });

  it('speaks with the browser voice when nothing is configured', async () => {
    const { tts, calls } = fakeTts();
    const app = createApp({ tts, storage: { session: fakeSession(), local: fakeLocal() } });

    await app.ready;
    await app.router.start();
    app.engine.load([{ text: 'hello', lang: 'en-US' }], 0, 1);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.options.voiceName).toBe('Samantha');
    expect(app.speakers.isCloud).toBe(false);
  });

  it('speaks through the offscreen document when a provider and voice are saved', async () => {
    const { tts, calls } = fakeTts();
    const offscreen = fakeOffscreen();
    const app = createApp({
      tts,
      storage: {
        session: fakeSession(),
        local: fakeLocal({
          [CONFIG_KEY]: CLOUD_CONFIG,
          [SELECTED_VOICES_KEY]: { dashscope: 'longxiaochun' },
        }),
      },
      offscreen: offscreen.deps,
    });

    await app.ready;
    expect(app.speakers.isCloud).toBe(true);

    const events: EngineEvent[] = [];
    app.engine.subscribe((event) => events.push(event));
    app.engine.load([{ text: 'hello', lang: 'en-US' }], 0, 1);

    await vi.waitFor(() => {
      expect(offscreen.commands.some((command) => command.type === 'play')).toBe(true);
    });

    // The provider config travels with the text, and the voice is the one the
    // settings panel saved for that provider. The lang comes from the sentence.
    expect(offscreen.commands[0]).toEqual({
      type: 'synthesize',
      id: offscreen.synthesizeIds()[0],
      text: 'hello',
      voiceId: 'longxiaochun',
      lang: 'en-US',
      config: CLOUD_CONFIG,
    });
    expect(calls).toEqual([]);
    expect(
      events.some((event) => event.type === 'status' && event.status.phase === 'playing')
    ).toBe(true);
  });

  it('reports cloud word timings to the engine', async () => {
    const { tts } = fakeTts();
    const offscreen = fakeOffscreen({ durationMs: 1200, hasTimings: true });
    const app = createApp({
      tts,
      storage: {
        session: fakeSession(),
        local: fakeLocal({
          [CONFIG_KEY]: CLOUD_CONFIG,
          [SELECTED_VOICES_KEY]: { dashscope: 'longxiaochun' },
        }),
      },
      offscreen: offscreen.deps,
    });

    await app.ready;
    const events: EngineEvent[] = [];
    app.engine.subscribe((event) => events.push(event));
    app.engine.load([{ text: 'hello', lang: 'en-US' }], 0, 1);

    await vi.waitFor(() => {
      expect(offscreen.synthesizeIds()).toHaveLength(1);
    });
    const [id] = offscreen.synthesizeIds();
    offscreen.deliver({ type: 'word', id, charStart: 0, charEnd: 5 });

    expect(events).toContainEqual({ type: 'word', index: 0, charStart: 0, charEnd: 5 });
  });

  it('moves to the next sentence when the cloud voice finishes one', async () => {
    const { tts } = fakeTts();
    const offscreen = fakeOffscreen();
    const app = createApp({
      tts,
      storage: {
        session: fakeSession(),
        local: fakeLocal({
          [CONFIG_KEY]: CLOUD_CONFIG,
          [SELECTED_VOICES_KEY]: { dashscope: 'longxiaochun' },
        }),
      },
      offscreen: offscreen.deps,
    });

    await app.ready;
    app.engine.load(
      [
        { text: 'hello', lang: 'en-US' },
        { text: 'again', lang: 'en-US' },
      ],
      0,
      1
    );

    await vi.waitFor(() => {
      expect(offscreen.synthesizeIds()).toHaveLength(1);
    });
    const [first] = offscreen.synthesizeIds();
    offscreen.deliver({ type: 'sentence-end', id: first });

    await vi.waitFor(() => {
      expect(offscreen.synthesizeIds()).toHaveLength(2);
    });
    expect(
      offscreen.commands.flatMap((command) => (command.type === 'synthesize' ? [command.text] : []))
    ).toEqual(['hello', 'again']);
  });

  it('stops when the cloud voice fails', async () => {
    const { tts, calls } = fakeTts();
    const offscreen = fakeOffscreen();
    const app = createApp({
      tts,
      storage: {
        session: fakeSession(),
        local: fakeLocal({
          [CONFIG_KEY]: CLOUD_CONFIG,
          [SELECTED_VOICES_KEY]: { dashscope: 'longxiaochun' },
        }),
      },
      offscreen: offscreen.deps,
    });

    await app.ready;
    await app.router.start();
    app.engine.load([{ text: 'hello', lang: 'en-US' }], 0, 1);

    await vi.waitFor(() => {
      expect(offscreen.synthesizeIds()).toHaveLength(1);
    });
    const [id] = offscreen.synthesizeIds();
    offscreen.deliver({
      type: 'error',
      id,
      code: 'invalid-key',
      message: 'the key is not valid',
    });

    // The engine fails instead of falling back to the browser voice.
    await vi.waitFor(() => {
      expect(app.engine.getStatus().phase).toBe('error');
    });
    expect(calls).toHaveLength(0);
  });

  it('fails when a cloud provider has no voice selected', async () => {
    const { tts, calls } = fakeTts();
    const app = createApp({
      tts,
      storage: {
        session: fakeSession(),
        local: fakeLocal({ [CONFIG_KEY]: CLOUD_CONFIG }),
      },
      offscreen: fakeOffscreen().deps,
    });

    await app.ready;
    await app.router.start();
    app.engine.load([{ text: 'hello', lang: 'en-US' }], 0, 1);

    await vi.waitFor(() => {
      expect(app.engine.getStatus().phase).toBe('error');
    });
    expect(app.speakers.isCloud).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('uses the browser voice when this build has no offscreen document', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { tts, calls } = fakeTts();
    const app = createApp({
      tts,
      storage: {
        session: fakeSession(),
        local: fakeLocal({
          [CONFIG_KEY]: CLOUD_CONFIG,
          [SELECTED_VOICES_KEY]: { dashscope: 'longxiaochun' },
        }),
      },
    });

    await app.ready;
    await app.router.start();
    app.engine.load([{ text: 'hello', lang: 'en-US' }], 0, 1);

    expect(app.speakers.isCloud).toBe(false);
    expect(calls).toHaveLength(1);
    warn.mockRestore();
  });

  it('continues on the new voice when the provider changes mid-sentence', async () => {
    const { tts, calls } = fakeTts();
    const local = fakeLocal({
      [CONFIG_KEY]: CLOUD_CONFIG,
      [SELECTED_VOICES_KEY]: { dashscope: 'longxiaochun' },
    });
    const offscreen = fakeOffscreen();
    const app = createApp({
      tts,
      storage: { session: fakeSession(), local },
      offscreen: offscreen.deps,
    });

    await app.ready;
    await app.router.start();
    app.engine.load(
      [
        { text: 'hello', lang: 'en-US' },
        { text: 'again', lang: 'en-US' },
      ],
      0,
      1
    );
    await vi.waitFor(() => {
      expect(offscreen.commands.some((command) => command.type === 'play')).toBe(true);
    });

    // The provider is switched while the cloud voice is mid-sentence.
    await local.set({ [CONFIG_KEY]: { provider: 'browser' } });
    await app.speakers.refresh();

    // The sentence that was cut off is reported as ended, so the engine moves
    // to the next one — on the voice that is now configured.
    await vi.waitFor(() => {
      expect(calls).toHaveLength(1);
    });
    expect(calls[0]?.text).toBe('again');
    expect(calls[0]?.options.voiceName).toBe('Samantha');
  });

  it('switches speakers when the saved provider changes', async () => {
    const { tts } = fakeTts();
    const local = fakeLocal();
    const offscreen = fakeOffscreen();
    const app = createApp({
      tts,
      storage: { session: fakeSession(), local },
      offscreen: offscreen.deps,
    });

    await app.ready;
    expect(app.speakers.isCloud).toBe(false);

    await local.set({
      [CONFIG_KEY]: CLOUD_CONFIG,
      [SELECTED_VOICES_KEY]: { dashscope: 'longxiaochun' },
    });
    await app.speakers.refresh();

    expect(app.speakers.isCloud).toBe(true);
    expect(app.speakers.resolveVoice('en-US')).toBe('longxiaochun');
  });
});
