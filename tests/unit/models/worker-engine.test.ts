/**
 * The two nested workers, as the engine above them sees them.
 *
 * The case worth guarding is the one that is invisible in a browser: a worker
 * that throws outside a request it is answering. Nothing in the page can see
 * that stack, and if the engine is not listening for it the request in flight
 * waits forever — which reads as "playback does nothing" rather than as an
 * error, and is exactly how the on-device path failed in manual testing.
 *
 * Phase 7 added a second worker, and with it a failure the single-worker engine
 * could not have: one worker dying while the other is still healthy. A sentence
 * is only half done at that point — its phonemes exist but nothing will
 * synthesize them — so the engine has to take both down rather than leave a
 * request waiting on a worker that can no longer make progress.
 *
 * The happy path is covered too, because every test here would pass just as
 * well against an engine that rejects everything.
 */
import { describe, expect, it } from 'vitest';
import { isWorkerDeadError } from '~/lib/models/engine';
import type { PhonemizeWorkerRequest } from '~/lib/models/phonemize-worker-protocol';
import { KOKORO_82M, type ModelTier, tierById } from '~/lib/models/registry';
import { type WorkerLike, WorkerLocalEngine } from '~/lib/models/worker-engine';
import type { WorkerRequest } from '~/lib/models/worker-protocol';

type AnyRequest = WorkerRequest | PhonemizeWorkerRequest;

/** A worker that records what it was sent, and can be made to die. */
class FakeWorker {
  readonly posted: AnyRequest[] = [];
  terminated = 0;
  /**
   * Answers every request, when a test wants the exchange to just work.
   *
   * Returning undefined means "no reply", which is what a test that is driving
   * the exchange by hand wants.
   */
  handler: ((message: AnyRequest) => unknown) | null = null;

  private messageListener: ((event: MessageEvent) => void) | null = null;
  private errorListener: ((event: ErrorEvent) => void) | null = null;
  private messageErrorListener: ((event: MessageEvent) => void) | null = null;

  postMessage(message: unknown): void {
    const request = message as AnyRequest;
    this.posted.push(request);

    const reply = this.handler?.(request);
    if (reply === undefined) return;
    // Queued rather than sent inline: the real worker cannot answer before the
    // caller has finished posting, and a test that could would hide an ordering
    // bug rather than catch one.
    queueMicrotask(() => this.reply(reply as never));
  }

  addEventListener(type: string, listener: unknown): void {
    if (type === 'message') this.messageListener = listener as (event: MessageEvent) => void;
    else if (type === 'error') this.errorListener = listener as (event: ErrorEvent) => void;
    else if (type === 'messageerror')
      this.messageErrorListener = listener as (event: MessageEvent) => void;
  }

  removeEventListener(type: string, listener: unknown): void {
    if (type === 'message' && this.messageListener === listener) this.messageListener = null;
    else if (type === 'error' && this.errorListener === listener) this.errorListener = null;
    else if (type === 'messageerror' && this.messageErrorListener === listener) {
      this.messageErrorListener = null;
    }
  }

  terminate(): void {
    this.terminated += 1;
  }

  /** Every listener still attached, so teardown can be asserted. */
  get listeners(): number {
    return (
      (this.messageListener === null ? 0 : 1) +
      (this.errorListener === null ? 0 : 1) +
      (this.messageErrorListener === null ? 0 : 1)
    );
  }

  /** Answer a request the way the real worker does. */
  reply(reply: unknown): void {
    this.messageListener?.({ data: reply } as MessageEvent);
  }

  /** Fail the way a worker does when it throws outside a request. */
  crash(message = 'boom'): void {
    this.errorListener?.({ message } as ErrorEvent);
  }

  /** Fail the way a worker does when a reply cannot be deserialized. */
  breakChannel(): void {
    this.messageErrorListener?.({} as MessageEvent);
  }

  /** The types of the messages it was sent, in order. */
  get types(): string[] {
    return this.posted.map((message) => message.type);
  }
}

