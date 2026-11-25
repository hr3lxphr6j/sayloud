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
import { voiceKey } from '~/lib/models/downloader';
import { KOKORO_82M } from '~/lib/models/registry';

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
 * assertion without a real vocabulary; the model call returns distinguishable
 * sample values, and `durations` when the test wants to see the timings path.
 */
/** The feeds the engine builds, and what a model call answers with. */
type ModelFeeds = { input_ids: { dims: number[] }; style: unknown; speed: { data: Float32Array } };
type ModelResult = {
  waveform: { data: Float32Array };
  durations?: { data: ArrayLike<number> } | undefined;
};

function speakingSession(options: { durations?: ArrayLike<number> } = {}) {
  const dispose = vi.fn();
  const generate = vi.fn(async () => ({ audio: new Float32Array([1, 1]) }));
  // `waveform.data` is what `generate_from_ids()` used to wrap in a RawAudio;
  // the engine reads the tensor directly now, so this is the same numbers.
  const modelCall = vi.fn(
    async (_feeds: ModelFeeds): Promise<ModelResult> => ({
      waveform: { data: new Float32Array(2_400) },
      durations: options.durations === undefined ? undefined : { data: options.durations },
    })
  );
  // Two parameters because `KokoroEngine` always passes the second one —
  // `{ truncation: false }` — and a one-parameter fake would make the argument
  // invisible to `mock.calls` as well as to the type checker.
  const tokenizer = vi.fn((text: string, _options?: { truncation?: boolean }) => ({
    input_ids: { dims: [1, text.length] },
  }));
  // `session.model` is the model itself — callable, with `dispose` on it.
  Object.assign(modelCall, { dispose });
  const session = { model: modelCall, generate, tokenizer };
  return { session, dispose, generate, tokenizer, modelCall };
}

