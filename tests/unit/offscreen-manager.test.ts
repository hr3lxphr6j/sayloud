import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type OffscreenApi, OffscreenManager, type RuntimeApi } from '~/lib/offscreen-manager';
import type { OffscreenCommand } from '~/lib/offscreen-protocol';

function fakeOffscreen(hasDocument = false) {
  const offscreen: OffscreenApi = {
    hasDocument: vi.fn(async () => hasDocument),
    createDocument: vi.fn(async () => {}),
  };
  return offscreen;
}

function fakeRuntime(reply: unknown = undefined) {
  const sent: unknown[] = [];
  const runtime: RuntimeApi = {
    sendMessage: vi.fn(async (message: unknown) => {
      sent.push(message);
      return reply;
    }),
  };
  return { runtime, sent };
}

/** The error Chrome throws when nothing is listening yet. */
function missingReceiver(): Error {
  return new Error('Could not establish connection. Receiving end does not exist.');
}

const SYNTHESIZE: OffscreenCommand = {
  type: 'synthesize',
  id: 's1',
  text: 'hello',
  voiceId: 'v1',
  lang: 'en-US',
  config: { provider: 'dashscope', apiKey: 'k' },
};

describe('OffscreenManager.ensureReady', () => {
  it('does nothing when a document is already there', async () => {
    const offscreen = fakeOffscreen(true);
    const { runtime } = fakeRuntime();

    await new OffscreenManager({ offscreen, runtime }).ensureReady();

    expect(offscreen.createDocument).not.toHaveBeenCalled();
  });

  it('creates the document with an audio reason', async () => {
    const offscreen = fakeOffscreen(false);
    const { runtime } = fakeRuntime();

    await new OffscreenManager({ offscreen, runtime }).ensureReady();

    expect(offscreen.createDocument).toHaveBeenCalledWith({
      url: 'offscreen.html',
      reasons: ['AUDIO_PLAYBACK'],
      justification: expect.stringContaining('audio'),
    });
  });

  it('creates only one document when two callers ask at once', async () => {
    const offscreen = fakeOffscreen(false);
    let release: () => void = () => {};
    vi.mocked(offscreen.createDocument).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        })
    );
    const manager = new OffscreenManager({ offscreen, runtime: fakeRuntime().runtime });

    const first = manager.ensureReady();
    const second = manager.ensureReady();
    expect(manager.isCreating).toBe(true);

    // Let the shared promise get as far as calling `createDocument`.
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);

    expect(offscreen.createDocument).toHaveBeenCalledTimes(1);
    expect(manager.isCreating).toBe(false);
  });

  it('lets a later call retry after a failed creation', async () => {
    const offscreen = fakeOffscreen(false);
    vi.mocked(offscreen.createDocument).mockRejectedValueOnce(new Error('no permission'));
    const manager = new OffscreenManager({ offscreen, runtime: fakeRuntime().runtime });

    await expect(manager.ensureReady()).rejects.toThrow('no permission');
    await expect(manager.ensureReady()).resolves.toBeUndefined();

    expect(offscreen.createDocument).toHaveBeenCalledTimes(2);
  });
});

describe('OffscreenManager.sendCommand', () => {
  let offscreen: OffscreenApi;
  let runtime: ReturnType<typeof fakeRuntime>;
  let manager: OffscreenManager;

  beforeEach(() => {
    offscreen = fakeOffscreen(false);
    runtime = fakeRuntime();
    manager = new OffscreenManager({ offscreen, runtime: runtime.runtime });
  });

  it('prepares the document and sends the command', async () => {
    await manager.sendCommand(SYNTHESIZE);

    expect(offscreen.createDocument).toHaveBeenCalled();
    expect(runtime.sent).toEqual([SYNTHESIZE]);
  });

  it('returns a well-formed reply', async () => {
    runtime = fakeRuntime({ durationMs: 1200, hasTimings: true });
    manager = new OffscreenManager({ offscreen, runtime: runtime.runtime });

    await expect(manager.sendCommand(SYNTHESIZE)).resolves.toEqual({
      durationMs: 1200,
      hasTimings: true,
    });
  });

  it.each([
    ['a non-object', 'done'],
    ['a missing duration', { hasTimings: false }],
    ['a non-numeric duration', { durationMs: '1200', hasTimings: false }],
    ['an infinite duration', { durationMs: Number.POSITIVE_INFINITY, hasTimings: false }],
    ['a missing timings flag', { durationMs: 1200 }],
  ])('reports %s reply as no reply', async (_label, reply) => {
    runtime = fakeRuntime(reply);
    manager = new OffscreenManager({ offscreen, runtime: runtime.runtime });

    await expect(manager.sendCommand(SYNTHESIZE)).resolves.toBeUndefined();
  });

  it('retries while the document is still starting', async () => {
    const delay = vi.fn(async () => {});
    vi.mocked(runtime.runtime.sendMessage)
      .mockRejectedValueOnce(missingReceiver())
      .mockResolvedValueOnce({ durationMs: 500, hasTimings: false });
    manager = new OffscreenManager({ offscreen, runtime: runtime.runtime, delay });

    await expect(manager.sendCommand(SYNTHESIZE)).resolves.toEqual({
      durationMs: 500,
      hasTimings: false,
    });
    expect(delay).toHaveBeenCalledTimes(1);
  });

  it('gives up after the last attempt', async () => {
    vi.mocked(runtime.runtime.sendMessage).mockRejectedValue(missingReceiver());
    manager = new OffscreenManager({ offscreen, runtime: runtime.runtime, delay: async () => {} });

    await expect(manager.sendCommand(SYNTHESIZE)).rejects.toThrow('Receiving end does not exist');
    expect(runtime.runtime.sendMessage).toHaveBeenCalledTimes(3);
  });

  it('does not retry a failure that is not a missing listener', async () => {
    vi.mocked(runtime.runtime.sendMessage).mockRejectedValue(new Error('the message is invalid'));
    manager = new OffscreenManager({ offscreen, runtime: runtime.runtime, delay: async () => {} });

    await expect(manager.sendCommand(SYNTHESIZE)).rejects.toThrow('the message is invalid');
    expect(runtime.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('does not retry a rejection that is not an error', async () => {
    vi.mocked(runtime.runtime.sendMessage).mockRejectedValue('the worker is gone');
    manager = new OffscreenManager({ offscreen, runtime: runtime.runtime, delay: async () => {} });

    await expect(manager.sendCommand(SYNTHESIZE)).rejects.toBe('the worker is gone');
    expect(runtime.runtime.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('waits before retrying by default', async () => {
    vi.mocked(runtime.runtime.sendMessage)
      .mockRejectedValueOnce(missingReceiver())
      .mockResolvedValueOnce({ durationMs: 1, hasTimings: false });
    manager = new OffscreenManager({ offscreen, runtime: runtime.runtime });

    await expect(manager.sendCommand(SYNTHESIZE)).resolves.toEqual({
      durationMs: 1,
      hasTimings: false,
    });
  });

  it('does not create a document for a command that must not', async () => {
    await expect(manager.sendCommand({ type: 'stop' }, { create: false })).resolves.toBeUndefined();

    expect(offscreen.createDocument).not.toHaveBeenCalled();
    expect(runtime.sent).toEqual([]);
  });

  it('sends a command that must not create, when a document is there', async () => {
    offscreen = fakeOffscreen(true);
    manager = new OffscreenManager({ offscreen, runtime: runtime.runtime });

    await manager.sendCommand({ type: 'stop' }, { create: false });

    expect(runtime.sent).toEqual([{ type: 'stop' }]);
  });
});
