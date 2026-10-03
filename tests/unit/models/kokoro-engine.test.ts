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

/**
 * A session that can actually speak.
 *
 * The tokenizer reports one token per character, so a count is readable in an
 * assertion without a real vocabulary; `generate` and `generate_from_ids`
 * return distinguishable sample values, which is what says which path a
 * language took.
 */
function speakingSession() {
  const dispose = vi.fn();
  const generate = vi.fn(async () => ({ audio: new Float32Array([1, 1]) }));
  const generateFromIds = vi.fn(async () => ({ audio: new Float32Array([2]) }));
  const tokenizer = vi.fn((text: string) => ({ input_ids: { dims: [1, text.length] } }));
  const session = {
    model: { dispose },
    generate,
    generate_from_ids: generateFromIds,
    tokenizer,
  };
  return { session, dispose, generate, generateFromIds, tokenizer };
}

/** A promise whose settling this test decides. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

/** Let every microtask queued by the engine run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** An engine whose model is loaded and whose session is the given one. */
async function speaking(session: unknown): Promise<InstanceType<typeof KokoroEngine>> {
  fromPretrained.mockResolvedValue(session);
  const engine = new KokoroEngine();
  await engine.load('kokoro-82m', 'fp16', 'wasm');
  return engine;
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

/**
 * What the engine does with pieces that are already phonemized.
 *
 * The two paths are the whole reason a piece carries both its text and its IPA:
 * English goes in as text so `kokoro-js` phonemizes it the way the model was
 * trained, and Chinese and Japanese go in as IPA because `generate()` rejects
 * every voice outside its own 28-voice English list.
 */
describe('KokoroEngine.synthesize', () => {
  const PIECES = [
    { text: 'hello', ipa: 'həlˈoʊ' },
    { text: ' world', ipa: ' wˈɜːld' },
  ];

  beforeEach(() => {
    fromPretrained.mockReset();
  });

  it('renders every piece and joins them into one buffer', async () => {
    const session = speakingSession();
    const engine = await speaking(session.session);

    const pcm = await engine.synthesize(1, PIECES, 'af_heart', 'en-US');

    expect(session.generate).toHaveBeenCalledTimes(2);
    // Same sample rate by construction, so the concatenation is exact.
    expect(pcm.sampleRate).toBe(24_000);
    expect([...pcm.pcm]).toEqual([1, 1, 1, 1]);
  });

  it('speaks English through the library\u2019s own front end', async () => {
    // The reason a piece carries its text at all. `generate()` applies the
    // number, punctuation and character substitutions Kokoro was trained on;
    // re-implementing them here is how the two would drift apart.
    const session = speakingSession();
    const engine = await speaking(session.session);

    await engine.synthesize(1, [PIECES[0] as (typeof PIECES)[number]], 'af_heart', 'en-GB');

    expect(session.generate).toHaveBeenCalledWith('hello', { voice: 'af_heart' });
    expect(session.generateFromIds).not.toHaveBeenCalled();
  });

  it('speaks Chinese and Japanese from the IPA', async () => {
    // `generate()` validates the voice against its own list of 28 English
    // voices, so these two languages cannot use it at all.
    const session = speakingSession();
    const engine = await speaking(session.session);

    await engine.synthesize(1, [PIECES[0] as (typeof PIECES)[number]], 'zf_xiaobei', 'zh-CN');
    await engine.synthesize(2, [PIECES[0] as (typeof PIECES)[number]], 'jf_alpha', 'ja-JP');

    expect(session.tokenizer).toHaveBeenNthCalledWith(1, 'həlˈoʊ', { truncation: false });
    expect(session.generateFromIds).toHaveBeenCalledTimes(2);
    expect(session.generate).not.toHaveBeenCalled();
  });

  it('stops rendering the pieces still to come once it is cancelled', async () => {
    const session = speakingSession();
    const engine = await speaking(session.session);
    const first = deferred<{ audio: Float32Array<ArrayBuffer> }>();
    session.generate.mockReturnValueOnce(first.promise);

    const synthesis = engine.synthesize(7, PIECES, 'af_heart', 'en-US');
    await tick();
    engine.cancel(7);
    first.resolve({ audio: new Float32Array([1]) });

    await expect(synthesis).rejects.toThrow('aborted');
    // The second piece is not rendered: the caller has moved on, and rendering
    // it would occupy the device for audio nobody will play.
    expect(session.generate).toHaveBeenCalledTimes(1);
  });

  it('refuses to speak before a model is loaded', async () => {
    const engine = new KokoroEngine();

    await expect(engine.synthesize(1, PIECES, 'af_heart', 'en-US')).rejects.toThrow(
      'the model is not loaded'
    );
  });
});

/**
 * The count the coordinator cuts a sentence with.
 *
 * Without truncation on purpose: `generate()` passes `truncation: true`, so a
 * count taken that way would come back clamped at the limit and a sentence over
 * it would look exactly like one at it.
 */
describe('KokoroEngine.countTokens', () => {
  beforeEach(() => {
    fromPretrained.mockReset();
  });

  it('counts the whole string, not a truncated one', async () => {
    const session = speakingSession();
    const engine = await speaking(session.session);

    expect(engine.countTokens('həlˈoʊ')).toBe(6);
    expect(session.tokenizer).toHaveBeenCalledWith('həlˈoʊ', { truncation: false });
  });

  it('refuses to count before a model is loaded', () => {
    const engine = new KokoroEngine();

    expect(() => engine.countTokens('həlˈoʊ')).toThrow('the model is not loaded');
  });
});