/** The fake is structurally a worker; the cast keeps the test readable. */
function asWorker(worker: FakeWorker): WorkerLike {
  return worker as unknown as WorkerLike;
}

/** Let every microtask queued by the engine run. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function tierOf(id: string): ModelTier {
  const tier = tierById(KOKORO_82M, id);
  if (!tier) throw new Error(`the registry has no ${id} tier`);
  return tier;
}

function setup() {
  const kokoro = new FakeWorker();
  const phonemizer = new FakeWorker();
  const engine = new WorkerLocalEngine({
    worker: asWorker(kokoro),
    phonemizeWorker: asWorker(phonemizer),
    source: { host: 'modelscope' },
  });
  return { kokoro, phonemizer, engine };
}

type Workers = ReturnType<typeof setup>;
type Handler = (message: never) => unknown;

/** Answer every request this worker can be sent. */
function serve(worker: FakeWorker, handlers: Record<string, Handler>): void {
  worker.handler = (message) => handlers[message.type]?.(message as never);
}

/**
 * Both workers, answering the way the real ones do.
 *
 * A test then states only the replies it cares about: leaving `prepare`
 * unanswered is indistinguishable from a worker that hung, and a test that has
 * to remember to answer it is a test that will one day forget.
 */
function serveAll(
  { kokoro, phonemizer }: Workers,
  overrides: { kokoro?: Record<string, Handler>; phonemizer?: Record<string, Handler> } = {}
): void {
  serve(kokoro, {
    init: (message) => ({ type: 'ready', id: (message as { id: number }).id }),
    load: (message) => ({
      type: 'loaded',
      id: (message as { id: number }).id,
      info: { device: 'wasm', sessionInitMs: 5 },
    }),
    count: (message) => ({ type: 'counted', id: (message as { id: number }).id, tokens: 1 }),
    synthesize: (message) => ({
      type: 'pcm',
      id: (message as { id: number }).id,
      pcm: new Float32Array([0.5, -0.5]),
      sampleRate: 24_000,
    }),
    ...overrides.kokoro,
  });
  serve(phonemizer, {
    init: (message) => ({ type: 'ready', id: (message as { id: number }).id }),
    prepare: (message) => ({ type: 'prepared', id: (message as { id: number }).id }),
    phonemize: (message) => {
      const { id, text } = message as { id: number; text: string };
      return { type: 'phonemized', id, phonemes: `ipa:${text}` };
    },
    ...overrides.phonemizer,
  });
}

/** The model's session, loaded and ready to synthesize. */
async function loaded() {
  const workers = setup();
  serveAll(workers);
  await workers.engine.load(KOKORO_82M, tierOf('fp16'), 'wasm');
  return workers;
}

/** Answer the handshake and wait for the request that follows it. */
async function handshake(kokoro: FakeWorker, phonemizer: FakeWorker): Promise<void> {
  kokoro.reply({ type: 'ready', id: 1 });
  phonemizer.reply({ type: 'ready', id: 1 });
  await tick();
}

