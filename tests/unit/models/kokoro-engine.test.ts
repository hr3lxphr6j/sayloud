/**
 * The Kokoro session, from the side that can ask it to load twice at once.
 *
 * That is the whole reason this class is not inside the worker: the bug it
 * guards against needs two `load()` calls in flight together, and a browser
 * cannot be asked to produce that on demand. A seek during the first session is
 * the only stretch long enough for one to fit inside, and it lasts twelve
 * seconds.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fromPretrained } = vi.hoisted(() => ({ fromPretrained: vi.fn() }));

vi.mock('kokoro-js', () => ({
  KokoroTTS: { from_pretrained: fromPretrained },
}));

const { KokoroEngine } = await import('~/lib/models/kokoro-engine');

/** A session shaped like the one `kokoro-js` hands back, with a spy on it. */
function fakeSession() {
  const dispose = vi.fn();
  return { session: { model: { dispose } }, dispose };
}

/** A promise whose settling this test decides. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe('KokoroEngine.load', () => {
  beforeEach(() => {
    fromPretrained.mockReset();
  });

  it('disposes the session a newer load superseded', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    fromPretrained.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const engine = new KokoroEngine();
    const stale = engine.load('kokoro-82m', 'fp16', 'webgpu');
    // Both calls see `tts === null`, so both build one. The slower one used to
    // simply be written over.
    const fresh = engine.load('kokoro-82m', 'fp16', 'webgpu');

    const staleSession = fakeSession();
    const freshSession = fakeSession();
    first.resolve(staleSession.session);
    second.resolve(freshSession.session);

    await expect(stale).rejects.toThrow('superseded');
    await expect(fresh).resolves.toMatchObject({ device: 'webgpu' });

    // The losing session is the point: once `tts` has been overwritten nothing
    // else can reach it, so it holds its weights for the life of the document.
    expect(staleSession.dispose).toHaveBeenCalledTimes(1);
    expect(freshSession.dispose).not.toHaveBeenCalled();
  });

  it('keeps the newest session when the older call finishes last', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    fromPretrained.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const engine = new KokoroEngine();
    const stale = engine.load('kokoro-82m', 'fp16', 'webgpu');
    const fresh = engine.load('kokoro-82m', 'fp16', 'webgpu');

    const staleSession = fakeSession();
    const freshSession = fakeSession();
    // Out of order on purpose: the generation check is what makes the winner
    // the newer *request* rather than the one that happened to resolve last.
    second.resolve(freshSession.session);
    first.resolve(staleSession.session);

    await expect(stale).rejects.toThrow('superseded');
    await expect(fresh).resolves.toMatchObject({ device: 'webgpu' });
    expect(staleSession.dispose).toHaveBeenCalledTimes(1);
  });

  it('reuses the session when nothing about it changed', async () => {
    fromPretrained.mockResolvedValue(fakeSession().session);
    const engine = new KokoroEngine();

    await engine.load('kokoro-82m', 'fp16', 'webgpu');
    await engine.load('kokoro-82m', 'fp16', 'webgpu');

    // A seek, a new sentence and a voice change all call this; rebuilding
    // 163 MB for each would be the slowest thing in the extension.
    expect(fromPretrained).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the device changed', async () => {
    fromPretrained.mockResolvedValue(fakeSession().session);
    const engine = new KokoroEngine();

    await engine.load('kokoro-82m', 'fp16', 'webgpu');
    await engine.load('kokoro-82m', 'fp16', 'wasm');

    expect(fromPretrained).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a session after dispose', async () => {
    fromPretrained.mockResolvedValue(fakeSession().session);
    const engine = new KokoroEngine();

    await engine.load('kokoro-82m', 'fp16', 'webgpu');
    engine.dispose();
    await engine.load('kokoro-82m', 'fp16', 'webgpu');

    // `dispose` drops the device back to the default, so a later load with the
    // same preference is not mistaken for the session that is already gone.
    expect(fromPretrained).toHaveBeenCalledTimes(2);
  });

  it('refuses a tier the registry does not have', async () => {
    const engine = new KokoroEngine();

    await expect(engine.load('kokoro-82m', 'nope', 'webgpu')).rejects.toThrow(
      'unknown model or tier'
    );
    expect(fromPretrained).not.toHaveBeenCalled();
  });
});