/** An engine whose model is loaded and whose session is the given one. */
async function speaking(session: unknown): Promise<InstanceType<typeof KokoroEngine>> {
  fromPretrained.mockResolvedValue(session);
  const engine = new KokoroEngine({
    // The real loader reads Cache Storage; the fake hands the style vector
    // over, long enough for any slice the offset arithmetic can ask for.
    loadVoice: async () => new Float32Array(256 * 510),
  });
  await engine.load('kokoro-82m', 'fp32', 'wasm');
  return engine;
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

describe('KokoroEngine.load', () => {
  beforeEach(() => {
    fromPretrained.mockReset();
  });

  it('disposes the session a newer load superseded', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    fromPretrained.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);

    const engine = new KokoroEngine();
    const stale = engine.load('kokoro-82m', 'fp32', 'webgpu');
    // Both calls see `tts === null`, so both build one. The slower one used to
    // simply be written over.
    const fresh = engine.load('kokoro-82m', 'fp32', 'webgpu');

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
    const stale = engine.load('kokoro-82m', 'fp32', 'webgpu');
    const fresh = engine.load('kokoro-82m', 'fp32', 'webgpu');

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

    await engine.load('kokoro-82m', 'fp32', 'webgpu');
    await engine.load('kokoro-82m', 'fp32', 'webgpu');

    // A seek, a new sentence and a voice change all call this; rebuilding
    // 325 MB for each would be the slowest thing in the extension.
    expect(fromPretrained).toHaveBeenCalledTimes(1);
  });

  it('rebuilds when the device changed', async () => {
    fromPretrained.mockResolvedValue(fakeSession().session);
    const engine = new KokoroEngine();

    await engine.load('kokoro-82m', 'fp32', 'webgpu');
    await engine.load('kokoro-82m', 'fp32', 'wasm');

    expect(fromPretrained).toHaveBeenCalledTimes(2);
  });

  it('does not reuse a session after dispose', async () => {
    fromPretrained.mockResolvedValue(fakeSession().session);
    const engine = new KokoroEngine();

    await engine.load('kokoro-82m', 'fp32', 'webgpu');
    engine.dispose();
    await engine.load('kokoro-82m', 'fp32', 'webgpu');

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
 * **One path for all three languages.** An English piece used to go in as *text*
 * so `kokoro-js` phonemized it the way the model was trained — espeak plus the
 * substitutions applied afterwards — and Chinese and Japanese went in as IPA
 * because `generate()` rejects every voice outside its own 28-voice English
 * list. All three now arrive as IPA from the Rust phonemizer, so `generate()` is
 * gone from this class entirely.
 */
describe('KokoroEngine.synthesize', () => {
  const PIECES = [{ ipa: 'həlˈoʊ' }, { ipa: ' wˈɜːld' }];

  beforeEach(() => {
    fromPretrained.mockReset();
  });

  it('renders every piece and joins them into one buffer', async () => {
    const session = speakingSession();
    const engine = await speaking(session.session);

    const pcm = await engine.synthesize(1, PIECES, 'af_heart', 'en-US');

    expect(session.modelCall).toHaveBeenCalledTimes(2);
    expect(session.generate).not.toHaveBeenCalled();
    // Same sample rate by construction, so the concatenation is exact.
    expect(pcm.sampleRate).toBe(24_000);
    expect(pcm.pcm.length).toBe(4_800);
  });

  it('speaks English from the IPA the Rust pipeline produced', async () => {
    // English used to reach `generate()` as text, which meant a second
    // front end ran over words that had already been phonemized — and the token
    // count in `countTokens()` described the IPA rather than what was spoken.
    // The assertion is the same shape as the one below it now, which is the
    // point: the language no longer picks a path.
    const session = speakingSession();
    const engine = await speaking(session.session);

    await engine.synthesize(1, [PIECES[0] as (typeof PIECES)[number]], 'af_heart', 'en-GB');

    expect(session.tokenizer).toHaveBeenCalledWith('həlˈoʊ', { truncation: false });
    // The model is called with the same three feeds `generate_from_ids()` used
    // to build — the style vector now sliced here, from the voice file.
    expect(session.modelCall).toHaveBeenCalledTimes(1);
    const feeds = session.modelCall.mock.calls[0]?.[0] as {
      input_ids: { dims: number[] };
      speed: { data: Float32Array };
    };
    expect(feeds.input_ids.dims).toEqual([1, 6]);
    expect([...feeds.speed.data]).toEqual([1]);
    expect(session.generate).not.toHaveBeenCalled();
  });

  it('speaks Chinese and Japanese from the IPA too', async () => {
    // `generate()` validates the voice against its own list of 28 English
    // voices, which is why these two never used it. Kept as a test of its own
    // because the list is `kokoro-js`'s and this engine no longer depends on
    // whether a voice happens to be in it.
    const session = speakingSession();
    const engine = await speaking(session.session);

    await engine.synthesize(1, [PIECES[0] as (typeof PIECES)[number]], 'zf_xiaobei', 'zh-CN');
    await engine.synthesize(2, [PIECES[0] as (typeof PIECES)[number]], 'jf_alpha', 'ja-JP');

    expect(session.tokenizer).toHaveBeenNthCalledWith(1, 'həlˈoʊ', { truncation: false });
    expect(session.modelCall).toHaveBeenCalledTimes(2);
    expect(session.generate).not.toHaveBeenCalled();
  });

  it('does not truncate at the model\u2019s limit', async () => {
    // `truncation: true` would silently cut an over-long piece mid-word, which
    // reads as a bad sentence rather than as a bug — and `planPieces` has
    // already cut against this same tokenizer, so the limit is not reached
    // legitimately. Asserted on every language now, because the reason used to
    // be stated only for the count.
    const session = speakingSession();
    const engine = await speaking(session.session);

    await engine.synthesize(1, PIECES, 'af_heart', 'en-US');

    for (const call of session.tokenizer.mock.calls) {
      expect(call[1]).toEqual({ truncation: false });
    }
  });

  it('stops rendering the pieces still to come once it is cancelled', async () => {
    const session = speakingSession();
    const engine = await speaking(session.session);
    const first = deferred<ModelResult>();
    session.modelCall.mockReturnValueOnce(first.promise);

    const synthesis = engine.synthesize(7, PIECES, 'af_heart', 'en-US');
    await tick();
    engine.cancel(7);
    first.resolve({ waveform: { data: new Float32Array([1]) } });

    await expect(synthesis).rejects.toThrow('aborted');
    // The second piece is not rendered: the caller has moved on, and rendering
    // it would occupy the device for audio nobody will play.
    expect(session.modelCall).toHaveBeenCalledTimes(1);
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

describe('KokoroEngine voice loading', () => {
  beforeEach(() => {
    fromPretrained.mockReset();
  });

  it('reads the voice from the key the downloader wrote', async () => {
    // The key must be built from the voice *id* — `voiceKey` applies the
    // model's `voiceFile` template itself, and a caller that passes a path
    // doubles every segment (`voices/x.bin.bin`), which answers 404.
    const matched: string[] = [];
    vi.stubGlobal('caches', {
      open: async () => ({
        match: async (key: string) => {
          matched.push(key);
          return new Response(new ArrayBuffer(522_240));
        },
      }),
    });

    // No injected loader: the real path is what builds the key.
    const session = speakingSession();
    Object.assign(session.modelCall, { dispose: session.dispose });
    fromPretrained.mockResolvedValue({ model: session.modelCall, tokenizer: session.tokenizer });
    const engine = new KokoroEngine();
    await engine.load('kokoro-82m', 'fp32', 'wasm');
    await engine.synthesize(1, [{ ipa: 'həlˈoʊ' }], 'zf_xiaoyi', 'zh-CN');

    expect(matched).toEqual([voiceKey(KOKORO_82M, 'zf_xiaoyi')]);
    vi.unstubAllGlobals();
  });
});

describe('KokoroEngine word-timings wiring', () => {
  beforeEach(() => {
    fromPretrained.mockReset();
  });

  it('forwards the word timings the durations produce, shifted by earlier pieces', async () => {
    // The arithmetic lives in `word-timings.ts` and is tested there; this one
    // line pins the wiring: the engine hands the model's durations and the
    // piece's spans to it, and puts the answer on the reply.
    const session = speakingSession({ durations: [0.5, 1, 1, 1, 1, 1, 1, 0.5] });
    const engine = await speaking(session.session);

    const result = await engine.synthesize(
      1,
      [
        {
          ipa: 'həlˈoʊ',
          spans: [{ charStart: 10, charEnd: 13, phonemeStart: 0, phonemeEnd: 3 }],
        },
      ],
      'af_heart',
      'en-US'
    );

    expect(result.timings?.[0]).toEqual({
      charStart: 10,
      charEnd: 13,
      startMs: expect.closeTo((0.5 / 7) * 100, 4),
      endMs: expect.closeTo((3.5 / 7) * 100, 4),
    });
  });

  it('plays without timings when the model has no durations output', async () => {
    const session = speakingSession();
    const engine = await speaking(session.session);

    const result = await engine.synthesize(
      1,
      [{ ipa: 'həlˈoʊ', spans: SPANS }],
      'af_heart',
      'en-US'
    );

    expect(result.timings).toBeUndefined();
  });
});

/** The spans the timing tests share, over 'həlˈoʊ'. */
const SPANS = [
  { charStart: 10, charEnd: 13, phonemeStart: 0, phonemeEnd: 3 },
  { charStart: 14, charEnd: 17, phonemeStart: 4, phonemeEnd: 6 },
];