describe('WorkerLocalEngine', () => {
  it('resolves a load the worker answers', async () => {
    const { kokoro, phonemizer, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    await handshake(kokoro, phonemizer);
    kokoro.reply({
      type: 'loaded',
      id: 2,
      info: { device: 'webgpu', sessionInitMs: 5 },
    });

    await expect(loading).resolves.toEqual({ device: 'webgpu', sessionInitMs: 5 });
  });

  it('sends the handshake before the load', async () => {
    const { kokoro, phonemizer, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    expect(kokoro.posted).toEqual([
      { type: 'init', id: 1, source: { host: 'modelscope' }, allowFallback: false },
    ]);

    await handshake(kokoro, phonemizer);
    expect(kokoro.posted[1]).toEqual({
      type: 'load',
      id: 2,
      modelId: 'kokoro-82m',
      tierId: 'fp16',
      device: 'webgpu',
    });

    kokoro.reply({ type: 'loaded', id: 2, info: { device: 'webgpu', sessionInitMs: 1 } });
    await loading;
  });

  it('instantiates the phonemizer while the model is still loading', async () => {
    // The two have nothing to do with each other — 5 MB of wasm against a
    // 163 MB ONNX session — so the load must not be what triggers the second
    // handshake, and the second handshake must not wait for the first to be
    // answered.
    const { kokoro, phonemizer, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'wasm');

    expect(kokoro.types).toEqual(['init']);
    expect(phonemizer.types).toEqual(['init']);

    await handshake(kokoro, phonemizer);
    kokoro.reply({ type: 'loaded', id: 2, info: { device: 'wasm', sessionInitMs: 1 } });
    await loading;
  });

  it('rejects the request in flight when the worker dies', async () => {
    const { kokoro, phonemizer, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    // Attached before the crash so the rejection is never unhandled.
    const failure = expect(loading).rejects.toThrow('boom');

    await handshake(kokoro, phonemizer);
    kokoro.crash('boom');

    await failure;
  });

  it('names the failure so the provider knows to rebuild the engine', async () => {
    const { kokoro, engine } = setup();
    kokoro.crash('the GPU process went away');

    const error = await engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu').catch((e: unknown) => e);

    expect(isWorkerDeadError(error)).toBe(true);
    expect((error as Error).message).toBe('the GPU process went away');
  });

  it('treats an undeliverable reply the same way', async () => {
    const { kokoro, engine } = setup();
    kokoro.breakChannel();

    const error = await engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu').catch((e: unknown) => e);

    expect(isWorkerDeadError(error)).toBe(true);
  });

  it('takes the healthy worker down when the other one dies', async () => {
    // The failure the second worker introduced. The phonemizer is gone, so the
    // phonemes this sentence needs will never be produced — and a kokoro worker
    // left running would answer a request nothing is waiting for while its own
    // pending request hangs.
    const { kokoro, phonemizer, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'wasm');
    const failure = expect(loading).rejects.toThrow('the dictionary is corrupt');

    await handshake(kokoro, phonemizer);
    phonemizer.crash('the dictionary is corrupt');

    await failure;
    expect(kokoro.terminated).toBe(1);
    expect(phonemizer.terminated).toBe(1);
    expect(kokoro.listeners).toBe(0);
  });

  it('fails at once once a worker is gone, without sending anything to it', async () => {
    const { kokoro, phonemizer, engine } = setup();
    kokoro.crash('worker died');
    const posted = kokoro.posted.length;

    await expect(engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu')).rejects.toThrow('worker died');

    // A request that cannot be answered must not be sent to a dead worker.
    expect(kokoro.posted).toHaveLength(posted);
    expect(phonemizer.posted).toHaveLength(0);
  });

  it('fails an in-flight synthesis, not only a load', async () => {
    const { kokoro, phonemizer, engine } = await loaded();
    serveAll(
      { kokoro, phonemizer, engine },
      // Nothing answers the inference, so it is still running when the crash
      // arrives — which is the state the request has to be freed from.
      { kokoro: { synthesize: () => undefined } }
    );

    const synthesis = engine.synthesize('hello', 'af_heart', 'en-US', new AbortController().signal);
    const failure = expect(synthesis).rejects.toThrow('boom');

    await tick();
    kokoro.crash('boom');

    await failure;
  });

  it('stops listening to the workers it has given up on', () => {
    const { kokoro, phonemizer } = setup();
    expect(kokoro.listeners).toBe(3);
    expect(phonemizer.listeners).toBe(3);

    kokoro.crash('boom');

    expect(kokoro.listeners).toBe(0);
    expect(phonemizer.listeners).toBe(0);
  });

  it('terminates each worker it can no longer trust, exactly once', () => {
    const { kokoro, phonemizer } = setup();
    kokoro.crash('boom');

    expect(kokoro.terminated).toBe(1);
    expect(phonemizer.terminated).toBe(1);

    kokoro.crash('second');
    phonemizer.crash('second');

    expect(kokoro.terminated).toBe(1);
    expect(phonemizer.terminated).toBe(1);
  });

  it('retries the handshake when it failed, rather than reusing the rejection', async () => {
    const { kokoro, phonemizer, engine } = setup();
    serveAll({ kokoro, phonemizer, engine });

    // The handshake fails while the worker is alive: a call made after that
    // must send a new `init` instead of returning the same rejection forever.
    const first = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    const firstFailure = expect(first).rejects.toThrow('no');
    kokoro.reply({ type: 'error', id: 1, code: 'model-load-failed', message: 'no' });
    await firstFailure;

    await expect(engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu')).resolves.toBeDefined();

    expect(kokoro.types.filter((type) => type === 'init')).toHaveLength(2);
    // The phonemizer's own handshake succeeded the first time, so it is not
    // repeated: the two are independent, which is the point of `Promise.all`.
    expect(phonemizer.types).toEqual(['init']);
  });

  it('rejects every waiting request when it is disposed', async () => {
    const { kokoro, phonemizer, engine } = setup();

    const loading = engine.load(KOKORO_82M, tierOf('fp16'), 'webgpu');
    const failure = expect(loading).rejects.toThrow('disposed');

    engine.dispose();

    await failure;
    expect(kokoro.terminated).toBe(1);
    expect(phonemizer.terminated).toBe(1);
    expect(kokoro.listeners).toBe(0);
    expect(phonemizer.listeners).toBe(0);
  });

  it('tells both workers it is done before terminating them', () => {
    const { kokoro, phonemizer, engine } = setup();
    engine.dispose();

    expect(kokoro.posted.at(-1)).toEqual({ type: 'dispose' });
    expect(phonemizer.posted.at(-1)).toEqual({ type: 'dispose' });
  });
});

describe('WorkerLocalEngine.synthesize', () => {
  it('phonemizes, counts, then synthesizes, in that order', async () => {
    const workers = await loaded();

    const pcm = await workers.engine.synthesize(
      'hello',
      'af_heart',
      'en-US',
      new AbortController().signal
    );

    expect(pcm.sampleRate).toBe(24_000);
    expect(pcm.pcm).toHaveLength(2);
    // The dictionary is prepared before the first piece is phonemized, and the
    // token count is asked of the worker that owns the tokenizer — this is the
    // order the whole split exists to make possible.
    expect(workers.phonemizer.types).toEqual(['init', 'prepare', 'phonemize']);
    expect(workers.kokoro.types).toEqual(['init', 'load', 'count', 'synthesize']);
    expect(workers.kokoro.posted.at(-1)).toMatchObject({
      pieces: [{ ipa: 'ipa:hello' }],
      voiceId: 'af_heart',
      lang: 'en-US',
    });
  });

  it('asks the vocabulary the loaded model declares', async () => {
    // The inventory follows the model, not the language or the text: v1.0 and
    // v1.1-zh produce different characters for the same Chinese sentence.
    const workers = await loaded();

    await workers.engine.synthesize('你好', 'zf_xiaobei', 'zh-CN', new AbortController().signal);

    expect(workers.phonemizer.posted[1]).toMatchObject({ type: 'prepare', vocab: 'kokoro-v1' });
    expect(workers.phonemizer.posted[2]).toMatchObject({
      type: 'phonemize',
      vocab: 'kokoro-v1',
    });
  });

  it('loads a language once, however many sentences need it', async () => {
    // A prefetch and the sentence being listened to run at the same time, so
    // "once" has to hold for two calls that overlap, not only for two in
    // sequence — 8 MB of decompression twice is the whole cost of getting this
    // wrong.
    const workers = await loaded();
    const signal = new AbortController().signal;

    await Promise.all([
      workers.engine.synthesize('one', 'zf_xiaobei', 'zh-CN', signal),
      workers.engine.synthesize('two', 'zf_xiaobei', 'zh-CN', signal),
    ]);

    expect(workers.phonemizer.types.filter((type) => type === 'prepare')).toHaveLength(1);
  });

  it('prepares again after a failure, rather than remembering it', async () => {
    const workers = await loaded();
    let attempts = 0;
    serveAll(workers, {
      phonemizer: {
        prepare: (message) => {
          attempts += 1;
          if (attempts === 1) {
            return {
              type: 'error',
              id: (message as { id: number }).id,
              code: 'model-load-failed',
              message: 'corrupt',
            };
          }
          return { type: 'prepared', id: (message as { id: number }).id };
        },
      },
    });

    const signal = new AbortController().signal;
    await expect(workers.engine.synthesize('你好', 'zf_xiaobei', 'zh-CN', signal)).rejects.toThrow(
      'corrupt'
    );
    expect(workers.phonemizer.types.filter((type) => type === 'prepare')).toHaveLength(1);

    // A missing or corrupt file is worth one more attempt on the next sentence
    // — it may have been a transient read — so the failure must not be
    // remembered as the answer for the life of the document.
    await workers.engine.synthesize('你好', 'zf_xiaobei', 'zh-CN', signal);
    expect(workers.phonemizer.types.filter((type) => type === 'prepare')).toHaveLength(2);
  });

  it('carries the provider code of a failure as the error name', async () => {
    const workers = await loaded();
    serveAll(workers, {
      phonemizer: {
        prepare: (message) => ({
          type: 'error',
          id: (message as { id: number }).id,
          code: 'voice-mismatch',
          message: 'no Japanese here',
        }),
      },
    });

    const error = await workers.engine
      .synthesize('テスト', 'zf_xiaobei', 'ja-JP', new AbortController().signal)
      .catch((e: unknown) => e);

    // The code is what the caller switches on; the message is only for a human.
    expect((error as Error).name).toBe('voice-mismatch');
  });

  it('cuts a sentence that does not fit, then packs it back into one call', async () => {
    const workers = await loaded();
    const counted: string[] = [];
    serveAll(workers, {
      kokoro: {
        count: (message) => {
          const { id, phonemes } = message as { id: number; phonemes: string };
          counted.push(phonemes);
          // The whole sentence is over the cap; each clause is nowhere near it.
          return { type: 'counted', id, tokens: phonemes === 'ipa:a,b' ? 600 : 5 };
        },
      },
    });

    await workers.engine.synthesize('a,b', 'af_heart', 'en-US', new AbortController().signal);

    // Cut at the clause, measured again, then packed back together: two
    // phonemizations and one synthesis, which is what keeps a sentence that
    // *does* fit at exactly one call.
    expect(counted).toEqual(['ipa:a,b', 'ipa:a,', 'ipa:b']);
    expect(workers.kokoro.posted.at(-1)).toMatchObject({
      pieces: [{ ipa: 'ipa:a, ipa:b' }],
    });
  });

  it('abandons the synthesis in the worker when the caller aborts', async () => {
    const workers = await loaded();
    serveAll(workers, { kokoro: { synthesize: () => undefined } });

    const controller = new AbortController();
    const synthesis = workers.engine.synthesize('hello', 'af_heart', 'en-US', controller.signal);
    await tick();
    controller.abort();

    await expect(synthesis).rejects.toThrow();
    // The inference is already running; dropping the reply would leave it
    // occupying the device while the next sentence waits for it.
    expect(workers.kokoro.posted.at(-1)).toEqual({ type: 'cancel', id: 4 });
  });

  it('refuses to synthesize before a model is loaded', async () => {
    // There is no inventory to phonemize into until `load` has named a model,
    // and a guess would be wrong for half the models this build will have.
    const workers = setup();
    serveAll(workers);

    await expect(
      workers.engine.synthesize('hello', 'af_heart', 'en-US', new AbortController().signal)
    ).rejects.toThrow('the model is not loaded');
  });
});
